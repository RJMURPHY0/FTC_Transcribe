// Acoustic voice identification — speaker diarization + voiceprint embeddings.
//
// Runs sherpa-onnx (pyannote segmentation-3.0 + 3D-Speaker CAM++ zh_en advanced)
// on the actual audio waveform, entirely on CPU, no external services:
//   1. Per chunk: diarize "who spoke when" + extract one 192-dim embedding per
//      local speaker (analyzeChunkVoices — called during chunk transcription).
//   2. At finalize: cluster per-chunk speaker embeddings into global speakers
//      and match each cluster against enrolled VoiceProfile rows (cosine).
//   3. Enrollment: embedAudioSample turns a recorded phrase into a profile row.
//
// Every entry point degrades gracefully: any failure returns null and the
// pipeline continues exactly as it did before voice ID existed.

import { spawn } from 'child_process';
import { existsSync, mkdirSync, readdirSync } from 'fs';
import { readFile, writeFile, unlink, rename } from 'fs/promises';
import os from 'os';
import path from 'path';

export interface VoiceTurn { start: number; end: number; speaker: number; embedding?: number[] }
export interface VoiceSpeaker { speaker: number; embedding: number[]; durationS: number }
export interface ChunkVoiceData { turns: VoiceTurn[]; speakers: VoiceSpeaker[]; modelVersion?: string }

// Embedding-model space tag. Voiceprints from different models are NOT
// comparable — a CAM++ profile matched against TitaNet turn embeddings is
// noise that can still cross a cosine threshold by chance. Every stored
// embedding (profiles, speaker embeddings, chunk voiceData) carries this tag,
// and matching only ever happens within one space. Data without a tag
// predates versioning and is 'campplus'.
export const EMB_MODEL_VERSION = 'titanet-large-v1';
export const LEGACY_MODEL_VERSION = 'campplus';

export const isVoiceIdEnabled = process.env.VOICE_ID_ENABLED !== 'false';

// Similarity above which two per-chunk speakers are the same person (same mic/session)
const CLUSTER_THRESHOLD = parseFloat(process.env.VOICE_CLUSTER_THRESHOLD ?? '0.55');
// Similarity above which a global speaker matches an enrolled voice profile
export const MATCH_THRESHOLD = parseFloat(process.env.VOICE_MATCH_THRESHOLD ?? '0.5');
// sherpa fast-clustering threshold within a single chunk. It is DISTANCE-based
// (merge when 1 - cosine < threshold), so smaller = more clusters. We bias
// toward over-splitting: a wrong split heals in the global turn clustering,
// but a wrong merge contaminates voiceprints and is unrecoverable.
const DIARIZE_THRESHOLD = parseFloat(process.env.VOICE_DIARIZE_THRESHOLD ?? '0.5');
// Global turn-level clustering: merge clusters while best linkage sim ≥ this.
// Calibrated for TitaNet-Large on real far-field audio (same-voice turn sims
// p50≈0.55, different-voice p50≈0.31): 0.65 over-splits safely and the
// centroid merge below reunites fragments.
const TURN_CLUSTER_THRESHOLD = parseFloat(process.env.VOICE_TURN_CLUSTER_THRESHOLD ?? '0.65');
// Re-segmentation: move a turn to another cluster when its centroid beats the
// assigned one by at least this margin
const REASSIGN_MARGIN = parseFloat(process.env.VOICE_REASSIGN_MARGIN ?? '0.05');
// Profile supervision: relabel a turn to an enrolled person when that person's
// profile beats the turn's current person by this margin
const PROFILE_MARGIN = parseFloat(process.env.VOICE_PROFILE_MARGIN ?? '0.07');
// Smoothing: a speaker island shorter than this, sandwiched between one other
// speaker, flips to its neighbours unless its own acoustic evidence is strong
const MIN_ISLAND_S = parseFloat(process.env.VOICE_MIN_ISLAND_S ?? '1.2');
// Junk-cluster absorption: real-world far-field audio (laptop mics, Teams
// speakerphone, played-back media) produces turn embeddings whose same-voice
// cosine can sit well below TURN_CLUSTER_THRESHOLD, so blind clustering leaves
// a long tail of tiny fragment clusters — a real 2-person meeting once produced
// 116 "speakers". A cluster only counts as a real participant if it accrues at
// least this much embedded speech; smaller clusters are absorbed into their
// acoustically nearest surviving cluster, or dissolved into temporal context
// when nothing is even vaguely similar (noise, music, crosstalk).
const MIN_SPEAKER_S = parseFloat(process.env.VOICE_MIN_SPEAKER_S ?? '30');
// Fraction of total embedded speech used to scale MIN_SPEAKER_S down for short
// meetings (a 5-minute standup shouldn't demand 30s per speaker).
const MIN_SPEAKER_FRACTION = parseFloat(process.env.VOICE_MIN_SPEAKER_FRACTION ?? '0.015');
// Absorb a junk cluster into its nearest survivor when centroid sim ≥ this;
// below it the fragment is treated as non-speech and dissolved temporally.
const ABSORB_FLOOR = parseFloat(process.env.VOICE_ABSORB_FLOOR ?? '0.2');
// Hard safety cap on distinct speakers a single meeting can produce.
const MAX_SPEAKERS = parseInt(process.env.VOICE_MAX_SPEAKERS ?? '12', 10);
// Final centroid-linkage merge: average linkage over noisy per-turn sims
// under-merges (outliers drag the pairwise average below threshold), so one
// voice can survive as several clusters whose CENTROIDS still agree strongly.
// TitaNet real data: same-voice fragment centroids ≥0.8, hardest
// different-voice pair (two similar UK male voices, same room) 0.775 — 0.8
// keeps them apart while still reuniting genuine fragments.
const CENTROID_MERGE_THRESHOLD = parseFloat(process.env.VOICE_CENTROID_MERGE_THRESHOLD ?? '0.8');
const ISLAND_KEEP_MARGIN = parseFloat(process.env.VOICE_ISLAND_KEEP_MARGIN ?? '0.1');
// Turns shorter than this don't get their own embedding (too noisy to trust)
const MIN_TURN_EMBED_S = parseFloat(process.env.VOICE_MIN_TURN_EMBED_S ?? '1.0');
// Cap the audio used per speaker embedding — CPU cost control
const MAX_EMBED_SECONDS = 25;
const MAX_TURN_EMBED_SECONDS = 15;
const SAMPLE_RATE = 16000;

