// Does noise suppression actually make voices easier to tell apart?
//
// A speaker-embedding model is only helped by processing that removes what is
// NOT the voice. Spectral subtraction also removes some of what is, and TitaNet
// never saw subtracted audio in training, so the question is empirical and the
// answer decides whether VOICE_DENOISE ships on.
//
// The metric is separation: how much closer a speaker sits to themselves than
// to the other person. A dual-channel meeting is the ideal test set because the
// ground truth needs no labelling — the microphone channel is one person by
// construction and the call channel is everyone else.
//
//   within  = mean cosine between turns of the SAME channel
//   across  = mean cosine between turns of DIFFERENT channels
//   margin  = within - across   (bigger is better; this is what clustering uses)
//
// Usage: npx tsx scripts/bench-denoise.ts <recordingId>
import { readFileSync } from 'fs';
import path from 'path';

const envFile = readFileSync(path.join(process.cwd(), '.env.local'), 'utf8');
for (const line of envFile.split('\n')) {
  const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim().replace(/^"|"$/g, '');
}

interface Turn { start: number; end: number; channel: 'mic' | 'system' }

function meanPairwise(a: number[][], b: number[][], cos: (x: number[], y: number[]) => number): number {
  let total = 0, n = 0;
  for (let i = 0; i < a.length; i++) {
    for (let j = a === b ? i + 1 : 0; j < b.length; j++) { total += cos(a[i], b[j]); n++; }
  }
  return n ? total / n : NaN;
}

async function main() {
  const id = process.argv[2];
  if (!id) { console.error('usage: tsx scripts/bench-denoise.ts <recordingId>'); process.exit(1); }

  const { prisma } = await import('../lib/db');
  const voice = await import('../lib/voice-id');
  const { denoiseForEmbedding, cosineSim, splitChannelsToWav } = voice;
  // Not exported (they are internals of the chunk path), so reach them through
  // the module object rather than widening the public surface for a benchmark.
  const embedOne = (voice as unknown as {
    __embedForBench?: (s: Float32Array) => Promise<number[] | null>;
  }).__embedForBench;

  const blobs = await prisma.chunkBlob.findMany({
    where: { recordingId: id },
    orderBy: { offset: 'asc' },
    select: { audioData: true, mimeType: true, offset: true },
  });
  if (!blobs.length) { console.log('no chunks (audio may have been archived and purged)'); return; }

  const cts = await prisma.chunkTranscript.findMany({
    where: { recordingId: id },
    select: { offset: true, voiceData: true },
  });
  const turnsAt = new Map<number, Turn[]>();
  for (const c of cts) {
    try {
      const vd = c.voiceData ? JSON.parse(c.voiceData) : null;
      if (vd?.turns) turnsAt.set(c.offset, vd.turns as Turn[]);
    } catch { /* skip */ }
  }

  if (!embedOne) {
    console.log('lib/voice-id does not expose an embedding hook for benchmarking.');
    console.log('Add `export const __embedForBench = computeEmbedding` there to run this.');
    await prisma.$disconnect();
    return;
  }

  const SR = 16000;
  const wavToFloat = (buf: Buffer): Float32Array => {
    let pos = 12, off = -1, len = 0;
    while (pos + 8 <= buf.length) {
      const chunkId = buf.toString('ascii', pos, pos + 4);
      const size = buf.readUInt32LE(pos + 4);
      if (chunkId === 'data') { off = pos + 8; len = size; break; }
      pos += 8 + size + (size % 2);
    }
    const n = Math.floor(len / 2);
    const out = new Float32Array(n);
    for (let i = 0; i < n; i++) out[i] = buf.readInt16LE(off + i * 2) / 32768;
    return out;
  };

  const raw: Record<'mic' | 'system', number[][]> = { mic: [], system: [] };
  const clean: Record<'mic' | 'system', number[][]> = { mic: [], system: [] };

  for (const blob of blobs) {
    const split = await splitChannelsToWav(blob.audioData as Buffer, blob.mimeType).catch(() => null);
    if (!split) continue;
    const turns = turnsAt.get(blob.offset) ?? [];
    const channels = {
      mic: wavToFloat(split.mic),
      system: wavToFloat(split.system),
    } as const;

    for (const channel of ['mic', 'system'] as const) {
      const pcm = channels[channel];
      const denoised = denoiseForEmbedding(pcm);
      for (const t of turns.filter((x) => x.channel === channel)) {
        if (t.end - t.start < 2) continue; // short turns are noisy either way
        const s = Math.floor(t.start * SR);
        const e = Math.min(pcm.length, Math.floor(t.end * SR));
        if (e - s < SR * 2) continue;
        const a = await embedOne(pcm.subarray(s, e));
        const b = await embedOne(denoised.subarray(s, e));
        if (a) raw[channel].push(a);
        if (b) clean[channel].push(b);
      }
    }
    process.stderr.write('.');
  }
  process.stderr.write('\n');

  for (const [name, set] of [['raw', raw], ['denoised', clean]] as const) {
    const withinMic = meanPairwise(set.mic, set.mic, cosineSim);
    const withinSys = meanPairwise(set.system, set.system, cosineSim);
    const across = meanPairwise(set.mic, set.system, cosineSim);
    const within = (withinMic + withinSys) / 2;
    console.log(
      `${name.padEnd(9)} turns mic=${set.mic.length} sys=${set.system.length}  `
      + `within=${within.toFixed(3)} (mic ${withinMic.toFixed(3)}, sys ${withinSys.toFixed(3)})  `
      + `across=${across.toFixed(3)}  margin=${(within - across).toFixed(3)}`,
    );
  }
  console.log('\nShip VOICE_DENOISE=true only if the denoised margin is clearly larger.');
  await prisma.$disconnect();
}

main().catch((e) => { console.error(e); process.exit(1); });
