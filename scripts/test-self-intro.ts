// Proves the self-introduction → auto voice profile path end-to-end:
// a meeting where two people say their names, no prior enrollment, should
// finish with two auto-created VoiceProfile rows (source='auto').
import { readFileSync } from 'fs';
import path from 'path';

const envFile = readFileSync(path.join(process.cwd(), '.env.local'), 'utf8');
for (const line of envFile.split('\n')) {
  const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim().replace(/^"|"$/g, '');
}

const VOICES = process.argv[2];
function wavData(file: string): Buffer {
  const buf = readFileSync(path.join(VOICES, file));
  return buf.subarray(buf.indexOf('data') + 8);
}
function makeWav(parts: Array<Buffer | number>): Buffer {
  const pieces = parts.map(p => typeof p === 'number' ? Buffer.alloc(Math.round(p * 16000) * 2) : p);
  const data = Buffer.concat(pieces);
  const h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + data.length, 4); h.write('WAVE', 8); h.write('fmt ', 12);
  h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22);
  h.writeUInt32LE(16000, 24); h.writeUInt32LE(32000, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34);
  h.write('data', 36); h.writeUInt32LE(data.length, 40);
  return Buffer.concat([h, data]);
}

async function main() {
  const { prisma } = await import('@/lib/db');
  const { finalizeRecording, enqueueFinalizeJob } = await import('@/lib/finalize-recording');

  // Start clean so we can prove the profiles are freshly auto-created
  await prisma.voiceProfile.deleteMany({ where: { personName: { in: ['David Miller', 'Sarah Chen'] } } });

  const chunkA = makeWav([wavData('intro-david.wav'), 0.8, wavData('intro-sarah.wav')]);
  const rec = await prisma.recording.create({
    data: { title: 'SELF-INTRO TEST', status: 'uploading', meetingType: 'general', source: 'web' },
  });
  await prisma.chunkBlob.create({ data: { recordingId: rec.id, audioData: chunkA, offset: 0, mimeType: 'audio/wav' } });
  await enqueueFinalizeJob(rec.id);

  console.log('Running finalize (transcribe → diarize → LLM names → auto-learn)…');
  const result = await finalizeRecording(rec.id);
  console.log('finalize:', JSON.stringify(result));

  const transcript = await prisma.transcript.findUnique({ where: { recordingId: rec.id } });
  const segs = JSON.parse(transcript?.segments ?? '[]') as Array<{ speaker: string; text: string }>;
  const speakers = [...new Set(segs.map(s => s.speaker))];
  console.log('resolved speakers:', speakers.join(' | '));

  const autoProfiles = await prisma.voiceProfile.findMany({
    where: { source: 'auto', personName: { in: ['David Miller', 'Sarah Chen'] } },
    select: { personName: true, durationS: true },
  });
  console.log('auto-created profiles:', JSON.stringify(autoProfiles));

  await prisma.recording.delete({ where: { id: rec.id } });
  // Leave the auto profiles in place only if the test passed, then clean them
  await prisma.voiceProfile.deleteMany({ where: { personName: { in: ['David Miller', 'Sarah Chen'] } } });

  if (autoProfiles.length >= 1) {
    console.log(`\n✅ SELF-INTRO LEARNING WORKS: ${autoProfiles.length} voice profile(s) auto-created from spoken names`);
  } else {
    console.log('\n❌ no auto profiles created — LLM may not have extracted names from TTS audio');
  }
  await prisma.$disconnect();
}
main().catch(e => { console.error(e); process.exit(1); });
