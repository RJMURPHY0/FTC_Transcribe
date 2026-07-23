// Snapshot a recording's stored diarization inputs (ChunkTranscript.segments +
// voiceData) and current outputs (Transcript.segments, SpeakerEmbedding rows,
// VoiceProfile rows) to a local JSON file, so resolver tuning can replay
// offline without touching the prod DB again.
//
// Usage: node scripts/snapshot-recording-voice.js [recordingId] [outPath]
//        (no id → lists candidate recordings from 2026-07-21)
const { readFileSync, writeFileSync } = require('fs');
const path = require('path');
const { PrismaClient } = require('@prisma/client');

function envLocal(key) {
  const txt = readFileSync(path.join(__dirname, '..', '.env.local'), 'utf8');
  const m = txt.match(new RegExp(`^${key}=(.*)$`, 'm'));
  if (!m) throw new Error(`${key} not in .env.local`);
  return m[1].trim().replace(/^"|"$/g, '');
}

const prisma = new PrismaClient({ datasources: { db: { url: envLocal('DATABASE_URL') } } });

async function main() {
  const [id, outPath] = process.argv.slice(2);

  if (!id) {
    const rows = await prisma.recording.findMany({
      where: { createdAt: { gte: new Date('2026-07-20T00:00:00Z'), lt: new Date('2026-07-23T00:00:00Z') } },
      select: { id: true, title: true, createdAt: true, duration: true, status: true },
      orderBy: { createdAt: 'asc' },
    });
    for (const r of rows) {
      console.log(`${r.id}  ${r.createdAt.toISOString()}  ${r.duration}s  ${r.status}  ${r.title ?? '(untitled)'}`);
    }
    return;
  }

  const [recording, transcript, chunks, speakerEmbeddings, profiles] = await Promise.all([
    prisma.recording.findUnique({ where: { id }, select: { id: true, title: true, createdAt: true, duration: true, status: true, userId: true, audioPath: true } }),
    prisma.transcript.findUnique({ where: { recordingId: id }, select: { segments: true, language: true } }),
    prisma.chunkTranscript.findMany({
      where: { recordingId: id, status: 'succeeded' },
      orderBy: [{ offset: 'asc' }, { createdAt: 'asc' }],
      select: { offset: true, segments: true, voiceData: true },
    }),
    prisma.speakerEmbedding.findMany({ where: { recordingId: id }, select: { speakerLabel: true, embedding: true, durationS: true } }),
    prisma.voiceProfile.findMany({ select: { userId: true, personName: true, embedding: true, durationS: true, source: true } }),
  ]);
  if (!recording) throw new Error('recording not found');

  const segs = transcript ? JSON.parse(transcript.segments) : [];
  const speakers = new Set(segs.map((s) => s.speaker));
  console.log(`recording: ${recording.title ?? '(untitled)'} ${recording.duration}s status=${recording.status}`);
  console.log(`transcript segments: ${segs.length}, distinct speakers: ${speakers.size}`);
  console.log(`chunks: ${chunks.length} (with voiceData: ${chunks.filter((c) => c.voiceData).length})`);
  console.log(`speakerEmbeddings: ${speakerEmbeddings.length}, voiceProfiles: ${profiles.length}`);

  const out = outPath ?? path.join(__dirname, '..', '.local', `voice-snapshot-${id}.json`);
  require('fs').mkdirSync(path.dirname(out), { recursive: true });
  writeFileSync(out, JSON.stringify({
    recording,
    transcriptSegments: segs,
    chunks: chunks.map((c) => ({
      offset: c.offset,
      segments: JSON.parse(c.segments || '[]'),
      voiceData: c.voiceData ? JSON.parse(c.voiceData) : null,
    })),
    speakerEmbeddings: speakerEmbeddings.map((s) => ({ ...s, embedding: JSON.parse(s.embedding) })),
    profiles: profiles.map((p) => ({ ...p, embedding: JSON.parse(p.embedding) })),
  }));
  console.log('snapshot →', out);
}

main().finally(() => prisma.$disconnect());
