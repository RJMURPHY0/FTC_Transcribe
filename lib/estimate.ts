// Lightweight, dependency-free helpers safe to import into server components.
// Kept separate from lib/finalize-recording so pages don't pull the native
// transcription/voice-id chain (sherpa-onnx, onnxruntime) into their render
// tree — that chain crashes the Next.js render worker locally.

/**
 * Fallback estimate for a recording with no measured history to learn from.
 *
 * Deliberately pessimistic. The previous constant (45s plus a small per-chunk
 * buffer, capped at 75s) told a user "about 1 min" for an 8-minute meeting
 * that then took ten, and a promise that is 10x short reads as a hang. The
 * ratio below is the conservative end of what real recordings actually cost,
 * and it is only ever used until this account has completed one recording,
 * after which measured throughput takes over.
 */
export function estimateSeconds(chunkCount: number, audioSeconds = 0): number {
  const audio = audioSeconds > 0 ? audioSeconds : chunkCount * CHUNK_AUDIO_S;
  return Math.round(BASE_OVERHEAD_S + audio * FALLBACK_RATIO);
}

/** A full chunk is ~2 minutes of audio, so chunk count estimates length. */
const CHUNK_AUDIO_S = 120;
/** Fixed cost per run: model load, the AI analysis pass, the summary write. */
const BASE_OVERHEAD_S = 60;
/** Processing seconds per second of audio, before we have measurements. */
const FALLBACK_RATIO = 1.2;

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
 * `ratio` is this account's measured processing-seconds per audio-second. The
 * elapsed time of the current run is subtracted, and the result is floored at
 * a few seconds rather than zero so a slow run degrades to "nearly there"
 * instead of "0s" followed by more waiting.
 */
export function remainingSeconds(
  audioSeconds: number,
  ratio: number,
  elapsedSeconds: number,
): number {
  const total = BASE_OVERHEAD_S + Math.max(0, audioSeconds) * ratio;
  return Math.max(5, Math.round(total - Math.max(0, elapsedSeconds)));
}

export function formatEta(seconds: number): string {
  if (seconds <= 0) return '';
  if (seconds < 60) return 'less than a minute';
  const mins = Math.round(seconds / 60);
  return mins === 1 ? 'about 1 min' : `about ${mins} min`;
}

export { FALLBACK_RATIO, BASE_OVERHEAD_S, CHUNK_AUDIO_S };
