// Lightweight, dependency-free helpers safe to import into server components.
// Kept separate from lib/finalize-recording so pages don't pull the native
// transcription/voice-id chain (sherpa-onnx, onnxruntime) into their render
// tree — that chain crashes the Next.js render worker locally.

// ── What the wait is actually made of ────────────────────────────────────────
//
// The old model was one number: processing-seconds per second of audio. It was
// wrong in shape, not just in calibration, and it produced "about 88 min" for a
// 31-minute meeting that needed about four.
//
// Measured over 398 real chunks and the completed jobs on 27 Aug 2026:
//
//   transcribing one ~45s chunk   median 38.6s   (p10 23.4, p90 73.1)
//   analysis after the last chunk        ~13s    (11.5s and 12.9s)
//
// Chunks are transcribed in the background as they upload, so by the time
// finalize runs there is usually nothing left to transcribe and the wait is a
// near-constant tail. That is why the cost does NOT scale with meeting length:
// a 51-minute recording finalised in 48s while a 27-minute one took 257s,
// because the second still had chunks outstanding. What the wait scales with is
// the number of chunks still OUTSTANDING, divided by how many are transcribed
// at once.
//
//   wait = ceil(pending / parallel) x perChunk + analysis + overhead
//
// Every term is measured from this deployment's own history (lib/finalize-
// progress.ts). The constants below are only the cold-start values used before
// there is any history to read, and they are set to what was measured rather
// than to a pessimistic guess.

/** Transcribing one chunk, before this deployment has measurements. */
export const FALLBACK_PER_CHUNK_S = 40;
/** Diarisation, notes and the summary write, after the last chunk lands. */
export const FALLBACK_ANALYSIS_S = 15;
/** Lock, audio archive, DB writes. Present on every run whatever its size. */
export const BASE_OVERHEAD_S = 20;
/** Chunks transcribed concurrently. Mirrors FINALIZE_PARALLEL_CHUNKS. */
export const DEFAULT_PARALLEL_CHUNKS = 8;

export interface FinalizeCost {
  perChunkS: number;
  analysisS: number;
  parallel: number;
}

export const FALLBACK_COST: FinalizeCost = {
  perChunkS: FALLBACK_PER_CHUNK_S,
  analysisS: FALLBACK_ANALYSIS_S,
  parallel: DEFAULT_PARALLEL_CHUNKS,
};

/**
 * How long finalising will take, given how much is left to transcribe.
 *
 * `pendingChunks` is a count of real work, not an inference from meeting
 * length. When background transcription has kept up it is zero and the answer
 * is the fixed tail, which is the common case and the one the old estimate got
 * most wrong.
 */
export function estimateFinalizeSeconds(pendingChunks: number, cost: FinalizeCost = FALLBACK_COST): number {
  const parallel = Math.max(1, cost.parallel);
  const batches = Math.ceil(Math.max(0, pendingChunks) / parallel);
  return Math.round(batches * cost.perChunkS + cost.analysisS + BASE_OVERHEAD_S);
}

/**
 * Estimate for a recording that has not been analysed yet, from chunk counts
 * alone.
 *
 * Used by the recordings list, where a queued row knows how many chunks it has
 * and how many are already transcribed but nothing about phase.
 */
export function estimateSeconds(chunkCount: number, chunksDone = 0, cost: FinalizeCost = FALLBACK_COST): number {
  return estimateFinalizeSeconds(Math.max(0, chunkCount - chunksDone), cost);
}

/**
 * True length of the captured audio, in seconds.
 *
 * `duration` is only written at finalize, so it is 0 for the entire time a user
 * is actually waiting and watching. The chunk offsets carry the real timeline
 * throughout, and the last chunk's own length is the one unknown — assume a
 * full rotation rather than zero, so the figure never reads short.
 *
 * The previous fallback multiplied chunk count by a flat 120s. Real rotation is
 * 45s on mobile and 120s on desktop, and measured spacing across the last ten
 * recordings was 43 to 55s, so that overstated a phone recording by ~2.7x.
 */
