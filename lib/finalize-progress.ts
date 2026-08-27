// How long will this take, really?
//
// The first answer was a constant: 45 seconds plus a small per-chunk buffer,
// capped at 75. The second was a measured ratio of processing-seconds per
// second of audio. Both were wrong, and the second was wrong in a way the
// first was not: the wait does not scale with meeting length at all. A
// 51-minute recording finalised in 48s while a 27-minute one took 257s, because
// the second still had chunks left to transcribe and the first did not.
//
// So measure the two things the wait is genuinely made of, and measure them
// separately. Both come out of rows the app already writes:
//
//   perChunkS   ChunkTranscript.createdAt -> processedAt
//               (median 38.6s over 398 real chunks on 27 Aug 2026)
//   analysisS   FinalizeJob.completedAt - MAX(chunk.processedAt)
//               (11.5s and 12.9s on the two jobs that carry the timestamps)
//
// The old MIN_RATIO of 0.05 is gone with the ratio it guarded. It was actively
// harmful: it discarded the single fastest real measurement on the account as
// an "artefact", leaving zero usable samples and a permanent fall back to a
// constant that was 20x high.
import { prisma } from '@/lib/db';
import {
  FALLBACK_PER_CHUNK_S,
  FALLBACK_ANALYSIS_S,
  DEFAULT_PARALLEL_CHUNKS,
  type FinalizeCost,
} from '@/lib/estimate';

// Bounds exist to reject clock skew and jobs resumed hours later, not to reject
// fast work. They are set wide enough that a genuinely quick run still counts.
const MIN_CHUNK_S = 0.5;
const MAX_CHUNK_S = 600;
const MIN_ANALYSIS_S = 1;
const MAX_ANALYSIS_S = 1800;
const CHUNK_SAMPLE = 200;
const JOB_SAMPLE = 20;
/** Below this many personal samples, borrow the deployment-wide figure. */
const MIN_PERSONAL_SAMPLES = 5;

const cache = new Map<string, { cost: FinalizeCost; expires: number }>();
const TTL_MS = 5 * 60 * 1000;

function median(values: number[]): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

function parallelism(): number {
  const raw = parseInt(process.env.FINALIZE_PARALLEL_CHUNKS ?? '', 10);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_PARALLEL_CHUNKS;
}

/**
 * Measured cost of finalising, for this user where there is enough of their own
 * history and for the deployment as a whole otherwise.
 *
 * A new customer inherits the platform's measured speed rather than a made-up
 * constant, which matters because the very first recording is the one where a
 * wrong number does the most damage to trust.
 */
export async function measuredCost(userId: string | null): Promise<FinalizeCost> {
  const key = userId ?? '__all__';
  const hit = cache.get(key);
  if (hit && hit.expires > Date.now()) return hit.cost;

  const parallel = parallelism();
  let perChunkS = FALLBACK_PER_CHUNK_S;
  let analysisS = FALLBACK_ANALYSIS_S;

  try {
    // ── Per-chunk transcription ──────────────────────────────────────────────
    // Prefer this user's own chunks; fall back to everyone's when they have too
    // few to be meaningful.
    const chunkRows = await prisma.$queryRaw<Array<{ secs: number | null; mine: boolean }>>`
      SELECT EXTRACT(EPOCH FROM (ct."processedAt" - ct."createdAt"))::float AS secs,
             (r."userId" IS NOT DISTINCT FROM ${userId}::text)              AS mine
        FROM "ChunkTranscript" ct
        JOIN "Recording" r ON r."id" = ct."recordingId"
       WHERE ct."status" = 'succeeded' AND ct."processedAt" IS NOT NULL
       ORDER BY ct."createdAt" DESC
       LIMIT ${CHUNK_SAMPLE}
    `;
    const usable = (rows: Array<{ secs: number | null }>) => rows
      .map((r) => r.secs)
      .filter((n): n is number => n != null && Number.isFinite(n) && n >= MIN_CHUNK_S && n <= MAX_CHUNK_S);

    const mine = usable(chunkRows.filter((r) => r.mine));
    const all = usable(chunkRows);
    const chunkMedian = mine.length >= MIN_PERSONAL_SAMPLES ? median(mine) : median(all);
    if (chunkMedian != null) perChunkS = chunkMedian;

    // ── Analysis tail ────────────────────────────────────────────────────────
    // Time between the last chunk finishing and the job completing: diarisation,
    // the notes call, and the summary write. Independent of meeting length,
    // which is exactly why it must not be folded into a per-second ratio.
    const jobRows = await prisma.$queryRaw<Array<{ secs: number | null }>>`
      SELECT EXTRACT(EPOCH FROM (j."completedAt" - c.last_done))::float AS secs
        FROM "FinalizeJob" j
        JOIN "Recording" r ON r."id" = j."recordingId"
        JOIN (
          SELECT "jobId", MAX("processedAt") AS last_done
            FROM "ChunkTranscript" WHERE "processedAt" IS NOT NULL GROUP BY "jobId"
        ) c ON c."jobId" = j."id"
       WHERE j."status" = 'completed'
         AND j."completedAt" IS NOT NULL
         AND (${userId}::text IS NULL OR r."userId" = ${userId}::text)
       ORDER BY j."updatedAt" DESC
       LIMIT ${JOB_SAMPLE}
    `;
    const analysisSamples = jobRows
      .map((r) => r.secs)
      .filter((n): n is number => n != null && Number.isFinite(n) && n >= MIN_ANALYSIS_S && n <= MAX_ANALYSIS_S);
    const analysisMedian = median(analysisSamples);
    if (analysisMedian != null) analysisS = analysisMedian;
  } catch (err) {
    // No history yet, or the timestamp columns are not there. The measured
    // fallbacks are honest numbers, and the next completed recording refines
    // them.
    console.warn('[finalize-progress] falling back to default cost:', err instanceof Error ? err.message : err);
  }

  const cost: FinalizeCost = { perChunkS, analysisS, parallel };
  cache.set(key, { cost, expires: Date.now() + TTL_MS });
  return cost;
}
