// Diarisation accuracy benchmark with ground truth.
//
// Builds synthetic far-field "phone on the meeting-room table" scenes from TTS
// utterances, where we know exactly who spoke when, then scores the real
// pipeline against that truth with standard DER (missed + false alarm +
// speaker confusion, optimally mapped).
//
// Why synthetic: the failure we most need to measure — per-chunk diarisation
// fragmenting one voice across chunk boundaries — is STRUCTURAL, not acoustic.
// It reproduces exactly on synthetic audio, so we can A/B it without a human
// hand-labelling hours of real meetings. TTS voices are easier to separate
// than real humans, so absolute DER here is optimistic; only treat the
// DIFFERENCE between conditions as meaningful.
//
// Setup (once):
//   powershell -ExecutionPolicy Bypass -File scripts/gen-test-voices.ps1 <voicesDir>
//
// Run:
//   npx tsx scripts/diar-bench.ts <voicesDir> [--scenes a,b] [--conditions chunked,whole]
//                                 [--workdir DIR] [--keep] [--env K=V]
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from 'fs';
import { spawnSync } from 'child_process';
import path from 'path';
import os from 'os';

// lib/ai.ts reads its keys at module load, and tsx does not load .env.local.
// Without this the transcriber silently falls into mock mode and returns zero
// segments, which the harness then scores as 100% missed speech.
try {
  const envFile = readFileSync(path.join(process.cwd(), '.env.local'), 'utf8');
  for (const line of envFile.split('\n')) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim().replace(/^"|"$/g, '');
  }
} catch { /* CI or a machine without .env.local — transcription will no-op loudly */ }

const SR = 16000;
const FRAME = 0.01;        // 10 ms DER scoring resolution
const CHUNK_S = 120;       // production chunk length (app/record/page.tsx CHUNK_MS)

// ── tiny deterministic RNG so scenes are reproducible run to run ─────────────
function mulberry32(seed: number) {
  return function () {
    seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ── WAV helpers (16 kHz mono s16le only) ─────────────────────────────────────
function readWav(file: string): Float32Array {
  const buf = readFileSync(file);
  const idx = buf.indexOf('data');
  if (idx < 0) throw new Error(`no data chunk in ${file}`);
  const len = buf.readUInt32LE(idx + 4);
  const start = idx + 8;
  const end = Math.min(start + len, buf.length);
  const n = Math.floor((end - start) / 2);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = buf.readInt16LE(start + i * 2) / 32768;
  return out;
}

function writeWav(file: string, samples: Float32Array): void {
  const data = Buffer.alloc(samples.length * 2);
  for (let i = 0; i < samples.length; i++) {
    const v = Math.max(-1, Math.min(1, samples[i]));
    data.writeInt16LE(Math.round(v * 32767), i * 2);
  }
  const h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + data.length, 4);
  h.write('WAVE', 8); h.write('fmt ', 12);
  h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22);
  h.writeUInt32LE(SR, 24); h.writeUInt32LE(SR * 2, 28);
  h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34);
  h.write('data', 36); h.writeUInt32LE(data.length, 40);
  writeFileSync(file, Buffer.concat([h, data]));
}

function ffmpeg(): string {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const p = require('ffmpeg-static') as string | null;
  if (!p) throw new Error('ffmpeg-static not installed');
  return p;
}

function runFfmpeg(args: string[]): void {
  const r = spawnSync(ffmpeg(), ['-hide_banner', '-loglevel', 'error', '-nostdin', ...args], {
    encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
  });
  if (r.status !== 0) throw new Error(`ffmpeg failed: ${r.stderr?.slice(0, 400)}`);
}

// ── Voice bank ───────────────────────────────────────────────────────────────
// Seven genuinely distinct Edge neural voices (scripts/gen-voices-edge.py).
//
// An earlier version of this harness synthesised extra "speakers" by pitch-
// shifting one TTS voice. That was wrong and it produced a garbage baseline:
// a 9%-shifted voice is the SAME person, TitaNet merged them (cross-voice
// cosine median 0.650 against same-voice 0.734), and the harness scored the
// model as 58% DER for being right. Distinct humans only.
//
// Scene order is deliberate: the two GB males (gbm1/gbm2) land at positions 1
// and 3, so any scene with 3+ speakers contains the genuinely hard case of two
// similar male voices in the same room.
const SPEAKER_ORDER = ['gbm1', 'gbf1', 'gbm2', 'gbf2', 'iem1', 'gbf3', 'ief1'];

