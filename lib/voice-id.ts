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

export interface VoiceTurn { start: number; end: number; speaker: number }
export interface VoiceSpeaker { speaker: number; embedding: number[]; durationS: number }
export interface ChunkVoiceData { turns: VoiceTurn[]; speakers: VoiceSpeaker[] }

export const isVoiceIdEnabled = process.env.VOICE_ID_ENABLED !== 'false';

// Similarity above which two per-chunk speakers are the same person (same mic/session)
const CLUSTER_THRESHOLD = parseFloat(process.env.VOICE_CLUSTER_THRESHOLD ?? '0.55');
// Similarity above which a global speaker matches an enrolled voice profile
export const MATCH_THRESHOLD = parseFloat(process.env.VOICE_MATCH_THRESHOLD ?? '0.5');
// Diarization clustering threshold (within a single chunk)
const DIARIZE_THRESHOLD = 0.7;
// Cap the audio used per speaker embedding — CPU cost control
const MAX_EMBED_SECONDS = 25;
const SAMPLE_RATE = 16000;

const MODEL_BASE = 'https://github.com/k2-fsa/sherpa-onnx/releases/download';
const MODELS = {
  segmentation: {
    file: 'pyannote-seg-3.onnx',
    url: `${MODEL_BASE}/speaker-segmentation-models/sherpa-onnx-pyannote-segmentation-3-0.tar.bz2`,
    tarEntry: 'sherpa-onnx-pyannote-segmentation-3-0/model.onnx',
  },
  embedding: {
    file: 'campplus_zh_en.onnx',
    url: `${MODEL_BASE}/speaker-recongition-models/3dspeaker_speech_campplus_sv_zh_en_16k-common_advanced.onnx`,
    tarEntry: null,
  },
};

// ── sherpa-onnx loader ────────────────────────────────────────────────────────

/* eslint-disable @typescript-eslint/no-explicit-any */
let sherpaModule: any | null | undefined;

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
    console.warn('[voice-id] sherpa-onnx unavailable — voice ID disabled:', err instanceof Error ? err.message : err);
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

async function extractTarBz2Entry(url: string, entry: string, dest: string): Promise<void> {
  const tarPath = `${dest}.tar.bz2`;
  await downloadFile(url, tarPath);
  const dir = path.dirname(dest);
  // bsdtar ships on Vercel's runtime image and on Windows 10+
  await new Promise<void>((resolve, reject) => {
    const p = spawn('tar', ['xjf', tarPath, '-C', dir, entry]);
    p.on('error', reject);
    p.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`tar exited ${code}`))));
  });
  await rename(path.join(dir, entry), dest);
  await unlink(tarPath).catch(() => {});
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
          existsSync(segPath)
            ? Promise.resolve()
            : extractTarBz2Entry(MODELS.segmentation.url, MODELS.segmentation.tarEntry!, segPath),
        ]);
        return dir;
      } catch (err) {
        console.warn('[voice-id] model download failed — voice ID disabled:', err instanceof Error ? err.message : err);
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
    return { turns, speakers };
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

export function resolveGlobalSpeakers(chunks: ChunkForAlignment[]): ResolvedSpeakers | null {
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

export async function probeVoiceId(): Promise<{ ok: boolean; dim?: number; error?: string }> {
  try {
    const extractor = await getExtractor();
    if (!extractor) return { ok: false, error: 'extractor unavailable (addon or model load failed — see logs)' };
    return { ok: true, dim: extractor.dim as number };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

// ── Profile matching ──────────────────────────────────────────────────────────

export interface ProfileRow { personName: string; embedding: number[] }

// Returns map of "Speaker N" → enrolled person name for matches above threshold.
export function matchProfiles(
  speakerEmbeddings: ResolvedSpeakers['speakerEmbeddings'],
  profiles: ProfileRow[],
): Record<string, string> {
  const result: Record<string, string> = {};
  if (!profiles.length) return result;
  for (const sp of speakerEmbeddings) {
    let bestName: string | null = null;
    let bestSim = MATCH_THRESHOLD;
    for (const p of profiles) {
      const sim = cosineSim(sp.embedding, p.embedding);
      if (sim >= bestSim) { bestSim = sim; bestName = p.personName; }
    }
    if (bestName) result[sp.label] = bestName;
  }
  return result;
}
