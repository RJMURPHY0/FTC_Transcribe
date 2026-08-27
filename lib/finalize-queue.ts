// Who gets worked on next, and what happens when a job will not succeed.
//
// The previous worker took the two least-recently-updated unfinished jobs and
// ran them one after the other. That is a ceiling of 24 recordings an hour for
// the whole product, and it has a worse property than slowness: a job that
// always fails keeps sorting to the front, so it took a slot every five minutes
// indefinitely. Recording cmtbd1od3 did exactly that on 27 Aug 2026, nine runs
// deep, while a second user's meeting waited behind it.
//
// Three rules fix that, and they are separable on purpose:
//
//   backoff      a failure costs the job its place for a while, not for ever
//   dead-letter  a job that cannot succeed stops asking
//   fairness     no single account can occupy every slot in a run
import { prisma } from '@/lib/db';
import {
  MAX_RECORDINGS_PER_RUN,
  MAX_PER_USER_PER_RUN,
  MAX_JOB_ATTEMPTS,
  backoffMs,
  interleaveByOwner,
  type QueuedJob,
} from '@/lib/queue-policy';

export {
  MAX_RECORDINGS_PER_RUN,
  FINALIZE_CONCURRENCY,
  MAX_PER_USER_PER_RUN,
  MAX_JOB_ATTEMPTS,
  RUN_BUDGET_MS,
  backoffMs,
} from '@/lib/queue-policy';
export type { QueuedJob } from '@/lib/queue-policy';

/**
 * The next batch of recordings to finalise.
 *
 * Interleaved by owner rather than taken strictly in order: a user with ten
 * queued meetings gets `MAX_PER_USER_PER_RUN` of them and the rest of the run
 * goes to other people. Without this, one person's backlog is indistinguishable
 * from an outage for everybody else.
 */
export async function claimBatch(now = new Date()): Promise<QueuedJob[]> {
  const staleChunkCutoff = new Date(now.getTime() - 5 * 60 * 1000);

  const rows = await prisma.finalizeJob.findMany({
    where: {
      status: { in: ['pending', 'failed', 'running'] },
      deadLettered: false,
      // Backoff: a job that just failed is not eligible again immediately.
      OR: [{ nextAttemptAt: null }, { nextAttemptAt: { lte: now } }],
      // Only recordings that have stopped receiving audio. An active session
      // uploads every 45s to 2 min, so a five-minute gap means it is over.
      recording: {
        deletedAt: null,
        chunks: { none: { createdAt: { gt: staleChunkCutoff } } },
      },
    },
    orderBy: { updatedAt: 'asc' },
    // Over-fetch so the fairness pass has other users to choose from — taking
    // exactly MAX_RECORDINGS_PER_RUN here would refill the batch with the same
    // account's jobs and make interleaving a no-op.
    take: MAX_RECORDINGS_PER_RUN * 4,
    select: {
      recordingId: true,
      attempts: true,
      recording: { select: { userId: true } },
    },
  });

  return interleaveByOwner(
    rows.map((r) => ({
      recordingId: r.recordingId,
      userId: r.recording?.userId ?? null,
      attempts: r.attempts,
    })),
    MAX_RECORDINGS_PER_RUN,
    MAX_PER_USER_PER_RUN,
  );
}

/**
 * Record that a run did not finish this recording.
 *
 * Past MAX_JOB_ATTEMPTS the job is dead-lettered: it stops consuming worker
 * slots and the recording is marked failed so the user sees the truth and can
 * retry it deliberately from the recording page, rather than watching a
 * spinner that a background loop will never resolve.
 */
export async function recordFailure(recordingId: string, reason: string): Promise<void> {
  const job = await prisma.finalizeJob.findUnique({
    where: { recordingId },
    select: { id: true, attempts: true },
  });
  if (!job) return;

  const dead = job.attempts >= MAX_JOB_ATTEMPTS;
  await prisma.finalizeJob.update({
    where: { id: job.id },
    data: {
      status: dead ? 'failed' : 'pending',
      deadLettered: dead,
      lastError: reason.slice(0, 500),
      nextAttemptAt: dead ? null : new Date(Date.now() + backoffMs(job.attempts)),
    },
  }).catch((err) => console.error('[finalize-queue] failure bookkeeping failed:', err));

  if (dead) {
    console.error(`[finalize-queue] dead-lettering ${recordingId} after ${job.attempts} attempts: ${reason}`);
    await prisma.recording
      .update({ where: { id: recordingId }, data: { status: 'failed' } })
      .catch((err) => console.error('[finalize-queue] could not mark recording failed:', err));
  }
}

/** Clear backoff state after a successful pass. */
export async function recordSuccess(recordingId: string): Promise<void> {
  await prisma.finalizeJob
    .updateMany({
      where: { recordingId },
      data: { nextAttemptAt: null, deadLettered: false },
    })
    .catch((err) => console.error('[finalize-queue] success bookkeeping failed:', err));
}

/**
 * Run `tasks` with at most `limit` in flight, stopping cleanly once the run
 * budget is spent. Returns how many actually ran.
 */
export async function runPool<T>(
  tasks: Array<() => Promise<T>>,
  limit: number,
  deadline: number,
): Promise<{ ran: number; deferred: number }> {
  let index = 0;
  let ran = 0;
  const worker = async () => {
    for (;;) {
      if (Date.now() >= deadline) return;
      const i = index++;
      if (i >= tasks.length) return;
      ran += 1;
      try {
        await tasks[i]();
      } catch (err) {
        console.error('[finalize-queue] task threw:', err);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, tasks.length) }, worker));
  return { ran, deferred: tasks.length - ran };
}
