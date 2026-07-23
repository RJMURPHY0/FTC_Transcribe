// Write re-embedded turn voiceprints (from a bake-off snapshot) into a
// recording's ChunkTranscript rows, tagged with the new model version, so
// reanalysis resolves speakers in the new embedding space.
//
// Usage: node scripts/upgrade-recording-embeddings.js <bakeoffSnapshot.json> <modelVersion>
const { readFileSync } = require('fs');
const path = require('path');
const { PrismaClient } = require('@prisma/client');

function envLocal(key) {
  const txt = readFileSync(path.join(__dirname, '..', '.env.local'), 'utf8');
  const m = txt.match(new RegExp(`^${key}=(.*)$`, 'm'));
  return m[1].trim().replace(/^"|"$/g, '');
}
const prisma = new PrismaClient({ datasources: { db: { url: envLocal('DATABASE_URL') } } });

async function main() {
  const [snapFile, modelVersion] = process.argv.slice(2);
  if (!snapFile || !modelVersion) throw new Error('usage: upgrade-recording-embeddings.js <snapshot> <modelVersion>');
  const snap = JSON.parse(readFileSync(snapFile, 'utf8'));
  const recId = snap.recording.id;

  let updated = 0;
  for (const c of snap.chunks) {
    if (!c.voiceData) continue;
    const res = await prisma.chunkTranscript.updateMany({
      where: { recordingId: recId, offset: c.offset, status: 'succeeded' },
      data: { voiceData: JSON.stringify({ ...c.voiceData, modelVersion }) },
    });
    updated += res.count;
  }
  console.log(`updated voiceData on ${updated} ChunkTranscript rows for ${recId} (${modelVersion})`);
}

main().finally(() => prisma.$disconnect());
