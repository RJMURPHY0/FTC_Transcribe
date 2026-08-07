// Local sanity check for the voice-ID stack: does sherpa-onnx load, are the
// model files present, and does the embedding extractor actually produce a
// vector? Run before any diarisation benchmarking so a harness failure is
// never mistaken for a pipeline regression.
//
//   npx tsx scripts/probe-voice.ts
import { probeVoiceId, analyzeChunkVoices } from '../lib/voice-id';
import { readFileSync, existsSync } from 'fs';
import path from 'path';

async function main() {
  const probe = await probeVoiceId();
  console.log('probeVoiceId:', JSON.stringify(probe, null, 2));
  if (!probe.ok) process.exit(1);

  // Round-trip a real wav through the chunk analyser if one was supplied.
  const wav = process.argv[2];
  if (wav && existsSync(wav)) {
    const buf = readFileSync(path.resolve(wav));
    const t0 = Date.now();
    const out = await analyzeChunkVoices(buf, 'audio/wav');
    console.log(`analyzeChunkVoices(${path.basename(wav)}) in ${Date.now() - t0}ms:`,
      out ? `${out.turns.length} turns, ${out.speakers.length} speakers, model=${out.modelVersion}` : 'null');
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