interface Voice { id: string; utterances: string[]; enroll: string[] }

function buildVoiceBank(voicesDir: string): Voice[] {
  const files = readdirSync(voicesDir).filter((f) => f.endsWith('.wav'));
  const ids = [...new Set(files.map((f) => f.replace(/_(enroll_)?\d+\.wav$/, '')))];
  const ordered = [...SPEAKER_ORDER.filter((id) => ids.includes(id)),
                   ...ids.filter((id) => !SPEAKER_ORDER.includes(id)).sort()];

  const bank: Voice[] = [];
  for (const id of ordered) {
    const utt = files.filter((f) => f.startsWith(`${id}_`) && !f.includes('_enroll_')).sort();
    const enr = files.filter((f) => f.startsWith(`${id}_enroll_`)).sort();
    if (!utt.length) continue;
    bank.push({
      id,
      utterances: utt.map((f) => path.join(voicesDir, f)),
      enroll: enr.map((f) => path.join(voicesDir, f)),
    });
  }
  if (!bank.length) throw new Error(`no voices found in ${voicesDir}`);
  return bank;
}

// ── Scenes ───────────────────────────────────────────────────────────────────
interface SceneSpec {
  name: string;
  nSpeakers: number;
  durationS: number;
  overlapRatio: number;   // fraction of turns that start before the previous ends
  snrDb: number;          // additive pink noise level (lower = noisier room)
  farField: boolean;      // reverb + band-limiting + per-speaker distance
}

export interface Turn { start: number; end: number; spk: string }

// SNRs are measured at the mic over the whole mix. A real meeting room with a
// phone on the table sits around 20-25 dB; 14 dB is a genuinely bad room with
// aircon and corridor noise. The earlier 10-12 dB figures were below anything
// a phone would actually be used in.
const SCENES: SceneSpec[] = [
  { name: '2spk-clean',    nSpeakers: 2, durationS: 300, overlapRatio: 0.05, snrDb: 32, farField: false },
  { name: '2spk-farfield', nSpeakers: 2, durationS: 300, overlapRatio: 0.10, snrDb: 24, farField: true  },
  { name: '3spk-farfield', nSpeakers: 3, durationS: 420, overlapRatio: 0.15, snrDb: 22, farField: true  },
  { name: '4spk-farfield', nSpeakers: 4, durationS: 480, overlapRatio: 0.15, snrDb: 22, farField: true  },
  { name: '4spk-noisy',    nSpeakers: 4, durationS: 480, overlapRatio: 0.20, snrDb: 14, farField: true  },
  { name: '6spk-farfield', nSpeakers: 6, durationS: 600, overlapRatio: 0.20, snrDb: 20, farField: true  },
  // 30 minutes = 15 production chunks. The per-chunk-vs-whole question is about
  // fragments accumulating across chunk BOUNDARIES, so it only shows up at
  // realistic meeting length — a 5-minute scene has three boundaries and proves
  // nothing. The 116-speaker incident was a long meeting.
  { name: '30min-4spk',    nSpeakers: 4, durationS: 1800, overlapRatio: 0.15, snrDb: 22, farField: true },
];

