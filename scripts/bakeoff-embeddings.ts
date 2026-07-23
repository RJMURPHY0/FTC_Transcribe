// Embedding-model bake-off on a REAL meeting: re-embed the stored diarization
// turns (same pyannote segmentation for every candidate) with each candidate
// speaker-embedding model, and emit a replayable snapshot per model. Judge the
// winners with replay-voice-resolver / analyze-clusters.
//
// Usage: npx tsx scripts/bakeoff-embeddings.ts <snapshot.json> <modelsDir>
// Chunk audio is pulled from the DB once and cached in .local/meeting-audio/.
import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync } from 'fs';
import { spawnSync } from 'child_process';
import path from 'path';

const envFile = readFileSync(path.join(process.cwd(), '.env.local'), 'utf8');
for (const line of envFile.split('\n')) {
  const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim().replace(/^"|"$/g, '');
}

const SAMPLE_RATE = 16000;
const MIN_TURN_EMBED_S = 1.0;
const MAX_TURN_EMBED_SECONDS = 15;

function wavToF32(wav: Buffer): Float32Array {
  const dataIdx = wav.indexOf('data');
  const start = dataIdx + 8;
  const n = Math.floor((wav.length - start) / 2);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = wav.readInt16LE(start + i * 2) / 32768;
  return out;
}

async function main() {
  const [snapFile, modelsDir] = process.argv.slice(2);
  const snap = JSON.parse(readFileSync(snapFile, 'utf8'));
  const recId = snap.recording.id;
  const audioDir = path.join('.local', 'meeting-audio', recId);
  mkdirSync(audioDir, { recursive: true });

  // 1. Pull + decode chunk audio (cached)
  const wavFor = (offset: number) => path.join(audioDir, `${offset}.wav`);
  const missing = snap.chunks.filter((c: any) => !existsSync(wavFor(c.offset)));
  if (missing.length) {
    console.log(`decoding ${missing.length} chunks from DB…`);
    const { PrismaClient } = require('@prisma/client');
    const prisma = new PrismaClient();
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const ffmpeg = require('ffmpeg-static') as string;
    const blobs = await prisma.chunkBlob.findMany({
      where: { recordingId: recId },
      orderBy: { offset: 'asc' },
      select: { offset: true, mimeType: true, audioData: true },
    });
    for (const b of blobs) {
      const out = wavFor(b.offset);
      if (existsSync(out)) continue;
      const tmp = path.join(audioDir, `in-${b.offset}.webm`);
      writeFileSync(tmp, b.audioData as Buffer);
      const r = spawnSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-nostdin', '-i', tmp, '-ac', '1', '-ar', String(SAMPLE_RATE), '-acodec', 'pcm_s16le', '-y', out]);
      if (r.status !== 0) console.warn(`ffmpeg failed for offset ${b.offset}`);
      require('fs').unlinkSync(tmp);
    }
    await prisma.$disconnect();
  }

  // 2. sherpa extractor per model
  if (process.platform === 'win32') {
    const dllDir = path.join(process.cwd(), 'node_modules', 'sherpa-onnx-win-x64');
    process.env.PATH = `${dllDir};${process.env.PATH}`;
  }
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const sherpa = require('sherpa-onnx-node');

  const models = readdirSync(modelsDir).filter((f) => f.endsWith('.onnx'));
  for (const modelFile of models) {
    const tag = modelFile.replace(/\.onnx$/, '').replace(/[^a-z0-9]+/gi, '-').slice(0, 40);
    const outFile = path.join('.local', `bakeoff-${tag}.json`);
    if (existsSync(outFile)) { console.log(`skip ${tag} (exists)`); continue; }
    console.log(`embedding with ${modelFile}…`);
    const t0 = Date.now();
    const extractor = new sherpa.SpeakerEmbeddingExtractor({ model: path.join(modelsDir, modelFile), numThreads: 4 });

    const chunks = [] as any[];
    let embedded = 0;
    for (const c of snap.chunks) {
      const copy = { offset: c.offset, segments: c.segments, voiceData: c.voiceData ? { speakers: c.voiceData.speakers, turns: [] as any[] } : null };
      if (c.voiceData && existsSync(wavFor(c.offset))) {
        const samples = wavToF32(readFileSync(wavFor(c.offset)));
        for (const t of c.voiceData.turns) {
          const nt: any = { start: t.start, end: t.end, speaker: t.speaker };
          const dur = t.end - t.start;
          if (dur >= MIN_TURN_EMBED_S) {
            const s = Math.max(0, Math.floor(t.start * SAMPLE_RATE));
            const e = Math.min(samples.length, Math.floor(Math.min(t.end, t.start + MAX_TURN_EMBED_SECONDS) * SAMPLE_RATE));
            if (e - s >= SAMPLE_RATE * MIN_TURN_EMBED_S) {
              const stream = extractor.createStream();
              stream.acceptWaveform({ samples: samples.subarray(s, e), sampleRate: SAMPLE_RATE });
              const emb = extractor.compute(stream) as Float32Array;
              nt.embedding = Array.from(emb, (v) => Math.round(v * 1e4) / 1e4);
              embedded++;
            }
          }
          copy.voiceData!.turns.push(nt);
        }
      } else if (c.voiceData) {
        copy.voiceData!.turns = c.voiceData.turns.map((t: any) => ({ start: t.start, end: t.end, speaker: t.speaker }));
      }
      chunks.push(copy);
    }
    writeFileSync(outFile, JSON.stringify({ ...snap, profiles: [], chunks }));
    console.log(`  ${tag}: ${embedded} turns embedded, dim=${extractor.dim}, ${Math.round((Date.now() - t0) / 1000)}s → ${outFile}`);
  }
}

main();
