// Diagnostic for the diarisation bench: takes a built scene + its truth file
// and reports what sherpa actually heard, so a harness bug is never mistaken
// for a pipeline regression.
//
//   npx tsx scripts/diar-debug.ts <scene.wav> <scene.truth.json> [sliceSeconds]
import { readFileSync } from 'fs';
import { analyzeChunkVoices, cosineSim } from '../lib/voice-id';

const SR = 16000;

function readWav(file: string): Float32Array {
  const buf = readFileSync(file);
  const idx = buf.indexOf('data');
  const len = buf.readUInt32LE(idx + 4);
  const start = idx + 8;
  const end = Math.min(start + len, buf.length);
  const n = Math.floor((end - start) / 2);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = buf.readInt16LE(start + i * 2) / 32768;
  return out;
}

function writeWav(samples: Float32Array): Buffer {
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
  return Buffer.concat([h, data]);
}

interface Turn { start: number; end: number; spk: string }

async function main() {
  const [wavPath, truthPath, sliceArg] = process.argv.slice(2);
  const slice = Number(sliceArg ?? '60');
  const all = readWav(wavPath);
  const truth: Turn[] = JSON.parse(readFileSync(truthPath, 'utf8'));

  console.log(`audio: ${(all.length / SR).toFixed(1)}s`);
  let peak = 0, sum = 0;
  for (let i = 0; i < all.length; i++) { peak = Math.max(peak, Math.abs(all[i])); sum += all[i] * all[i]; }
  console.log(`peak=${peak.toFixed(3)} rms=${Math.sqrt(sum / all.length).toFixed(4)}`);

  const refInSlice = truth.filter((t) => t.start < slice);
  console.log(`\nreference turns in first ${slice}s:`);
  for (const t of refInSlice) console.log(`  ${t.start.toFixed(1)}-${t.end.toFixed(1)}  ${t.spk}`);

  const part = all.subarray(0, Math.floor(slice * SR));
  const out = await analyzeChunkVoices(writeWav(part), 'audio/wav');
  if (!out) { console.log('\nanalyzeChunkVoices → null'); return; }

  console.log(`\nsherpa turns (${out.turns.length}), local speakers: ${out.speakers.length}`);
  for (const t of out.turns) {
    const ref = refInSlice.find((r) => Math.min(r.end, t.end) - Math.max(r.start, t.start) > 0.3);
    console.log(`  ${t.start.toFixed(1)}-${t.end.toFixed(1)}  local=${t.speaker}  emb=${t.embedding ? 'y' : 'n'}  ref=${ref?.spk ?? '-'}`);
  }

  // Cross-speaker embedding similarity as sherpa saw it.
  const emb = out.turns.filter((t) => t.embedding);
  const same: number[] = [], diff: number[] = [];
  for (let i = 0; i < emb.length; i++) {
    for (let j = i + 1; j < emb.length; j++) {
      const ri = refInSlice.find((r) => Math.min(r.end, emb[i].end) - Math.max(r.start, emb[i].start) > 0.3)?.spk;
      const rj = refInSlice.find((r) => Math.min(r.end, emb[j].end) - Math.max(r.start, emb[j].start) > 0.3)?.spk;
      if (!ri || !rj) continue;
      (ri === rj ? same : diff).push(cosineSim(emb[i].embedding!, emb[j].embedding!));
    }
  }
  const stat = (a: number[]) => a.length
    ? `n=${a.length} min=${Math.min(...a).toFixed(3)} med=${[...a].sort((x, y) => x - y)[Math.floor(a.length / 2)].toFixed(3)} max=${Math.max(...a).toFixed(3)}`
    : 'n=0';
  console.log(`\nTRUE same-speaker turn sim: ${stat(same)}`);
  console.log(`TRUE diff-speaker turn sim: ${stat(diff)}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