function buildScene(spec: SceneSpec, bank: Voice[], workDir: string): { wav: string; truth: Turn[] } {
  const outWav = path.join(workDir, `${spec.name}.wav`);
  const outTruth = path.join(workDir, `${spec.name}.truth.json`);
  if (existsSync(outWav) && existsSync(outTruth)) {
    return { wav: outWav, truth: JSON.parse(readFileSync(outTruth, 'utf8')) as Turn[] };
  }

  const rnd = mulberry32(spec.name.split('').reduce((a, c) => a + c.charCodeAt(0), 0));
  const speakers = bank.slice(0, spec.nSpeakers);
  // Distance from the phone on the table. Round a real meeting table the
  // nearest and furthest talker differ by roughly 6-9 dB, not the 13 dB an
  // earlier version used — that put distant speakers below the noise floor,
  // and the harness then reported 70% missed speech as if the pipeline had
  // failed when the audio was simply inaudible.
  const gains = speakers.map((_, i) => (spec.farField ? [1.0, 0.78, 0.66, 0.58, 0.5, 0.44][i] ?? 0.4 : 1.0));

  const total = Math.ceil(spec.durationS * SR);
  const mix = new Float32Array(total);
  const truth: Turn[] = [];
  const cache = new Map<string, Float32Array>();
  const load = (f: string) => {
    if (!cache.has(f)) cache.set(f, readWav(f));
    return cache.get(f)!;
  };

  let cursor = 0.5;
  let prev = -1;
  let uttIdx = speakers.map(() => 0);
  while (cursor < spec.durationS - 2) {
    // pick a speaker, avoiding the same one twice in a row most of the time
    let s = Math.floor(rnd() * speakers.length);
    if (s === prev && rnd() < 0.75) s = (s + 1 + Math.floor(rnd() * (speakers.length - 1))) % speakers.length;
    const v = speakers[s];
    const file = v.utterances[uttIdx[s] % v.utterances.length];
    uttIdx[s]++;
    const samples = load(file);
    const durS = samples.length / SR;

    // Overlap: start this turn before the previous one finished.
    let start = cursor;
    if (truth.length && rnd() < spec.overlapRatio) {
      const back = 0.3 + rnd() * 1.2;
      start = Math.max(0, cursor - back);
    } else {
      start = cursor + 0.15 + rnd() * 1.1;
    }
    const end = start + durS;
    if (end > spec.durationS) break;

    const off = Math.floor(start * SR);
    const g = gains[s];
    for (let i = 0; i < samples.length && off + i < total; i++) mix[off + i] += samples[i] * g;
    truth.push({ start: +start.toFixed(3), end: +end.toFixed(3), spk: v.id });
    cursor = end;
    prev = s;
  }

  // Normalise headroom before effects so reverb/noise levels are predictable.
  let peak = 0;
  for (let i = 0; i < total; i++) peak = Math.max(peak, Math.abs(mix[i]));
  if (peak > 0) for (let i = 0; i < total; i++) mix[i] = (mix[i] / peak) * 0.7;

  const dry = path.join(workDir, `${spec.name}.dry.wav`);
  writeWav(dry, mix);

  let staged = dry;
  if (spec.farField) {
    // Room: early reflections + tail, plus the HF loss and LF rumble you get
    // from a phone mic a couple of metres from the talker.
    const wet = path.join(workDir, `${spec.name}.wet.wav`);
    runFfmpeg(['-i', dry, '-af',
      'aecho=0.85:0.75:27|53|91|139:0.32|0.24|0.17|0.11,highpass=f=95,lowpass=f=6800',
      '-ac', '1', '-ar', String(SR), '-y', wet]);
    staged = wet;
  }

  // Additive pink-ish noise at an exact measured SNR (deterministic, in JS, so
  // the SNR we report is the SNR that is actually there).
  const wetSamples = readWav(staged);
  let sig = 0;
  for (let i = 0; i < wetSamples.length; i++) sig += wetSamples[i] * wetSamples[i];
  const sigRms = Math.sqrt(sig / wetSamples.length);
  const noiseRms = sigRms / Math.pow(10, spec.snrDb / 20);
  const nrnd = mulberry32(9001 + spec.durationS);
  let b0 = 0, b1 = 0, b2 = 0;
  for (let i = 0; i < wetSamples.length; i++) {
    const white = nrnd() * 2 - 1;
    // cheap pink filter (Paul Kellet)
    b0 = 0.99765 * b0 + white * 0.0990460;
    b1 = 0.96300 * b1 + white * 0.2965164;
    b2 = 0.57000 * b2 + white * 1.0526913;
    const pink = (b0 + b1 + b2 + white * 0.1848) / 3.5;
    wetSamples[i] += pink * noiseRms * 3.2;
  }
  writeWav(outWav, wetSamples);
  writeFileSync(outTruth, JSON.stringify(truth));
  return { wav: outWav, truth };
}

// ── DER scoring ──────────────────────────────────────────────────────────────
// Frame-based, overlap-aware, with optimal one-to-one label mapping (Hungarian).
function hungarian(cost: number[][]): number[] {
  // Classic O(n^3) assignment on a square padded matrix; returns col for each row.
  const n = cost.length, m = cost[0]?.length ?? 0;
  const size = Math.max(n, m);
  const a: number[][] = Array.from({ length: size }, (_, i) =>
    Array.from({ length: size }, (_, j) => (i < n && j < m ? cost[i][j] : 0)));
  const u = new Array(size + 1).fill(0);
  const v = new Array(size + 1).fill(0);
  const p = new Array(size + 1).fill(0);
  const way = new Array(size + 1).fill(0);
  for (let i = 1; i <= size; i++) {
    p[0] = i;
    let j0 = 0;
    const minv = new Array(size + 1).fill(Infinity);
    const used = new Array(size + 1).fill(false);
    do {
      used[j0] = true;
      const i0 = p[j0];
      let delta = Infinity, j1 = 0;
      for (let j = 1; j <= size; j++) {
        if (used[j]) continue;
        const cur = a[i0 - 1][j - 1] - u[i0] - v[j];
        if (cur < minv[j]) { minv[j] = cur; way[j] = j0; }
        if (minv[j] < delta) { delta = minv[j]; j1 = j; }
      }
      for (let j = 0; j <= size; j++) {
        if (used[j]) { u[p[j]] += delta; v[j] -= delta; }
        else minv[j] -= delta;
      }
      j0 = j1;
    } while (p[j0] !== 0);
    do { const j1 = way[j0]; p[j0] = p[j1]; j0 = j1; } while (j0);
  }
  const res = new Array(n).fill(-1);
  for (let j = 1; j <= size; j++) if (p[j] >= 1 && p[j] <= n && j <= m) res[p[j] - 1] = j - 1;
  return res;
}

