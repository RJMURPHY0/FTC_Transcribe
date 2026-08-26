// How long will this take, really?
//
// The old answer was a constant: 45 seconds plus a small per-chunk buffer,
// capped at 75. An 8m29s Google Meet call was promised "about 1 min" and took
// ten. A number that wrong is worse than no number, because the user reads a
// working job as a hung one.
//
// This measures instead. Every finalize records the window it actually ran for
// (FinalizeJob.startedAt → completedAt), so the cost of processing a second of
// audio is a fact about this account's own recordings rather than a guess, and
// it tracks whatever the machine, the providers and the meeting lengths are
// actually doing.
import { prisma } from '@/lib/db';
import { FALLBACK_RATIO } from '@/lib/estimate';

// Ratios outside this band are not measurements, they are artefacts: a job that
// was retried hours later, or a clock skew. Excluded so one bad row cannot
// drag the median.
const MIN_RATIO = 0.05;
const MAX_RATIO = 20;
const SAMPLE_SIZE = 20;
// Recordings this short are all fixed overhead and say nothing about throughput.
const MIN_AUDIO_S = 60;

const cache = new Map<string, { ratio: number; expires: number }>();
const TTL_MS = 5 * 60 * 1000;

/**
 * Processing seconds per second of audio for this account, as a median over
 * recent completed recordings.
 *
 * Median rather than mean: one recording that sat in a retry queue overnight
 * would otherwise poison the estimate for every recording after it.
 *
 * Falls back to the shared constant until the account has history, which for a
 * new user is the first recording only.
 */
export async function measuredRatio(userId: string | null): Promise<number> {
  const key = userId ?? '__all__';
  const hit = cache.get(key);
  if (hit && hit.expires > Date.now()) return hit.ratio;

  let ratio = FALLBACK_RATIO;
  try {
    // COALESCE lets recordings finalized before these columns existed still
    // contribute: their processing window is bracketed by the last chunk
    // arriving and the job row's last write.
    const rows = await prisma.$queryRaw<Array<{ audio: number; secs: number | null }>>`
      SELECT r."duration"::float AS audio,
             EXTRACT(EPOCH FROM (
               COALESCE(j."completedAt", j."updatedAt") - COALESCE(j."startedAt", c.last_chunk)
             ))::float AS secs
        FROM "Recording" r
        JOIN "FinalizeJob" j ON j."recordingId" = r."id"
        LEFT JOIN (
          SELECT "recordingId", MAX("createdAt") AS last_chunk
            FROM "ChunkBlob" GROUP BY "recordingId"
        ) c ON c."recordingId" = r."id"
       WHERE j."status" = 'completed'
         AND r."duration" > ${MIN_AUDIO_S}
         AND (${userId}::text IS NULL OR r."userId" = ${userId}::text)
       ORDER BY r."createdAt" DESC
       LIMIT ${SAMPLE_SIZE}
    `;
    const ratios = rows
      .filter((r) => r.secs != null && r.audio > 0)
      .map((r) => (r.secs as number) / r.audio)
      .filter((n) => Number.isFinite(n) && n >= MIN_RATIO && n <= MAX_RATIO)
      .sort((a, b) => a - b);
    if (ratios.length) ratio = ratios[Math.floor(ratios.length / 2)];
  } catch {
    // No history, or the columns are not there yet. The constant is correct
    // enough to show, and the next completed recording starts the measurement.
  }

  cache.set(key, { ratio, expires: Date.now() + TTL_MS });
  return ratio;
}
