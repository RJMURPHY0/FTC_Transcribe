// Scheduling rules for the finalize worker, kept free of Prisma and of any
// native dependency so they can be reasoned about and tested on their own.
//
// The behaviour these encode is the difference between a queue and a pile. The
// old worker took the two least-recently-updated unfinished jobs and ran them
// in sequence, which meant a job that could never succeed sorted to the front
// on every single run and held a slot indefinitely.

/** Recordings claimed per cron run. */
export const MAX_RECORDINGS_PER_RUN = Math.max(
  1, parseInt(process.env.FINALIZE_MAX_PER_RUN ?? '12', 10) || 12,
);
/** How many finalize passes run at once inside one invocation. */
export const FINALIZE_CONCURRENCY = Math.max(
  1, parseInt(process.env.FINALIZE_CONCURRENCY ?? '4', 10) || 4,
);
/** Most slots any one account may take in a single run. */
export const MAX_PER_USER_PER_RUN = Math.max(
  1, parseInt(process.env.FINALIZE_MAX_PER_USER ?? '2', 10) || 2,
);
/** Attempts before a job is dead-lettered and stops being retried. */
export const MAX_JOB_ATTEMPTS = Math.max(
  1, parseInt(process.env.FINALIZE_MAX_ATTEMPTS ?? '5', 10) || 5,
);
/**
 * Stop claiming new work at this point in the run.
 *
 * maxDuration is 800s. Leaving headroom means the function returns a real
 * result and the next cron picks up the remainder, instead of being killed
 * mid-analysis with a lock held.
 */
export const RUN_BUDGET_MS = Math.max(
  60_000, parseInt(process.env.FINALIZE_RUN_BUDGET_MS ?? '600000', 10) || 600_000,
);

/** The cron interval. Backoff shorter than this changes nothing. */
export const CRON_INTERVAL_MS = 5 * 60 * 1000;

/**
 * How long a job waits after a failed pass: 5, 10, 20, 40, 80 minutes, then
 * held.
 *
 * The base is the cron interval on purpose. A backoff shorter than the gap
 * between runs is invisible — the job is eligible again by the time anything
 * next looks — which is how one recording took a worker slot sixteen times
 * over. The first step therefore has to cost it at least one whole run.
 */
export function backoffMs(attempts: number): number {
  const step = Math.min(Math.max(attempts, 1), 5) - 1;
  return CRON_INTERVAL_MS * Math.pow(2, step);
}

export interface QueuedJob {
  recordingId: string;
  userId: string | null;
  attempts: number;
}

/**
 * Choose this run's batch, round-robin across owners.
 *
 * Input is expected in priority order (oldest first). Output preserves that
 * order within each owner while interleaving between them, so a user with ten
 * queued meetings gets `perUser` of them and the remaining slots go to other
 * people. Without this, one person's backlog is indistinguishable from an
 * outage for everybody else on the platform.
 */
export function interleaveByOwner(
  jobs: QueuedJob[],
  limit = MAX_RECORDINGS_PER_RUN,
  perUser = MAX_PER_USER_PER_RUN,
): QueuedJob[] {
  const byUser = new Map<string, QueuedJob[]>();
  for (const job of jobs) {
    const key = job.userId ?? '__unowned__';
    const list = byUser.get(key);
    if (list) list.push(job);
    else byUser.set(key, [job]);
  }

  const queues = [...byUser.values()];
  const taken: QueuedJob[] = [];
  for (let round = 0; round < perUser; round++) {
    for (const queue of queues) {
      if (taken.length >= limit) return taken;
      const next = queue[round];
      if (next) taken.push(next);
    }
  }
  return taken;
}