export interface DerResult {
  der: number; missed: number; falseAlarm: number; confusion: number;
  refSpeakers: number; hypSpeakers: number; refSpeechS: number;
}

export function computeDER(truth: Turn[], hyp: Turn[], durationS: number): DerResult {
  const nF = Math.ceil(durationS / FRAME);
  const refLabels = [...new Set(truth.map((t) => t.spk))].sort();
  const hypLabels = [...new Set(hyp.map((t) => t.spk))].sort();
  const refIdx = new Map(refLabels.map((l, i) => [l, i]));
  const hypIdx = new Map(hypLabels.map((l, i) => [l, i]));

  // Per-frame active-speaker sets (reference can hold several during overlap).
  const refFrames: Set<number>[] = Array.from({ length: nF }, () => new Set());
  const hypFrames: Set<number>[] = Array.from({ length: nF }, () => new Set());
  const fill = (turns: Turn[], idx: Map<string, number>, frames: Set<number>[]) => {
    for (const t of turns) {
      const s = Math.max(0, Math.floor(t.start / FRAME));
      const e = Math.min(nF, Math.ceil(t.end / FRAME));
      const id = idx.get(t.spk)!;
      for (let f = s; f < e; f++) frames[f].add(id);
    }
  };
  fill(truth, refIdx, refFrames);
  fill(hyp, hypIdx, hypFrames);

  // Co-occurrence, then optimal mapping that MAXIMISES agreement.
  const co: number[][] = Array.from({ length: refLabels.length },
    () => new Array(hypLabels.length).fill(0));
  for (let f = 0; f < nF; f++) {
    for (const r of refFrames[f]) for (const h of hypFrames[f]) co[r][h] += 1;
  }
  let maxCo = 0;
  for (const row of co) for (const c of row) maxCo = Math.max(maxCo, c);
  const cost = co.map((row) => row.map((c) => maxCo - c));
  const mapping = refLabels.length && hypLabels.length ? hungarian(cost) : [];
  const refToHyp = new Map<number, number>();
  mapping.forEach((h, r) => { if (h >= 0) refToHyp.set(r, h); });

  let missed = 0, falseAlarm = 0, confusion = 0, totalRef = 0;
  for (let f = 0; f < nF; f++) {
    const nr = refFrames[f].size, nh = hypFrames[f].size;
    totalRef += nr;
    let correct = 0;
    for (const r of refFrames[f]) {
      const h = refToHyp.get(r);
      if (h !== undefined && hypFrames[f].has(h)) correct++;
    }
    missed += Math.max(0, nr - nh);
    falseAlarm += Math.max(0, nh - nr);
    confusion += Math.min(nr, nh) - correct;
  }
  const denom = Math.max(totalRef, 1);
  return {
    der: (missed + falseAlarm + confusion) / denom,
    missed: missed / denom,
    falseAlarm: falseAlarm / denom,
    confusion: confusion / denom,
    refSpeakers: refLabels.length,
    hypSpeakers: hypLabels.length,
    refSpeechS: totalRef * FRAME,
  };
}

// ── Real ASR segments ────────────────────────────────────────────────────────
// The hypothesis speaker timeline must cover exactly what production covers:
// one label per ASR segment, and silence carries no label at all.
//
// A hand-rolled energy VAD was tried first and was badly wrong — it discarded
// quiet far-field speech and reported 43-70% missed speech as if the pipeline
// had failed. So transcribe the scene with the real engine instead.
//
// ASR runs per 120 s window in production regardless of the diarisation window,
// so the segments are computed ONCE per scene and shared by both conditions.
// That is the correct experiment: it holds ASR constant and varies only the
// diarisation window, which is the thing under test.
interface AsrSegment { start: number; end: number; text: string }