// Both are direct .onnx downloads — serverless runtimes have no `tar` binary,
// so the GitHub .tar.bz2 release of the segmentation model is unusable there.
const MODELS = {
  segmentation: {
    file: 'pyannote-seg-3.onnx',
    url: 'https://huggingface.co/csukuangfj/sherpa-onnx-pyannote-segmentation-3-0/resolve/main/model.onnx',
  },
  // NeMo TitaNet-Large: on a real 3-person far-field meeting it separated two
  // voices that CAM++ measured as one speaker (cross-centroid 0.87 under
  // CAM++, cleanly apart under TitaNet). Bake-off vs ERes2NetV2 and WeSpeaker
  // ResNet34 on the same audio: TitaNet had the widest same/different-voice
  // margin; the other two collapsed entirely on far-field UK English.
  embedding: {
    file: 'nemo_en_titanet_large.onnx',
    url: 'https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-recongition-models/nemo_en_titanet_large.onnx',
  },
};

// ── sherpa-onnx loader ────────────────────────────────────────────────────────

/* eslint-disable @typescript-eslint/no-explicit-any */
let sherpaModule: any | null | undefined;
let sherpaError: string | null = null;
let modelsError: string | null = null;

function getSherpa(): any | null {
  if (sherpaModule !== undefined) return sherpaModule;
  try {
    if (process.platform === 'win32') {
      // Windows resolves the addon's DLLs via PATH at load time
      const dllDir = path.join(process.cwd(), 'node_modules', 'sherpa-onnx-win-x64');
      if (!(process.env.PATH ?? '').includes(dllDir)) {
        process.env.PATH = `${dllDir};${process.env.PATH}`;
      }
    } else if (process.platform === 'linux') {
      // Preload sherpa's shared libraries with RTLD_GLOBAL so the addon's
      // dependencies resolve WITHOUT LD_LIBRARY_PATH — a global LD_LIBRARY_PATH
      // hijacks library resolution for every native module in the process
      // (it broke Prisma's query engine in prod on 2026-07-15).
      const pkgDir = path.join(process.cwd(), 'node_modules', 'sherpa-onnx-linux-x64');
      if (existsSync(pkgDir)) {
        const flags = os.constants.dlopen.RTLD_NOW | os.constants.dlopen.RTLD_GLOBAL;
        const libs = readdirSync(pkgDir)
          .filter((f) => f.includes('.so'))
          // dependencies first: onnxruntime before the sherpa C API that links it
          .sort((a, b) => (a.includes('onnxruntime') ? -1 : 0) - (b.includes('onnxruntime') ? -1 : 0));
        // Two passes: pass 1 may fail for libs whose deps load later
        for (let pass = 0; pass < 2; pass++) {
          for (const lib of libs) {
            try {
              // process.dlopen throws on plain (non-addon) .so files, but the
              // library itself stays loaded with global symbol visibility.
              process.dlopen({ exports: {} } as unknown as NodeJS.Module, path.join(pkgDir, lib), flags);
            } catch { /* expected for plain shared libraries */ }
          }
        }
      }
    }
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    sherpaModule = require('sherpa-onnx-node');
  } catch (err) {
    sherpaError = err instanceof Error ? err.message : String(err);
    console.warn('[voice-id] sherpa-onnx unavailable — voice ID disabled:', sherpaError);
    sherpaModule = null;
  }
  return sherpaModule;
}

// ── Model files (local dir in dev, downloaded to /tmp in prod) ───────────────

function modelsDir(): string {
  const local = process.env.VOICE_MODELS_DIR ?? path.join(process.cwd(), 'models');
  if (existsSync(path.join(local, MODELS.embedding.file))) return local;
  return path.join(os.tmpdir(), 'voice-models');
}

let modelsReady: Promise<string | null> | null = null;

async function downloadFile(url: string, dest: string): Promise<void> {
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) throw new Error(`model download ${res.status} for ${url}`);
  const buf = Buffer.from(await res.arrayBuffer());
  const tmp = `${dest}.part`;
  await writeFile(tmp, buf);
  await rename(tmp, dest);
}

function ensureModels(): Promise<string | null> {
  if (!modelsReady) {
    modelsReady = (async () => {
      const dir = modelsDir();
      try {
        const segPath = path.join(dir, MODELS.segmentation.file);
        const embPath = path.join(dir, MODELS.embedding.file);
        if (existsSync(segPath) && existsSync(embPath)) return dir;
        mkdirSync(dir, { recursive: true });
        console.log('[voice-id] downloading models to', dir);
        await Promise.all([
          existsSync(embPath) ? Promise.resolve() : downloadFile(MODELS.embedding.url, embPath),
          existsSync(segPath) ? Promise.resolve() : downloadFile(MODELS.segmentation.url, segPath),
        ]);
        return dir;
      } catch (err) {
        modelsError = err instanceof Error ? err.message : String(err);
        console.warn('[voice-id] model download failed — voice ID disabled:', modelsError);
        modelsReady = null; // allow retry on a later invocation
        return null;
      }
    })();
  }
  return modelsReady;
}

// ── Engines (lazy singletons — model load is ~1-2s) ──────────────────────────

let diarizerPromise: Promise<any | null> | null = null;
let extractorPromise: Promise<any | null> | null = null;

function getDiarizer(): Promise<any | null> {
  if (!diarizerPromise) {
    diarizerPromise = (async () => {
      const sherpa = getSherpa();
      const dir = await ensureModels();
      if (!sherpa || !dir) return null;
      try {
        return new sherpa.OfflineSpeakerDiarization({
          segmentation: { pyannote: { model: path.join(dir, MODELS.segmentation.file) }, numThreads: 2 },
          embedding: { model: path.join(dir, MODELS.embedding.file), numThreads: 2 },
          clustering: { numClusters: -1, threshold: DIARIZE_THRESHOLD },
          minDurationOn: 0.3,
          minDurationOff: 0.5,
        });
      } catch (err) {
        console.warn('[voice-id] diarizer init failed:', err instanceof Error ? err.message : err);
        return null;
      }
    })();
  }
  return diarizerPromise;
}

function getExtractor(): Promise<any | null> {
  if (!extractorPromise) {
    extractorPromise = (async () => {
      const sherpa = getSherpa();
      const dir = await ensureModels();
      if (!sherpa || !dir) return null;
      try {
        return new sherpa.SpeakerEmbeddingExtractor({
          model: path.join(dir, MODELS.embedding.file),
          numThreads: 2,
        });
      } catch (err) {
        console.warn('[voice-id] extractor init failed:', err instanceof Error ? err.message : err);
        return null;
      }
    })();
  }
  return extractorPromise;
}

// ── Audio decode: any container/codec → 16 kHz mono Float32 PCM ──────────────

function ffmpegPath(): string | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const p = require('ffmpeg-static') as string | null;
    return p ?? null;
  } catch {
    return null;
  }
}

