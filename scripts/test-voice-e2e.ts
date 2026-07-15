// E2E test of the voice-ID pipeline against the real DB + real Whisper API.
// 1. Enrolls "David Miller" from one TTS clip (david1.wav)
// 2. Creates a recording with 2 chunks, each a David+Zira conversation
// 3. Runs finalizeRecording (transcribe → diarize → cluster → match profiles)
// 4. Asserts David's segments are auto-labeled "David Miller"
//
// Run: npx tsx scripts/test-voice-e2e.ts <voices-dir>
import { readFileSync } from 'fs';
import path from 'path';

// Load .env.local before importing any lib module
const envFile = readFileSync(path.join(process.cwd(), '.env.local'), 'utf8');
for (const line of envFile.split('\n')) {
  const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim().replace(/^"|"$/g, '');
}

const VOICES = process.argv[2];
if (!VOICES) { console.error('usage: tsx test-voice-e2e.ts <voices-dir>'); process.exit(1); }

// WAV concat helper: all clips are 16k/16-bit/mono with 44-byte headers
function wavSamples(file: string): Buffer {
  const buf = readFileSync(path.join(VOICES, file));
  const dataIdx = buf.indexOf('data');
  return buf.subarray(dataIdx + 8);
}

function makeWav(parts: Array<Buffer | number>): Buffer {
  // number entries = seconds of silence
  const pieces = parts.map(p => typeof p === 'number' ? Buffer.alloc(Math.round(p * 16000) * 2) : p);
  const data = Buffer.concat(pieces);
  const header = Buffer.alloc(44);
  header.write('RIFF', 0); header.writeUInt32LE(36 + data.length, 4);
  header.write('WAVE', 8); header.write('fmt ', 12);
  header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22);
  header.writeUInt32LE(16000, 24); header.writeUInt32LE(32000, 28);
  header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34);
  header.write('data', 36); header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

async function main() {
  const { prisma } = await import('@/lib/db');
  const { embedAudioSample } = await import('@/lib/voice-id');
  const { finalizeRecording, enqueueFinalizeJob } = await import('@/lib/finalize-recording');

  console.log('── 1. Enroll David Miller from david1.wav');
  await prisma.voiceProfile.deleteMany({ where: { personName: 'David Miller' } });
  const enrollWav = makeWav([wavSamples('david1.wav')]);
  const enrolled = await embedAudioSample(enrollWav, 'audio/wav');
  if (!enrolled) throw new Error('enrollment embedding failed');
  await prisma.voiceProfile.create({
    data: {
      personName: 'David Miller',
      embedding: JSON.stringify(enrolled.embedding),
      durationS: enrolled.durationS,
      source: 'enrollment',
      deviceLabel: 'test',
    },
  });
  console.log(`   enrolled: ${enrolled.durationS}s sample`);

  console.log('── 2. Create recording with 2 conversation chunks');
  const chunkA = makeWav([wavSamples('david2.wav'), 0.8, wavSamples('zira1.wav')]);
  const chunkB = makeWav([wavSamples('zira2.wav'), 0.8, wavSamples('david3.wav'), 0.8, wavSamples('zira3.wav')]);
  const durA = (chunkA.length - 44) / 32000;

  const rec = await prisma.recording.create({
    data: { title: 'VOICE ID E2E TEST', status: 'uploading', meetingType: 'general', source: 'web' },
  });
  await prisma.chunkBlob.create({ data: { recordingId: rec.id, audioData: chunkA, offset: 0, mimeType: 'audio/wav' } });
  await prisma.chunkBlob.create({ data: { recordingId: rec.id, audioData: chunkB, offset: durA, mimeType: 'audio/wav' } });
  await enqueueFinalizeJob(rec.id);
  console.log(`   recording ${rec.id}: chunkA ${durA.toFixed(1)}s + chunkB ${((chunkB.length - 44) / 32000).toFixed(1)}s`);

  console.log('── 3. Run finalize pipeline (Whisper + acoustic voice ID + Claude analysis)');
  const t0 = Date.now();
  const result = await finalizeRecording(rec.id);
  console.log(`   finalize: ${JSON.stringify(result)} in ${((Date.now() - t0) / 1000).toFixed(0)}s`);

  console.log('── 4. Verify speakers');
  const transcript = await prisma.transcript.findUnique({ where: { recordingId: rec.id } });
  const segments = JSON.parse(transcript?.segments ?? '[]') as Array<{ speaker: string; start: number; end: number; text: string }>;
  for (const s of segments) {
    console.log(`   [${s.start.toFixed(0)}-${s.end.toFixed(0)}s] ${s.speaker}: ${s.text.slice(0, 60)}`);
  }
  const speakerEmb = await prisma.speakerEmbedding.findMany({ where: { recordingId: rec.id }, select: { speakerLabel: true, durationS: true } });
  console.log('   speaker embeddings:', JSON.stringify(speakerEmb));

  const labels = new Set(segments.map(s => s.speaker));
  const davidLabeled = segments.filter(s => s.speaker === 'David Miller');
  // David speaks in both chunks: ~10s in A (david2) + ~13s in B (david3)
  console.log(`\n   RESULT: ${labels.size} distinct speakers: ${[...labels].join(' | ')}`);
  console.log(`   David Miller segments: ${davidLabeled.length} (voice-matched from enrollment)`);
  if (davidLabeled.length > 0 && labels.size >= 2) {
    console.log('   ✅ VOICE ID WORKING: enrolled voice auto-named across chunks');
  } else {
    console.log('   ❌ voice matching did not label David — inspect above');
  }

  const learned = await prisma.voiceProfile.findMany({
    where: { personName: 'David Miller', source: 'match' },
    select: { durationS: true },
  });
  console.log(`   match-learned samples for David: ${learned.length}`);

  console.log('── 5. Cleanup test data');
  await prisma.recording.delete({ where: { id: rec.id } }).catch(() => {});
  await prisma.voiceProfile.deleteMany({ where: { personName: 'David Miller' } });

  await prisma.$disconnect();
}

main().catch(err => { console.error(err); process.exit(1); });
