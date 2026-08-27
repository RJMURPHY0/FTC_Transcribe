// Rescue a recording that a chunk-level failure took down with it.
//
//   node scripts/recover-recording.js <recordingId> [--dry]
//
// Written for cmtbd1od3 (27 Aug 2026): 44 of 45 chunks transcribed perfectly,
// one 25KB pause-flush tail was rejected by the ASR provider with a permanent
// "400 Audio file is too short", and the old finalize marked the whole meeting
// failed before it ever wrote the summary. The transcript was sitting in the
// database the entire time.
//
// What it does:
//   1. Reclassifies chunks that failed for a permanent, audio-level reason as
//      `skipped` — terminal, contributes nothing, and no longer fatal.
//   2. Clears the job's failure state and backoff so it is claimable again.
//   3. Leaves the actual re-run to the normal worker, or does it inline with
//      --run so the meeting is back within seconds rather than at the next cron.
const { readFileSync } = require('fs');
const path = require('path');
const { PrismaClient } = require('@prisma/client');

function envLocal(key) {
  const txt = readFileSync(path.join(__dirname, '..', '.env.local'), 'utf8');
  const m = txt.match(new RegExp(`^${key}=(.*)$`, 'm'));
  if (!m) throw new Error(`${key} not in .env.local`);
  return m[1].trim().replace(/^["']|["']$/g, '');
}

const prisma = new PrismaClient({ datasources: { db: { url: envLocal('DATABASE_URL') } } });

// Mirrors isPermanentAudioError in lib/transcribe-chunk.ts. Duplicated rather
// than imported because this is a plain node script and that module pulls the
// native voice-id chain in behind it.
const PERMANENT = /audio file is too short|minimum audio length|too short|invalid file format|could not be decoded|unsupported file|unrecognized file format|file is empty|is not a valid|^400 /i;

const recordingId = process.argv[2];
const dryRun = process.argv.includes('--dry');
const runNow = process.argv.includes('--run');

if (!recordingId) {
  console.error('usage: node scripts/recover-recording.js <recordingId> [--dry] [--run]');
  process.exit(1);
}

(async () => {
  const rec = await prisma.recording.findUnique({
    where: { id: recordingId },
    select: { id: true, title: true, status: true, userId: true, duration: true, _count: { select: { chunks: true } } },
  });
  if (!rec) throw new Error(`no recording ${recordingId}`);

  const job = await prisma.finalizeJob.findUnique({ where: { recordingId } });
  const failed = await prisma.chunkTranscript.findMany({
    where: { recordingId, status: 'failed' },
    select: { id: true, chunkId: true, offset: true, attempts: true, lastError: true },
    orderBy: { offset: 'asc' },
  });

  console.log(`recording  ${rec.id}  "${rec.title}"`);
  console.log(`status     ${rec.status}   chunks ${rec._count.chunks}`);
  console.log(`job        ${job ? `${job.status} attempts=${job.attempts} stage=${job.stage} lastError=${job.lastError}` : 'none'}`);
  console.log(`failed chunks: ${failed.length}`);

  const permanent = failed.filter((c) => PERMANENT.test(c.lastError ?? ''));
  const transient = failed.filter((c) => !PERMANENT.test(c.lastError ?? ''));
  for (const c of failed) {
    const kind = PERMANENT.test(c.lastError ?? '') ? 'PERMANENT -> skip' : 'transient -> retry';
    console.log(`  ${String(c.offset).padStart(9)}s  attempts=${c.attempts}  ${kind}\n    ${c.lastError}`);
  }

  if (dryRun) {
    console.log('\n--dry: nothing written.');
    await prisma.$disconnect();
    return;
  }

  if (permanent.length) {
    const { count } = await prisma.chunkTranscript.updateMany({
      where: { id: { in: permanent.map((c) => c.id) } },
      data: { status: 'skipped', transcript: '', segments: '[]', processedAt: new Date() },
    });
    console.log(`\nreclassified ${count} permanently-unusable chunk(s) as skipped`);
  }
  if (transient.length) {
    const { count } = await prisma.chunkTranscript.updateMany({
      where: { id: { in: transient.map((c) => c.id) } },
      data: { status: 'pending', attempts: 0, lastError: '' },
    });
    console.log(`reset ${count} transient failure(s) for another attempt`);
  }

  if (job) {
    await prisma.finalizeJob.update({
      where: { id: job.id },
      data: {
        status: 'pending',
        attempts: 0,
        lastError: '',
        lockToken: null,
        lockUntil: null,
        nextAttemptAt: null,
        deadLettered: false,
      },
    });
    console.log('job reset to pending, backoff and dead-letter cleared');
  }

  await prisma.recording.update({ where: { id: recordingId }, data: { status: 'processing' } });
  console.log('recording set back to processing');

  if (runNow) {
    // Drive the deployed worker rather than importing the pipeline here:
    // finalize pulls in the native voice-id chain, which needs the Next.js
    // build and the ONNX models that ship with it, not a bare node process.
    const base = process.env.APP_URL || 'https://ftctranscribe-phi.vercel.app';
    console.log(`\ntriggering the deployed worker at ${base}/api/jobs/finalize ...`);
    const res = await fetch(`${base}/api/jobs/finalize`, {
      headers: { authorization: `Bearer ${envLocal('CRON_SECRET')}` },
    });
    console.log(`worker responded ${res.status}:`, (await res.text()).slice(0, 500));
  } else {
    console.log('\nthe next cron run will pick it up (or re-run with --run to do it now)');
  }

  await prisma.$disconnect();
})().catch((err) => {
  console.error('FAILED:', err.message);
  process.exit(1);
});