async function decodeTo16kMono(audio: Buffer, mimeType: string): Promise<Float32Array | null> {
  const ffmpeg = ffmpegPath();
  if (!ffmpeg) {
    console.warn('[voice-id] ffmpeg-static unavailable');
    return null;
  }
  const ext = mimeType.includes('mp4') ? '.mp4'
    : mimeType.includes('ogg') ? '.ogg'
    : mimeType.includes('wav') ? '.wav'
    : mimeType.includes('mpeg') ? '.mp3'
    : mimeType.includes('m4a') ? '.m4a'
    : '.webm';
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const inPath = path.join(os.tmpdir(), `vid-in-${stamp}${ext}`);
  const outPath = path.join(os.tmpdir(), `vid-out-${stamp}.wav`);
  try {
    await writeFile(inPath, audio);
    await new Promise<void>((resolve, reject) => {
      const p = spawn(ffmpeg, [
        '-hide_banner', '-loglevel', 'error', '-nostdin',
        '-i', inPath, '-ac', '1', '-ar', String(SAMPLE_RATE),
        '-acodec', 'pcm_s16le', '-y', outPath,
      ]);
      let errOut = '';
      p.stderr.on('data', (d) => { errOut += d.toString(); });
      p.on('error', reject);
      p.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg ${code}: ${errOut.slice(0, 200)}`))));
    });
    const wav = await readFile(outPath);
    // Parse minimal RIFF: find "data" sub-chunk, read s16le samples
    const dataIdx = wav.indexOf('data');
    if (dataIdx < 0 || dataIdx + 8 >= wav.length) return null;
    const dataLen = wav.readUInt32LE(dataIdx + 4);
    const start = dataIdx + 8;
    const end = Math.min(start + dataLen, wav.length);
    const n = Math.floor((end - start) / 2);
    const samples = new Float32Array(n);
    for (let i = 0; i < n; i++) samples[i] = wav.readInt16LE(start + i * 2) / 32768;
    return samples;
  } catch (err) {
    console.warn('[voice-id] decode failed:', err instanceof Error ? err.message : err);
    return null;
  } finally {
    unlink(inPath).catch(() => {});
    unlink(outPath).catch(() => {});
  }
}

// ── Embedding helpers ─────────────────────────────────────────────────────────

async function computeEmbedding(samples: Float32Array): Promise<number[] | null> {
  const extractor = await getExtractor();
  if (!extractor) return null;
  const stream = extractor.createStream();
  stream.acceptWaveform({ samples, sampleRate: SAMPLE_RATE });
  const emb = extractor.compute(stream) as Float32Array;
  return Array.from(emb, (v) => Math.round(v * 1e5) / 1e5);
}

export function cosineSim(a: number[] | Float32Array, b: number[] | Float32Array): number {
  let dot = 0, na = 0, nb = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

// ── Per-chunk analysis: diarize + one embedding per local speaker ─────────────

export async function analyzeChunkVoices(audio: Buffer, mimeType: string): Promise<ChunkVoiceData | null> {
  if (!isVoiceIdEnabled) return null;
  try {
    const diarizer = await getDiarizer();
    if (!diarizer) return null;
    const samples = await decodeTo16kMono(audio, mimeType);
    if (!samples || samples.length < SAMPLE_RATE) return null; // <1s of audio

    const segs = diarizer.process(samples) as Array<{ start: number; end: number; speaker: number }>;
    if (!segs.length) return null;

    const turns: VoiceTurn[] = segs.map((s) => ({
      start: Math.round(s.start * 100) / 100,
      end: Math.round(s.end * 100) / 100,
      speaker: s.speaker,
    }));

    // Per-turn voiceprints: the global resolver clusters and profile-checks
    // individual turns, so one bad within-chunk cluster can't poison the whole
    // chunk. Short turns stay embedding-less and inherit labels from context.
    for (const t of turns) {
      const dur = t.end - t.start;
      if (dur < MIN_TURN_EMBED_S) continue;
      const s = Math.max(0, Math.floor(t.start * SAMPLE_RATE));
      const e = Math.min(samples.length, Math.floor(Math.min(t.end, t.start + MAX_TURN_EMBED_SECONDS) * SAMPLE_RATE));
      if (e - s < SAMPLE_RATE * MIN_TURN_EMBED_S) continue;
      const emb = await computeEmbedding(samples.subarray(s, e));
      // 4 decimals is plenty for cosine math and halves the stored JSON size
      if (emb) t.embedding = emb.map((v) => Math.round(v * 1e4) / 1e4);
    }

    // Concatenate each speaker's speech (longest turns first, capped) and embed it
    const bySpeaker = new Map<number, Array<{ start: number; end: number }>>();
    for (const t of turns) {
      if (!bySpeaker.has(t.speaker)) bySpeaker.set(t.speaker, []);
      bySpeaker.get(t.speaker)!.push({ start: t.start, end: t.end });
    }

    const speakers: VoiceSpeaker[] = [];
    for (const [speaker, spans] of bySpeaker) {
      const sorted = [...spans].sort((a, b) => (b.end - b.start) - (a.end - a.start));
      const pieces: Float32Array[] = [];
      let secs = 0;
      let totalSecs = 0;
      for (const span of sorted) {
        totalSecs += span.end - span.start;
        if (secs >= MAX_EMBED_SECONDS) continue;
        const s = Math.max(0, Math.floor(span.start * SAMPLE_RATE));
        const e = Math.min(samples.length, Math.floor(span.end * SAMPLE_RATE));
        if (e <= s) continue;
        pieces.push(samples.subarray(s, e));
        secs += (e - s) / SAMPLE_RATE;
      }
      if (secs < 1) continue; // too little speech for a reliable voiceprint
      const joined = new Float32Array(pieces.reduce((n, p) => n + p.length, 0));
      let off = 0;
      for (const p of pieces) { joined.set(p, off); off += p.length; }
      const embedding = await computeEmbedding(joined);
      if (embedding) speakers.push({ speaker, embedding, durationS: Math.round(totalSecs * 10) / 10 });
    }

    if (!speakers.length) return null;
    return { turns, speakers, modelVersion: EMB_MODEL_VERSION };
  } catch (err) {
    console.warn('[voice-id] chunk analysis failed:', err instanceof Error ? err.message : err);
    return null;
  }
}

// ── Enrollment: one phrase recording → one embedding ──────────────────────────

export async function embedAudioSample(
  audio: Buffer,
  mimeType: string,
): Promise<{ embedding: number[]; durationS: number } | null> {
  if (!isVoiceIdEnabled) return null;
  try {
    const samples = await decodeTo16kMono(audio, mimeType);
    if (!samples || samples.length < SAMPLE_RATE * 2) return null; // need ≥2s
    const capped = samples.length > SAMPLE_RATE * 60 ? samples.subarray(0, SAMPLE_RATE * 60) : samples;
    const embedding = await computeEmbedding(capped);
    if (!embedding) return null;
    return { embedding, durationS: Math.round((samples.length / SAMPLE_RATE) * 10) / 10 };
  } catch (err) {
    console.warn('[voice-id] enrollment embed failed:', err instanceof Error ? err.message : err);
    return null;
  }
}

// ── Global speaker resolution across chunks ───────────────────────────────────

export interface ChunkForAlignment {
  offset: number;
  segments: Array<{ start: number; end: number; text: string; speaker?: number | string }>;
  voiceData: ChunkVoiceData | null;
}

export interface ResolvedSpeakers {
  segments: Array<{ start: number; end: number; text: string; speaker: string }>;
  // One entry per global speaker label, for persistence + profile matching
  speakerEmbeddings: Array<{ label: string; embedding: number[]; durationS: number }>;
}

// Average-linkage agglomerative clustering over duration-weighted embeddings.
function clusterEmbeddings(
  items: Array<{ embedding: number[]; durationS: number }>,
  threshold: number,
): number[] {
  const clusters: number[][] = items.map((_, i) => [i]);
  const assignment = items.map((_, i) => i);

  const centroid = (members: number[]): number[] => {
    const dim = items[0].embedding.length;
    const out = new Array(dim).fill(0);
    let w = 0;
    for (const m of members) {
      const wt = Math.max(items[m].durationS, 0.1);
      for (let d = 0; d < dim; d++) out[d] += items[m].embedding[d] * wt;
      w += wt;
    }
    for (let d = 0; d < dim; d++) out[d] /= w;
    return out;
  };

  for (;;) {
    let bestSim = -1, bestA = -1, bestB = -1;
    const active = clusters.map((c, i) => ({ c, i })).filter(x => x.c.length > 0);
    for (let a = 0; a < active.length; a++) {
      for (let b = a + 1; b < active.length; b++) {
        const sim = cosineSim(centroid(active[a].c), centroid(active[b].c));
        if (sim > bestSim) { bestSim = sim; bestA = active[a].i; bestB = active[b].i; }
      }
    }
    if (bestSim < threshold || bestA < 0) break;
    clusters[bestA].push(...clusters[bestB]);
    clusters[bestB] = [];
  }

  let label = 0;
  const clusterLabel = new Map<number, number>();
  for (let i = 0; i < clusters.length; i++) {
    if (clusters[i].length === 0) continue;
    clusterLabel.set(i, label++);
    for (const m of clusters[i]) assignment[m] = i;
  }
  return assignment.map((c) => clusterLabel.get(c)!);
}

// Assign each transcript segment the diarized speaker with the largest time overlap.
function speakerForSegment(seg: { start: number; end: number }, turns: VoiceTurn[]): number | null {
  let best: number | null = null;
  let bestOverlap = 0;
  for (const t of turns) {
    const overlap = Math.min(seg.end, t.end) - Math.max(seg.start, t.start);
    if (overlap > bestOverlap) { bestOverlap = overlap; best = t.speaker; }
  }
  return bestOverlap > 0 ? best : null;
}

// ── Turn-level resolver ───────────────────────────────────────────────────────
//
// A "turn" is one diarized span inside one chunk. The resolver:
//   1. clusters ALL turn embeddings across the recording (average linkage),
//   2. re-assigns turns whose embedding clearly prefers another cluster,
//   3. when enrolled profiles identify ≥2 clusters as different people,
//      re-checks every turn directly against those people's voiceprints,
//   4. smooths away sub-second speaker islands with weak acoustic evidence,
//   5. labels transcript segments from the smoothed global timeline.
// Legacy voiceData (no per-turn embeddings) falls back to the original
// per-chunk-speaker clustering below.

interface GlobalTurn {
  start: number;          // recording-global seconds
  end: number;
  chunkIdx: number;       // index into withVoice
  localSpeaker: number;
  embedding: number[] | null;
  cluster: number;        // mutable: current global cluster id
}

function normalizeVec(v: number[]): number[] {
  let n = 0;
  for (const x of v) n += x * x;
  n = Math.sqrt(n) || 1;
  return v.map((x) => x / n);
}

// Duration-weighted average-linkage clustering over a precomputed sim matrix
// (Lance-Williams update). O(n²) total — fine for a few thousand turns.
function clusterTurns(turns: GlobalTurn[], threshold: number): void {
  const embedded = turns.filter((t) => t.embedding);
  const n = embedded.length;
  if (!n) return;
  const norm = embedded.map((t) => normalizeVec(t.embedding!));
  const weight = embedded.map((t) => Math.max(t.end - t.start, 0.1));

  const sim = new Float64Array(n * n);
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      let d = 0;
      for (let k = 0; k < norm[i].length; k++) d += norm[i][k] * norm[j][k];
      sim[i * n + j] = d; sim[j * n + i] = d;
    }
  }

  const alive = new Array(n).fill(true);
  const w = [...weight];
  const members: number[][] = embedded.map((_, i) => [i]);

  for (;;) {
    let bestSim = -1, a = -1, b = -1;
    for (let i = 0; i < n; i++) {
      if (!alive[i]) continue;
      for (let j = i + 1; j < n; j++) {
        if (!alive[j]) continue;
        const s = sim[i * n + j];
        if (s > bestSim) { bestSim = s; a = i; b = j; }
      }
    }
    if (bestSim < threshold || a < 0) break;
    // merge b into a; weighted average linkage to every other cluster
    for (let k = 0; k < n; k++) {
      if (!alive[k] || k === a || k === b) continue;
      const s = (w[a] * sim[a * n + k] + w[b] * sim[b * n + k]) / (w[a] + w[b]);
      sim[a * n + k] = s; sim[k * n + a] = s;
    }
    w[a] += w[b];
    members[a].push(...members[b]);
    alive[b] = false;
  }

  let label = 0;
  for (let i = 0; i < n; i++) {
    if (!alive[i]) continue;
    for (const m of members[i]) embedded[m].cluster = label;
    label++;
  }
}

// Duration-weighted, normalized centroid of a cluster's embedded turns.
function clusterCentroids(turns: GlobalTurn[]): Map<number, number[]> {
  const acc = new Map<number, { v: number[]; w: number }>();
  for (const t of turns) {
    if (!t.embedding || t.cluster < 0) continue;
    const wt = Math.max(t.end - t.start, 0.1);
    const norm = normalizeVec(t.embedding);
    const cur = acc.get(t.cluster);
    if (!cur) {
      acc.set(t.cluster, { v: norm.map((x) => x * wt), w: wt });
    } else {
      for (let d = 0; d < norm.length; d++) cur.v[d] += norm[d] * wt;
      cur.w += wt;
    }
  }
  const out = new Map<number, number[]>();
  for (const [c, { v, w }] of acc) out.set(c, v.map((x) => x / w));
  return out;
}

export function resolveGlobalSpeakers(
  chunks: ChunkForAlignment[],
  rawProfiles: ProfileRow[] = [],
): ResolvedSpeakers | null {
  const withVoice = chunks.filter((c) => c.voiceData && c.voiceData.speakers.length > 0);
  if (!withVoice.length) return null;

  // Poison control: drop learned samples that no longer resemble the person's
  // human-verified voice before anything downstream can trust them.
  const screened = rawProfiles.length ? screenProfiles(rawProfiles) : null;
  const profiles = screened?.profiles ?? [];

  // Flatten every diarized turn into a global timeline
  const globalTurns: GlobalTurn[] = [];
  withVoice.forEach((chunk, ci) => {
    for (const t of chunk.voiceData!.turns) {
      globalTurns.push({
        start: chunk.offset + t.start,
        end: chunk.offset + t.end,
        chunkIdx: ci,
        localSpeaker: t.speaker,
        embedding: t.embedding ?? null,
        cluster: -1,
      });
    }
  });
  globalTurns.sort((x, y) => x.start - y.start);

  const embeddedCount = globalTurns.filter((t) => t.embedding).length;
  // Legacy recordings (no per-turn embeddings) use the original resolver
  if (embeddedCount < 2) return resolveGlobalSpeakersLegacy(chunks);

  // 1. Global clustering over turn voiceprints
  clusterTurns(globalTurns, TURN_CLUSTER_THRESHOLD);

  // 2. Re-segmentation: a turn that clearly prefers another cluster moves there
  let centroids = clusterCentroids(globalTurns);
  if (centroids.size > 1) {
    for (const t of globalTurns) {
      if (!t.embedding) continue;
      const norm = normalizeVec(t.embedding);
      let bestC = t.cluster, bestS = -1, ownS = -1;
      for (const [c, cent] of centroids) {
        const s = cosineSim(norm, cent);
        if (c === t.cluster) ownS = s;
        if (s > bestS) { bestS = s; bestC = c; }
      }
      if (bestC !== t.cluster && bestS - ownS > REASSIGN_MARGIN) t.cluster = bestC;
    }
    centroids = clusterCentroids(globalTurns);
  }

  // 3. Profile supervision: every embedded turn is checked directly against
  // enrolled voiceprints. Confident matches are HARD-assigned to that person's
  // own cluster — this beats blind clustering whenever the meeting's voices are
  // enrolled, and it's what stops "labeled as the other person mid-sentence".
  // Turns that don't clear the bar keep their unsupervised cluster; if a whole
  // cluster belongs to one person anyway, centroid matching names it later.
  const protectedClusters = new Set<number>();
  if (profiles.length) {
    const byPerson = new Map<string, number[][]>();
    for (const p of profiles) {
      if (!byPerson.has(p.personName)) byPerson.set(p.personName, []);
      byPerson.get(p.personName)!.push(normalizeVec(p.embedding));
    }
    const personSim = (v: number[]): Array<{ name: string; sim: number }> =>
      [...byPerson.entries()]
        .map(([name, embs]) => ({ name, sim: Math.max(...embs.map((e) => cosineSim(v, e))) }))
        .sort((x, y) => y.sim - x.sim);

    let nextCluster = Math.max(0, ...centroids.keys()) + 1;
    const personCluster = new Map<string, number>();
    for (const name of byPerson.keys()) personCluster.set(name, nextCluster++);

    let assigned = 0;
    for (const t of globalTurns) {
      if (!t.embedding) continue;
      const ranked = personSim(normalizeVec(t.embedding));
      if (!ranked.length) continue;
      const top = ranked[0];
      const margin = ranked.length > 1 ? top.sim - ranked[1].sim : Infinity;
      // With a single enrolled person there is no margin signal, so raise the bar
      const bar = ranked.length > 1 ? MATCH_THRESHOLD : MATCH_THRESHOLD + PROFILE_MARGIN;
      if (top.sim >= bar && margin >= PROFILE_MARGIN) {
        t.cluster = personCluster.get(top.name)!;
        protectedClusters.add(t.cluster);
        assigned++;
      }
    }
    if (assigned) centroids = clusterCentroids(globalTurns);
  }

  // 3.5. Junk-cluster absorption. A participant is a cluster with a real amount
  // of embedded speech; everything smaller is a fragment of an existing voice
  // (absorbed into its acoustically nearest survivor) or non-speech noise
  // (dissolved — its turns fall back to temporal continuity in step 4a).
  // Profile-supervised clusters are never dissolved: an enrolled person who
  // says one sentence is still that person.
  {
    const clusterDur = new Map<number, number>();
    for (const t of globalTurns) {
      if (!t.embedding || t.cluster < 0) continue;
      clusterDur.set(t.cluster, (clusterDur.get(t.cluster) ?? 0) + (t.end - t.start));
    }
    const totalSpeech = [...clusterDur.values()].reduce((a, b) => a + b, 0);
    const minSpeakerS = Math.min(MIN_SPEAKER_S, Math.max(6, totalSpeech * MIN_SPEAKER_FRACTION));

    const reassign = (from: number, to: number) => {
      for (const t of globalTurns) if (t.cluster === from) t.cluster = to;
      if (to >= 0) clusterDur.set(to, (clusterDur.get(to) ?? 0) + (clusterDur.get(from) ?? 0));
      clusterDur.delete(from);
    };

    // Smallest first, so fragments merge into genuinely dominant voices
    for (;;) {
      centroids = clusterCentroids(globalTurns);
      const junk = [...clusterDur.entries()]
        .filter(([c, d]) => d < minSpeakerS && !protectedClusters.has(c))
        .sort((a, b) => a[1] - b[1]);
      if (!junk.length || clusterDur.size <= 1) break;
      const [c] = junk[0];
      const own = centroids.get(c);
      let bestC = -1, bestS = -1;
      for (const [other, cent] of centroids) {
        if (other === c || !own) continue;
        const s = cosineSim(own, cent);
        if (s > bestS) { bestS = s; bestC = other; }
      }
      // Nothing even vaguely similar → noise/media, dissolve into context
      reassign(c, bestS >= ABSORB_FLOOR ? bestC : -1);
    }

    // Hard cap: force-merge the smallest remaining clusters into their nearest
    // neighbour until under the ceiling (safety net, rarely triggered).
    for (;;) {
      if (clusterDur.size <= MAX_SPEAKERS) break;
      centroids = clusterCentroids(globalTurns);
      const smallest = [...clusterDur.entries()]
        .filter(([c]) => !protectedClusters.has(c))
        .sort((a, b) => a[1] - b[1])[0];
      if (!smallest) break;
      const own = centroids.get(smallest[0]);
      let bestC = -1, bestS = -1;
      for (const [other, cent] of centroids) {
        if (other === smallest[0] || !own) continue;
        const s = cosineSim(own, cent);
        if (s > bestS) { bestS = s; bestC = other; }
      }
      if (bestC < 0) break;
      reassign(smallest[0], bestC);
    }

    // Centroid merge: reunite one voice that average linkage left split.
    // Two profile-supervised clusters are two verified identities — never
    // merged here, whatever their similarity.
    for (;;) {
      centroids = clusterCentroids(globalTurns);
      const ids = [...centroids.keys()];
      let bestA = -1, bestB = -1, bestS = -1;
      for (let i = 0; i < ids.length; i++) {
        for (let j = i + 1; j < ids.length; j++) {
          if (protectedClusters.has(ids[i]) && protectedClusters.has(ids[j])) continue;
          const s = cosineSim(centroids.get(ids[i])!, centroids.get(ids[j])!);
          if (s > bestS) { bestS = s; bestA = ids[i]; bestB = ids[j]; }
        }
      }
      if (bestS < CENTROID_MERGE_THRESHOLD || bestA < 0) break;
      const keep = protectedClusters.has(bestB) ? bestB
        : protectedClusters.has(bestA) ? bestA
        : (clusterDur.get(bestA) ?? 0) >= (clusterDur.get(bestB) ?? 0) ? bestA : bestB;
      reassign(keep === bestA ? bestB : bestA, keep);
    }
    centroids = clusterCentroids(globalTurns);

    // Identity merge: two surviving clusters whose centroids both confidently
    // match the SAME enrolled person are one voice split by recording
    // conditions — merge them so a person never appears as two speakers.
    // Corroborated against the person's anchor centroid so a merely-similar
    // stranger can't be pulled into an enrolled identity.
    if (profiles.length && centroids.size > 1) {
      const bestPerson = new Map<number, { name: string; sim: number }>();
      for (const [c, cent] of centroids) {
        let name = '', sim = -1;
        for (const p of profiles) {
          const s = cosineSim(cent, p.embedding);
          if (s > sim) { sim = s; name = p.personName; }
        }
        const anchor = name ? screened?.anchors.get(name) : undefined;
        const anchorOk = !anchor || cosineSim(cent, anchor) >= ANCHOR_NAME_MIN;
        if (sim >= MATCH_THRESHOLD && anchorOk) bestPerson.set(c, { name, sim });
      }
      const byName = new Map<string, number[]>();
      for (const [c, { name }] of bestPerson) {
        if (!byName.has(name)) byName.set(name, []);
        byName.get(name)!.push(c);
      }
      for (const clusterIds of byName.values()) {
        if (clusterIds.length < 2) continue;
        const keep = clusterIds
          .map((c) => [c, clusterDur.get(c) ?? 0] as const)
          .sort((a, b) => b[1] - a[1])[0][0];
        for (const c of clusterIds) {
          if (c !== keep) reassign(c, keep);
          if (protectedClusters.has(c)) protectedClusters.add(keep);
        }
      }
      centroids = clusterCentroids(globalTurns);
    }

    // Post-absorption resegmentation: with the junk gone, some turns sit closer
    // to another surviving centroid than the one they inherited — same margin
    // rule as step 2, now over the final speaker set.
    if (centroids.size > 1) {
      for (const t of globalTurns) {
        if (!t.embedding || t.cluster < 0) continue;
        const norm = normalizeVec(t.embedding);
        let bestC = t.cluster, bestS = -1, ownS = -1;
        for (const [c, cent] of centroids) {
          const s = cosineSim(norm, cent);
          if (c === t.cluster) ownS = s;
          if (s > bestS) { bestS = s; bestC = c; }
        }
        if (bestC !== t.cluster && bestS - ownS > REASSIGN_MARGIN) t.cluster = bestC;
      }
      centroids = clusterCentroids(globalTurns);
    }
  }

  // 4a. Non-embedded turns inherit the dominant cluster of their chunk-local
  // speaker; failing that, temporal continuity fills them in.
  const localDominant = new Map<string, number>(); // `${chunkIdx}:${localSpeaker}` → cluster
  {
    const tally = new Map<string, Map<number, number>>();
    for (const t of globalTurns) {
      if (!t.embedding || t.cluster < 0) continue;
      const key = `${t.chunkIdx}:${t.localSpeaker}`;
      if (!tally.has(key)) tally.set(key, new Map());
      const m = tally.get(key)!;
      m.set(t.cluster, (m.get(t.cluster) ?? 0) + (t.end - t.start));
    }
    for (const [key, m] of tally) {
      let best = -1, bestW = -1;
      for (const [c, wt] of m) if (wt > bestW) { bestW = wt; best = c; }
      localDominant.set(key, best);
    }
  }
  let prevCluster = -1;
  for (const t of globalTurns) {
    if (t.cluster < 0) {
      const dom = localDominant.get(`${t.chunkIdx}:${t.localSpeaker}`);
      t.cluster = dom !== undefined ? dom : prevCluster;
    }
    if (t.cluster >= 0) prevCluster = t.cluster;
  }
  // Anything still unassigned (e.g. leading turns before any evidence)
  for (const t of globalTurns) if (t.cluster < 0) t.cluster = prevCluster >= 0 ? prevCluster : 0;

  // 4b. Island smoothing: a short turn sandwiched inside CONTINUOUS speech of
  // one other speaker is a diarizer flicker → flip it, unless its voiceprint
  // strongly backs the odd label. Standalone short turns with silence around
  // them ("yeah", "hold on") are legitimate interjections and stay untouched.
  for (let i = 1; i < globalTurns.length - 1; i++) {
    const t = globalTurns[i];
    const prev = globalTurns[i - 1], next = globalTurns[i + 1];
    if (t.end - t.start >= MIN_ISLAND_S) continue;
    if (prev.cluster !== next.cluster || prev.cluster === t.cluster) continue;
    const contiguous = (t.start - prev.end) < 0.25 && (next.start - t.end) < 0.25;
    if (!contiguous) continue;
    if (t.embedding && centroids.size > 1) {
      const norm = normalizeVec(t.embedding);
      const own = centroids.get(t.cluster);
      const neighbour = centroids.get(prev.cluster);
      if (own && neighbour && cosineSim(norm, own) - cosineSim(norm, neighbour) > ISLAND_KEEP_MARGIN) continue;
    }
    t.cluster = prev.cluster;
  }

  // 5. Order labels by first appearance, then label transcript segments from
  // the smoothed global timeline.
  const firstAppearance = new Map<number, number>();
  for (const t of globalTurns) {
    if (!firstAppearance.has(t.cluster)) firstAppearance.set(t.cluster, t.start);
  }
  const ordered = [...firstAppearance.entries()].sort((a, b) => a[1] - b[1]).map(([c]) => c);
  const labelOf = new Map<number, string>();
  ordered.forEach((c, i) => labelOf.set(c, `Speaker ${i + 1}`));

  // A transcript segment that genuinely spans a speaker change (ASR bridged
  // the turn boundary) is SPLIT at the boundary, with its words apportioned by
  // time — one label per segment was a major source of wrong mid-sentence
  // attribution. Segments inside a single turn keep the fast path.
  const MIN_SPLIT_SIDE_S = parseFloat(process.env.VOICE_MIN_SPLIT_SIDE_S ?? '0.5');
  const outSegments: ResolvedSpeakers['segments'] = [];
  let lastLabel = '';
  for (const chunk of chunks) {
    const sorted = [...chunk.segments].sort((a, b) => a.start - b.start);
    for (const seg of sorted) {
      const gStart = seg.start + chunk.offset;
      const gEnd = seg.end + chunk.offset;

      // Clip overlapping turns to the segment, merge adjacent same-cluster runs
      const runs: Array<{ start: number; end: number; cluster: number }> = [];
      for (const t of globalTurns) {
        if (t.end <= gStart) continue;
        if (t.start >= gEnd) break;
        const s = Math.max(gStart, t.start);
        const e = Math.min(gEnd, t.end);
        if (e - s <= 0) continue;
        const last = runs[runs.length - 1];
        if (last && last.cluster === t.cluster) last.end = e;
        else runs.push({ start: s, end: e, cluster: t.cluster });
      }

      const emit = (start: number, end: number, text: string, cluster: number | null) => {
        const label = cluster !== null ? labelOf.get(cluster) ?? null : null;
        const speaker = label ?? (lastLabel || 'Speaker 1');
        outSegments.push({
          start: Math.round(start * 100) / 100,
          end: Math.round(end * 100) / 100,
          text,
          speaker,
        });
        lastLabel = speaker;
      };

      const substantial = runs.filter((r) => r.end - r.start >= MIN_SPLIT_SIDE_S);
      const words = seg.text.trim().split(/\s+/).filter(Boolean);
      if (substantial.length >= 2 && words.length >= 2) {
        // Split words across the substantial runs proportionally by duration
        const total = substantial.reduce((n, r) => n + (r.end - r.start), 0);
        let used = 0;
        for (let ri = 0; ri < substantial.length; ri++) {
          const r = substantial[ri];
          const isLast = ri === substantial.length - 1;
          let take = isLast
            ? words.length - used
            : Math.round((words.length * (r.end - r.start)) / total);
          take = Math.max(1, Math.min(take, words.length - used - (isLast ? 0 : substantial.length - 1 - ri)));
          if (take <= 0) continue;
          const text = words.slice(used, used + take).join(' ');
          used += take;
          // First/last pieces stretch to the segment edges so no time is lost
          const start = ri === 0 ? gStart : r.start;
          const end = isLast ? gEnd : r.end;
          emit(start, end, text, r.cluster);
        }
      } else {
        // Dominant-overlap single label
        let best: number | null = null;
        let bestOverlap = 0;
        for (const r of runs) {
          const d = r.end - r.start;
          if (d > bestOverlap) { bestOverlap = d; best = r.cluster; }
        }
        emit(gStart, gEnd, seg.text, best);
      }
    }
  }

  // Per-label centroid + total duration for persistence and profile matching
  const speakerEmbeddings: ResolvedSpeakers['speakerEmbeddings'] = [];
  for (const [c, cent] of centroids) {
    const label = labelOf.get(c);
    if (!label) continue;
    let dur = 0;
    for (const t of globalTurns) if (t.cluster === c) dur += t.end - t.start;
    speakerEmbeddings.push({
      label,
      embedding: cent.map((v) => Math.round(v * 1e5) / 1e5),
      durationS: Math.round(dur * 10) / 10,
    });
  }
  // Clusters that ended up with no embedded turns (pure inheritance) still need
  // a label entry for downstream persistence — reuse the nearest centroid? No:
  // they have no voiceprint, so they are legitimately absent from matching.

  return { segments: outSegments, speakerEmbeddings };
}

function resolveGlobalSpeakersLegacy(chunks: ChunkForAlignment[]): ResolvedSpeakers | null {
  const withVoice = chunks.filter((c) => c.voiceData && c.voiceData.speakers.length > 0);
  if (!withVoice.length) return null;

  // Flatten (chunk, localSpeaker) → item index
  const items: Array<{ embedding: number[]; durationS: number }> = [];
  const itemKey = new Map<string, number>(); // `${chunkIdx}:${localSpeaker}` → item idx
  withVoice.forEach((chunk, ci) => {
    for (const sp of chunk.voiceData!.speakers) {
      itemKey.set(`${ci}:${sp.speaker}`, items.length);
      items.push({ embedding: sp.embedding, durationS: sp.durationS });
    }
  });

  const clusterOf = clusterEmbeddings(items, CLUSTER_THRESHOLD);

  // Order global labels by first appearance in time
  const firstAppearance = new Map<number, number>();
  withVoice.forEach((chunk, ci) => {
    for (const t of chunk.voiceData!.turns) {
      const idx = itemKey.get(`${ci}:${t.speaker}`);
      if (idx === undefined) continue;
      const cluster = clusterOf[idx];
      const at = chunk.offset + t.start;
      if (!firstAppearance.has(cluster) || at < firstAppearance.get(cluster)!) {
        firstAppearance.set(cluster, at);
      }
    }
  });
  const ordered = [...firstAppearance.entries()].sort((a, b) => a[1] - b[1]).map(([c]) => c);
  const labelOf = new Map<number, string>();
  ordered.forEach((c, i) => labelOf.set(c, `Speaker ${i + 1}`));

  // Label transcript segments chunk by chunk
  const outSegments: ResolvedSpeakers['segments'] = [];
  let lastLabel = '';
  for (const chunk of chunks) {
    const ci = withVoice.indexOf(chunk);
    const sorted = [...chunk.segments].sort((a, b) => a.start - b.start);
    for (const seg of sorted) {
      let label: string | null = null;
      if (ci >= 0) {
        const local = speakerForSegment(seg, chunk.voiceData!.turns);
        if (local !== null) {
          const idx = itemKey.get(`${ci}:${local}`);
          if (idx !== undefined) label = labelOf.get(clusterOf[idx]) ?? null;
        }
      }
      // Segments with no acoustic match (silence-skipped chunks, tiny fragments)
      // inherit the previous speaker — same continuity rule the app used before.
      const speaker = label ?? (lastLabel || 'Speaker 1');
      outSegments.push({
        start: seg.start + chunk.offset,
        end: seg.end + chunk.offset,
        text: seg.text,
        speaker,
      });
      lastLabel = speaker;
    }
  }

  // Duration-weighted centroid per global label, for matching + persistence
  const byCluster = new Map<number, Array<{ embedding: number[]; durationS: number }>>();
  clusterOf.forEach((cluster, idx) => {
    if (!byCluster.has(cluster)) byCluster.set(cluster, []);
    byCluster.get(cluster)!.push(items[idx]);
  });
  const speakerEmbeddings: ResolvedSpeakers['speakerEmbeddings'] = [];
  for (const [cluster, members] of byCluster) {
    const label = labelOf.get(cluster);
    if (!label) continue;
    const dim = members[0].embedding.length;
    const centroid = new Array(dim).fill(0);
    let w = 0, dur = 0;
    for (const m of members) {
      const wt = Math.max(m.durationS, 0.1);
      for (let d = 0; d < dim; d++) centroid[d] += m.embedding[d] * wt;
      w += wt;
      dur += m.durationS;
    }
    for (let d = 0; d < dim; d++) centroid[d] = Math.round((centroid[d] / w) * 1e5) / 1e5;
    speakerEmbeddings.push({ label, embedding: centroid, durationS: Math.round(dur * 10) / 10 });
  }

  return { segments: outSegments, speakerEmbeddings };
}

// ── Runtime probe (used by /api/health?voice=1) ───────────────────────────────

export async function probeVoiceId(): Promise<{ ok: boolean; dim?: number; error?: string; diag?: Record<string, unknown> }> {
  const diag: Record<string, unknown> = {
    platform: process.platform,
    cwd: process.cwd(),
    nodePkg: existsSync(path.join(process.cwd(), 'node_modules', 'sherpa-onnx-node')),
    platformPkg: existsSync(path.join(
      process.cwd(), 'node_modules',
      process.platform === 'win32' ? 'sherpa-onnx-win-x64' : 'sherpa-onnx-linux-x64',
    )),
    modelsDir: modelsDir(),
  };
  try {
    const extractor = await getExtractor();
    if (!extractor) {
      diag.sherpaError = sherpaError;
      diag.modelsError = modelsError;
      return { ok: false, error: 'extractor unavailable', diag };
    }
    return { ok: true, dim: extractor.dim as number };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err), diag };
  }
}

// ── Profile matching ──────────────────────────────────────────────────────────

export interface ProfileRow { personName: string; embedding: number[]; source?: string }

// Sources a human explicitly verified: reading enrolment phrases, or renaming
// a speaker by hand. Auto-learned ('match'/'auto') samples are useful for
// matching but must never be trusted on their own — one misattributed meeting
// once poisoned a profile with 19 minutes of someone else's voice, after which
// every later meeting matched the impostor at 0.99.
const ANCHOR_SOURCES = new Set(['enrollment', 'relabel']);
// A learned sample is kept for matching only if it still resembles the
// person's anchor centroid at least this much.
const SAMPLE_CONSISTENCY_MIN = parseFloat(process.env.VOICE_SAMPLE_CONSISTENCY_MIN ?? '0.6');
// Naming a cluster after a person additionally requires the cluster to
// resemble the person's ANCHOR centroid — a bar the real contamination case
// fails (impostor ≈0.48 vs anchors) and genuine matches clear (0.65–0.83).
export const ANCHOR_NAME_MIN = parseFloat(process.env.VOICE_ANCHOR_NAME_MIN ?? '0.55');

export interface ScreenedProfiles {
  profiles: ProfileRow[];               // anchor + consistent learned samples
  anchors: Map<string, number[]>;       // person → anchor centroid (or all-sample centroid when no anchors exist)
  hasAnchors: Set<string>;              // persons with at least one human-verified sample
}

// Screen learned samples against each person's human-verified anchors and
// precompute the per-person anchor centroid used to corroborate naming.
// Rows without a source (older callers, test harness) count as anchors.
export function screenProfiles(rows: ProfileRow[]): ScreenedProfiles {
  const byPerson = new Map<string, ProfileRow[]>();
  for (const r of rows) {
    if (!byPerson.has(r.personName)) byPerson.set(r.personName, []);
    byPerson.get(r.personName)!.push(r);
  }
  const centroidOf = (vecs: number[][]): number[] => {
    const out = new Array(vecs[0].length).fill(0);
    for (const v of vecs) {
      const n = normalizeVec(v);
      for (let i = 0; i < n.length; i++) out[i] += n[i];
    }
    return out.map((x) => x / vecs.length);
  };
  const profiles: ProfileRow[] = [];
  const anchors = new Map<string, number[]>();
  const hasAnchors = new Set<string>();
  for (const [name, samples] of byPerson) {
    const anchor = samples.filter((s) => s.source === undefined || ANCHOR_SOURCES.has(s.source));
    if (anchor.length) {
      const cent = centroidOf(anchor.map((s) => s.embedding));
      anchors.set(name, cent);
      hasAnchors.add(name);
      profiles.push(...anchor);
      for (const s of samples) {
        if (anchor.includes(s)) continue;
        if (cosineSim(normalizeVec(s.embedding), cent) >= SAMPLE_CONSISTENCY_MIN) profiles.push(s);
        else console.warn(`[voice-id] screened out inconsistent learned sample for ${name}`);
      }
    } else {
      // Pure auto-learned person (self-intro path): nothing verified to screen
      // against, so keep everything and anchor on the joint centroid.
      anchors.set(name, centroidOf(samples.map((s) => s.embedding)));
      profiles.push(...samples);
    }
  }
  return { profiles, anchors, hasAnchors };
}

// Returns map of "Speaker N" → enrolled person name for matches above threshold.
export function matchProfiles(
  speakerEmbeddings: ResolvedSpeakers['speakerEmbeddings'],
  profiles: ProfileRow[],
): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [label, m] of Object.entries(matchProfilesDetailed(speakerEmbeddings, profiles))) {
    result[label] = m.name;
  }
  return result;
}

// Like matchProfiles but keeps the winning similarity — callers use it to decide
// whether a match is confident enough to learn from. Naming requires BOTH a
// best-sample match ≥ MATCH_THRESHOLD and corroboration against the person's
// anchor (human-verified) centroid — the second bar is what stops a similar
// stranger being named as an enrolled person and then poisoning their profile
// through the learning loop.
export function matchProfilesDetailed(
  speakerEmbeddings: ResolvedSpeakers['speakerEmbeddings'],
  rawProfiles: ProfileRow[],
): Record<string, { name: string; sim: number }> {
  const result: Record<string, { name: string; sim: number }> = {};
  if (!rawProfiles.length) return result;
  const { profiles, anchors } = screenProfiles(rawProfiles);
  for (const sp of speakerEmbeddings) {
    let bestName: string | null = null;
    let bestSim = MATCH_THRESHOLD;
    for (const p of profiles) {
      const sim = cosineSim(sp.embedding, p.embedding);
      if (sim >= bestSim) { bestSim = sim; bestName = p.personName; }
    }
    if (!bestName) continue;
    const anchor = anchors.get(bestName);
    if (anchor && cosineSim(sp.embedding, anchor) < ANCHOR_NAME_MIN) {
      console.warn(`[voice-id] refused to name ${sp.label} as ${bestName}: sample sim ${bestSim.toFixed(2)} but anchor sim below ${ANCHOR_NAME_MIN}`);
      continue;
    }
    result[sp.label] = { name: bestName, sim: bestSim };
  }
  return result;
}