export function audioSecondsFrom(
  duration: number,
  maxOffset: number | null,
  chunkCount: number,
): number {
  if (duration > 0) return duration;
  if (maxOffset !== null && maxOffset > 0 && chunkCount > 1) {
    // Mean spacing across the chunks we have is the best available read of the
    // rotation this particular client is using.
    const spacing = maxOffset / (chunkCount - 1);
    return Math.round(maxOffset + spacing);
  }
  return Math.max(0, chunkCount) * 45;
}

// ── Phases ───────────────────────────────────────────────────────────────────
//
// Weights are the share of total processing each phase takes, so the bar moves
// at a roughly even pace instead of sitting at 10% and then jumping to done.
// Transcription dominates whenever background transcription did not keep up;
// when it did, that phase passes in seconds and the bar simply moves on.

export type FinalizeStage = 'queued' | 'transcribing' | 'diarising' | 'analysing' | 'done';

const STAGE_ORDER: FinalizeStage[] = ['queued', 'transcribing', 'diarising', 'analysing', 'done'];

const STAGE_WEIGHT: Record<FinalizeStage, number> = {
  queued: 0.05,
  transcribing: 0.45,
  diarising: 0.2,
  analysing: 0.3,
  done: 0,
};

export const STAGE_LABEL: Record<FinalizeStage, string> = {
  queued: 'Queued',
  transcribing: 'Transcribing audio',
  diarising: 'Separating speakers',
  analysing: 'Writing notes',
  done: 'Done',
};

export function asStage(raw: string | null | undefined, status: string): FinalizeStage {
  if (status === 'completed') return 'done';
  const s = (raw ?? '') as FinalizeStage;
  return STAGE_ORDER.includes(s) && s !== 'done' ? s : 'queued';
}

/**
 * Fraction complete, 0..1.
 *
 * Two sources of sub-progress inside a phase, and the better one wins:
 *
 *  - Chunk counts, during transcription. Real work, really counted.
 *  - Elapsed time against the expected total, everywhere else. Diarisation and
 *    the AI pass are each one long call with nothing to count, and a bar that
 *    sits motionless for four minutes reads as a hang, which is the thing this
 *    whole change exists to stop.
 *
 * Time-based fill is clamped to the current phase's own share, so it can run
 * ahead within a phase but can never claim a phase that has not started.
 * Nothing but a finished job returns 1: a full bar over a page still saying
 * "writing notes" is a worse lie than a bar resting at 97%.
 */
export function stageProgress(
  stage: FinalizeStage,
  chunksDone: number,
  chunksTotal: number,
  timeFraction = 0,
): number {
  if (stage === 'done') return 1;
  let acc = 0;
  for (const s of STAGE_ORDER) {
    if (s === stage) break;
    acc += STAGE_WEIGHT[s];
  }
  const weight = STAGE_WEIGHT[stage];
  const byTime = weight > 0
    ? Math.min(1, Math.max(0, (timeFraction - acc) / weight))
    : 0;
  const byChunks = stage === 'transcribing' && chunksTotal > 0
    ? Math.min(1, chunksDone / chunksTotal)
    : 0;
  return Math.min(0.97, acc + weight * Math.max(byTime, byChunks));
}

/**
 * Seconds still to go.
 *
 * Built from the work that is actually outstanding, minus how long this run has
 * already been going. Floored at a few seconds rather than zero so a slow run
 * degrades to "nearly there" instead of "0s" followed by more waiting.
 */
export function remainingSeconds(
  pendingChunks: number,
  cost: FinalizeCost,
  elapsedSeconds: number,
): number {
  const total = estimateFinalizeSeconds(pendingChunks, cost);
  return Math.max(5, Math.round(total - Math.max(0, elapsedSeconds)));
}

export function formatEta(seconds: number): string {
  if (seconds <= 0) return '';
  if (seconds < 60) return 'less than a minute';
  const mins = Math.round(seconds / 60);
  return mins === 1 ? 'about 1 min' : `about ${mins} min`;
}
