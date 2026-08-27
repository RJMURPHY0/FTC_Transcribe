import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { finalizeRecording, enqueueFinalizeJob } from '@/lib/finalize-recording';
import { deleteArchivedAudio } from '@/lib/audio-archive';
import {
  claimBatch,
  recordFailure,
  recordSuccess,
  runPool,
  FINALIZE_CONCURRENCY,
  MAX_RECORDINGS_PER_RUN,
  RUN_BUDGET_MS,
} from '@/lib/finalize-queue';

export const dynamic = 'force-dynamic';
export const maxDuration = 800;

// How many stale uploads may be enqueued per run. Enqueueing is a cheap upsert,
// so this is deliberately far larger than the number that will be *worked* —
// a recording that is not enqueued is invisible to the worker for another five
// minutes, and that used to be capped at two for the entire product.
const MAX_ENQUEUE_PER_RUN = 100;

// Fail closed, same pattern as /api/auto-fix: this route is exempt from
// middleware auth, so an unset CRON_SECRET previously let anyone drive the
// finalize worker and the 30-day purge. Vercel cron sends the Bearer header
// automatically once CRON_SECRET exists in the project env.
function isAuthorized(req: NextRequest): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  const auth = req.headers.get('authorization') ?? '';
  return auth === `Bearer ${secret}`;
}

async function runWorker(deadline: number) {
  const candidates = await claimBatch();

  let completed = 0;
  let partial = 0;
  let failed = 0;

  const { ran, deferred } = await runPool(
    candidates.map((job) => async () => {
      const result = await finalizeRecording(job.recordingId);
      if (!result.ok) {
        failed += 1;
        await recordFailure(job.recordingId, result.reason);
        return;
      }
      if (result.completed) {
        completed += 1;
        await recordSuccess(job.recordingId);
        return;
      }
      partial += 1;
      // "Not completed" covers two very different things. Genuine progress
      // (more chunks to do next run, background transcription still landing)
      // must not accrue backoff — only a stall does.
      if (result.failedChunks > 0) await recordFailure(job.recordingId, result.reason);
    }),
    FINALIZE_CONCURRENCY,
    deadline,
  );

  if (deferred > 0) {
    // Never let a bounded run look like full coverage.
    console.warn(`[jobs/finalize] run budget spent — ${deferred} claimed recording(s) deferred to the next run`);
  }

  return { scanned: candidates.length, worked: ran, deferred, completed, partial, failed };
}

export async function GET(request: NextRequest) {
  if (!isAuthorized(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const deadline = Date.now() + RUN_BUDGET_MS;

  // Enqueue finalize jobs for any stale uploading recordings (no chunk in last 5 min)
  const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000);

  const staleUploads = await prisma.recording.findMany({
    where: {
      status: 'uploading',
      deletedAt: null,
      chunks: {
        some: {},
        none: { createdAt: { gt: fiveMinutesAgo } },
      },
    },
    take: MAX_ENQUEUE_PER_RUN,
    select: { id: true },
  }).catch((err) => {
    console.error('[jobs/finalize] stale-upload scan failed:', err);
    return [] as Array<{ id: string }>;
  });

  for (const rec of staleUploads) {
    await enqueueFinalizeJob(rec.id);
  }

  // Mark recordings that have been stuck in 'uploading' or 'processing' for over 24 hours
  // as failed. These are ghosts — abandoned sessions, mic-denied starts, or crashed uploads —
  // that will never complete on their own.
  const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
  await prisma.recording.updateMany({
    where: {
      status: { in: ['uploading', 'processing'] },
      createdAt: { lt: oneDayAgo },
    },
    data: { status: 'failed' },
  }).catch((err) => console.error('[jobs/finalize] stuck-recording sweep failed:', err));

  // Purge soft-deleted recordings after 30 days (hard delete cascades
  // transcripts, summaries, chunks, and speaker embeddings). Archived audio
  // lives outside the DB, so remove those storage objects first.
  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  try {
    const purgeable = await prisma.recording.findMany({
      where: { deletedAt: { lt: thirtyDaysAgo }, audioPath: { not: '' } },
      select: { audioPath: true },
    });
    for (const r of purgeable) await deleteArchivedAudio(r.audioPath);
  } catch (err) {
    console.error('[jobs/finalize] archived-audio purge failed:', err);
  }
  await prisma.recording.deleteMany({
    where: { deletedAt: { lt: thirtyDaysAgo } },
  }).catch((err) => console.error('[jobs/finalize] soft-delete purge failed:', err));

  const stats = await runWorker(deadline);
  return NextResponse.json({
    ok: true,
    enqueued: staleUploads.length,
    capacity: MAX_RECORDINGS_PER_RUN,
    concurrency: FINALIZE_CONCURRENCY,
    ...stats,
  });
}

export async function POST(request: NextRequest) {
  return GET(request);
}
