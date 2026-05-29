/**
 * One-time migration: copies all data from FTC Transcribe Supabase
 * into FTC Contacts Supabase.
 *
 * Run from the FTC Transcribe directory:
 *
 *   $env:NEW_DATABASE_URL="postgresql://postgres.ijeeghdxokfvlfarojlm:<password>@aws-0-eu-west-1.pooler.supabase.com:6543/postgres"
 *   node scripts/migrate-to-contacts.mjs
 *
 * The script is safe to re-run — it skips rows that already exist.
 */

import { PrismaClient } from '@prisma/client'

const SOURCE_URL = process.env.DATABASE_URL
const TARGET_URL = process.env.NEW_DATABASE_URL

if (!SOURCE_URL) {
  console.error('\n❌  DATABASE_URL not set (should already be in .env.local)\n')
  process.exit(1)
}
if (!TARGET_URL) {
  console.error('\n❌  Set NEW_DATABASE_URL to the FTC Contacts connection string before running.\n')
  console.error('    $env:NEW_DATABASE_URL="postgresql://postgres.ijeeghdxokfvlfarojlm:<password>@aws-0-eu-west-1.pooler.supabase.com:6543/postgres"\n')
  process.exit(1)
}

const src = new PrismaClient({ datasources: { db: { url: SOURCE_URL } } })
const tgt = new PrismaClient({ datasources: { db: { url: TARGET_URL } } })

function log(label, count) {
  console.log(`  ✓  ${label.padEnd(20)} ${count} row${count !== 1 ? 's' : ''}`)
}

async function run() {
  console.log('\n🚀  Migrating FTC Transcribe → FTC Contacts\n')

  // ── Folders ──────────────────────────────────────────────────────────────
  const folders = await src.folder.findMany()
  if (folders.length) {
    await tgt.folder.createMany({ data: folders, skipDuplicates: true })
  }
  log('Folders', folders.length)

  // ── Recordings ───────────────────────────────────────────────────────────
  const recordings = await src.recording.findMany()
  if (recordings.length) {
    await tgt.recording.createMany({ data: recordings, skipDuplicates: true })
  }
  log('Recordings', recordings.length)

  // ── ChunkBlobs (binary audio — insert one-by-one to stay memory-safe) ────
  const chunks = await src.chunkBlob.findMany()
  let chunksDone = 0
  for (const chunk of chunks) {
    await tgt.chunkBlob.upsert({ where: { id: chunk.id }, create: chunk, update: {} })
    chunksDone++
    if (chunksDone % 5 === 0 || chunksDone === chunks.length) {
      process.stdout.write(`\r  ✓  ChunkBlobs            ${chunksDone}/${chunks.length}`)
    }
  }
  if (chunks.length) process.stdout.write('\n')
  if (!chunks.length) log('ChunkBlobs', 0)

  // ── FinalizeJobs ─────────────────────────────────────────────────────────
  const jobs = await src.finalizeJob.findMany()
  if (jobs.length) {
    await tgt.finalizeJob.createMany({ data: jobs, skipDuplicates: true })
  }
  log('FinalizeJobs', jobs.length)

  // ── ChunkTranscripts ─────────────────────────────────────────────────────
  const cts = await src.chunkTranscript.findMany()
  if (cts.length) {
    await tgt.chunkTranscript.createMany({ data: cts, skipDuplicates: true })
  }
  log('ChunkTranscripts', cts.length)

  // ── Transcripts ──────────────────────────────────────────────────────────
  const transcripts = await src.transcript.findMany()
  if (transcripts.length) {
    await tgt.transcript.createMany({ data: transcripts, skipDuplicates: true })
  }
  log('Transcripts', transcripts.length)

  // ── Summaries ────────────────────────────────────────────────────────────
  const summaries = await src.summary.findMany()
  if (summaries.length) {
    await tgt.summary.createMany({ data: summaries, skipDuplicates: true })
  }
  log('Summaries', summaries.length)

  console.log('\n✅  Migration complete!\n')
  console.log('Next step: update DATABASE_URL in FTC Transcribe .env.local to:')
  console.log('  postgresql://postgres.ijeeghdxokfvlfarojlm:<password>@aws-0-eu-west-1.pooler.supabase.com:6543/postgres\n')
}

run()
  .catch((err) => {
    console.error('\n❌  Migration failed:', err.message, '\n')
    process.exit(1)
  })
  .finally(async () => {
    await src.$disconnect()
    await tgt.$disconnect()
  })