async function sceneSegments(
  wav: string, durationS: number, workDir: string, sceneName: string,
): Promise<AsrSegment[]> {
  const cacheFile = path.join(workDir, `${sceneName}.asr.json`);
  if (existsSync(cacheFile)) return JSON.parse(readFileSync(cacheFile, 'utf8')) as AsrSegment[];

  const { transcribeAudio } = await import('../lib/ai');
  const all = readWav(wav);
  const out: AsrSegment[] = [];
  for (let off = 0; off < durationS; off += CHUNK_S) {
    const s = Math.floor(off * SR);
    const e = Math.min(all.length, Math.floor((off + CHUNK_S) * SR));
    if (e - s < SR) continue;
    const tmp = path.join(workDir, `__asr_${sceneName}_${Math.round(off)}.wav`);
    writeWav(tmp, all.subarray(s, e));
    const { rawSegments } = await transcribeAudio(tmp);
    for (const r of rawSegments) {
      out.push({ start: r.start + off, end: r.end + off, text: r.text });
    }
  }
  // Fail loudly. A silent fall-through to mock transcription returns zero
  // segments, which scores as 100% missed speech and looks like a pipeline
  // collapse rather than a missing API key.
  if (!out.length) {
    throw new Error(
      `ASR returned no segments for ${sceneName}. Check GROQ_API_KEY/OPENAI_API_KEY are `
      + `loaded — lib/ai.ts silently mocks transcription when neither is set.`,
    );
  }
  writeFileSync(cacheFile, JSON.stringify(out));
  return out;
}

// ── Running the real pipeline ────────────────────────────────────────────────
type Condition = 'chunked' | 'whole';

async function runCondition(
  wav: string, durationS: number, mode: Condition, workDir: string, asr: AsrSegment[],
): Promise<{ hyp: Turn[]; ms: number; analyseMs: number }> {
  const { analyzeChunkVoices, resolveGlobalSpeakers } = await import('../lib/voice-id');
  const all = readWav(wav);
  const chunkLen = mode === 'chunked' ? CHUNK_S : durationS + 1;
  const scene = path.basename(wav, '.wav');
  // Sherpa runs at roughly 0.4x realtime on CPU, so a full sweep is ~30 min.
  // Cache each window's analysis on disk: re-runs that only change resolver
  // thresholds then take seconds instead of re-embedding every turn.
  const cacheDir = path.join(workDir, 'analysis-cache');
  mkdirSync(cacheDir, { recursive: true });

  const chunks: Array<{ offset: number; segments: Array<{ start: number; end: number; text: string }>; voiceData: Awaited<ReturnType<typeof analyzeChunkVoices>> }> = [];
  const t0 = Date.now();
  for (let off = 0; off < durationS; off += chunkLen) {
    const s = Math.floor(off * SR);
    const e = Math.min(all.length, Math.floor((off + chunkLen) * SR));
    if (e - s < SR) continue;
    const part = all.subarray(s, e);
    const cacheFile = path.join(cacheDir, `${scene}__${chunkLen}__${Math.round(off)}.json`);
    let voiceData: Awaited<ReturnType<typeof analyzeChunkVoices>>;
    if (existsSync(cacheFile)) {
      voiceData = JSON.parse(readFileSync(cacheFile, 'utf8'));
    } else {
      const tmp = path.join(workDir, `__part_${Math.round(off)}.wav`);
      writeWav(tmp, part);
      voiceData = await analyzeChunkVoices(readFileSync(tmp), 'audio/wav');
      writeFileSync(cacheFile, JSON.stringify(voiceData));
    }
    // Real ASR segments falling in this window, in window-local time — exactly
    // the shape resolveGlobalSpeakers receives in production.
    const winEnd = off + (e - s) / SR;
    const segments = asr
      .filter((a) => a.start >= off && a.start < winEnd)
      .map((a) => ({ start: +(a.start - off).toFixed(3), end: +(a.end - off).toFixed(3), text: a.text }));
    chunks.push({ offset: off, segments, voiceData });
  }
  const analyseMs = Date.now() - t0;

  const t1 = Date.now();
  const resolved = resolveGlobalSpeakers(chunks, []);
  const ms = Date.now() - t1;
  if (!resolved) return { hyp: [], ms, analyseMs };

  // Collapse consecutive same-speaker tiles into turns.
  const hyp: Turn[] = [];
  for (const s of resolved.segments) {
    const last = hyp[hyp.length - 1];
    if (last && last.spk === s.speaker && Math.abs(last.end - s.start) < 0.01) last.end = s.end;
    else hyp.push({ start: s.start, end: s.end, spk: s.speaker });
  }
  return { hyp, ms, analyseMs };
}

