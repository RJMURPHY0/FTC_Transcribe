// What real material is actually available to benchmark against?
// Counts recordings, retained chunk audio, stored speaker embeddings and
// enrolled voice profiles, so the diarisation harness can be built on real
// audio wherever possible instead of synthetic scenes only.
//
//   npx tsx scripts/data-inventory.ts
import { readFileSync } from 'fs';
import path from 'path';

const envFile = readFileSync(path.join(process.cwd(), '.env.local'), 'utf8');
for (const line of envFile.split('\n')) {
  const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim().replace(/^"|"$/g, '');
}

async function main() {
  const { prisma } = await import('../lib/db');

  const recordings = await prisma.recording.count();
  const withTranscript = await prisma.transcript.count();
  console.log(`recordings: ${recordings}  transcripts: ${withTranscript}`);

  // Recordings that still have their chunk audio in Postgres (not yet purged).
  const chunky = await prisma.$queryRaw<Array<{ recordingId: string; chunks: bigint; bytes: bigint }>>`
    SELECT "recordingId", COUNT(*) AS chunks, SUM(LENGTH("audioData")) AS bytes
    FROM "ChunkBlob" GROUP BY "recordingId" ORDER BY COUNT(*) DESC LIMIT 15`;
  console.log(`\nrecordings with retained chunk audio: ${chunky.length}`);
  for (const c of chunky) {
    console.log(`  ${c.recordingId}  chunks=${c.chunks}  ${(Number(c.bytes) / 1e6).toFixed(1)}MB`);
  }

  // Human-verified voice profiles are the closest thing to identity ground truth.
  const profiles = await prisma.$queryRaw<Array<{ personName: string; source: string; n: bigint; withAudio: bigint; secs: number }>>`
    SELECT "personName", source, COUNT(*) AS n,
           COUNT("audioData") AS "withAudio", COALESCE(SUM("durationS"), 0) AS secs
    FROM "VoiceProfile" GROUP BY "personName", source ORDER BY "personName"`;
  console.log(`\nvoice profiles (audio clips are real human voices we can benchmark on):`);
  for (const p of profiles) {
    console.log(`  ${p.personName}  source=${p.source}  n=${p.n}  withAudio=${p.withAudio}  ${Math.round(Number(p.secs))}s`);
  }

  // Recordings where speakers were resolved acoustically — candidate regression set.
  const embedded = await prisma.$queryRaw<Array<{ recordingId: string; speakers: bigint; totalS: number }>>`
    SELECT "recordingId", COUNT(*) AS speakers, SUM("durationS") AS "totalS"
    FROM "SpeakerEmbedding" GROUP BY "recordingId" ORDER BY COUNT(*) DESC LIMIT 20`;
  console.log(`\nrecordings with resolved speaker embeddings: ${embedded.length}`);
  for (const e of embedded) {
    console.log(`  ${e.recordingId}  speakers=${e.speakers}  ${Math.round(Number(e.totalS))}s`);
  }

  await prisma.$disconnect();
}

main().catch((e) => { console.error(e); process.exit(1); });