// ── main ─────────────────────────────────────────────────────────────────────
async function main() {
  const args = process.argv.slice(2);
  const voicesDir = args.find((a) => !a.startsWith('--'));
  if (!voicesDir) {
    console.error('usage: tsx scripts/diar-bench.ts <voicesDir> [--scenes a,b] [--conditions chunked,whole] [--workdir DIR] [--env K=V]');
    process.exit(1);
  }
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--env' && args[i + 1]) {
      const [k, v] = args[++i].split('=');
      process.env[k] = v;
    }
  }
  const getOpt = (name: string) => {
    const i = args.indexOf(`--${name}`);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const workDir = getOpt('workdir') ?? path.join(os.tmpdir(), 'diar-bench');
  mkdirSync(workDir, { recursive: true });

  const wantScenes = getOpt('scenes')?.split(',');
  const conditions = (getOpt('conditions')?.split(',') ?? ['chunked', 'whole']) as Condition[];
  const scenes = SCENES.filter((s) => !wantScenes || wantScenes.includes(s.name));

  console.log(`workdir: ${workDir}`);
  const bank = buildVoiceBank(voicesDir);
  console.log(`voice bank: ${bank.map((b) => b.id).join(', ')}`);

  const rows: Array<Record<string, string | number>> = [];
  for (const spec of scenes) {
    process.stdout.write(`\n[${spec.name}] building scene... `);
    const { wav, truth } = buildScene(spec, bank, workDir);
    const speech = truth.reduce((n, t) => n + (t.end - t.start), 0);
    console.log(`${truth.length} turns, ${Math.round(speech)}s speech, ${spec.nSpeakers} speakers`);

    process.stdout.write(`  transcribing (shared by both conditions)... `);
    const asr = await sceneSegments(wav, spec.durationS, workDir, spec.name);
    const asrCover = asr.reduce((n, a) => n + (a.end - a.start), 0);
    console.log(`${asr.length} ASR segments covering ${Math.round(asrCover)}s`);

    for (const mode of conditions) {
      process.stdout.write(`  ${mode.padEnd(8)} `);
      const { hyp, ms, analyseMs } = await runCondition(wav, spec.durationS, mode, workDir, asr);
      const d = computeDER(truth, hyp, spec.durationS);
      console.log(
        `DER ${(d.der * 100).toFixed(1)}%  `
        + `(miss ${(d.missed * 100).toFixed(1)} / fa ${(d.falseAlarm * 100).toFixed(1)} / conf ${(d.confusion * 100).toFixed(1)})  `
        + `spk ${d.hypSpeakers}/${d.refSpeakers}  analyse ${(analyseMs / 1000).toFixed(1)}s resolve ${ms}ms`,
      );
      rows.push({
        scene: spec.name, condition: mode,
        der: +(d.der * 100).toFixed(2),
        miss: +(d.missed * 100).toFixed(2),
        fa: +(d.falseAlarm * 100).toFixed(2),
        conf: +(d.confusion * 100).toFixed(2),
        hypSpk: d.hypSpeakers, refSpk: d.refSpeakers,
        analyseS: +(analyseMs / 1000).toFixed(1), resolveMs: ms,
      });
    }
  }

  console.log('\n=== summary ===');
  console.table(rows);
  const byCond = new Map<string, number[]>();
  for (const r of rows) {
    const c = r.condition as string;
    if (!byCond.has(c)) byCond.set(c, []);
    byCond.get(c)!.push(r.der as number);
  }
  for (const [c, ds] of byCond) {
    console.log(`${c}: mean DER ${(ds.reduce((a, b) => a + b, 0) / ds.length).toFixed(2)}%`);
  }
  writeFileSync(path.join(workDir, 'results.json'), JSON.stringify(rows, null, 2));
  console.log(`\nresults → ${path.join(workDir, 'results.json')}`);
}

// Only run the sweep when invoked directly — scripts/diar-tune.ts imports
// computeDER and the scene loaders from here.
const invokedDirectly = process.argv[1]
  && path.resolve(process.argv[1]).endsWith(path.join('scripts', 'diar-bench.ts'));
if (invokedDirectly) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
