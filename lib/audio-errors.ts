// Is this chunk's failure worth retrying, or is the audio simply unusable?
//
// Dependency-free on purpose. The answer is needed by the upload route, the
// finalize pipeline and the recovery script, and importing it must never drag
// in the native voice-id chain (sherpa-onnx, onnxruntime) behind it.
//
// The distinction is not cosmetic. Recording cmtbd1od3 (27 Aug 2026) lost a
// finished 31-minute transcript because one 25KB pause-flush tail returned
// "400 Audio file is too short" and was treated as a transient failure: four
// retries per pass, nine passes of the cron, and a recording marked failed
// while 44 of its 45 chunks sat transcribed in the database.

/** A chunk the provider will never accept, however many times it is asked. */
export class PermanentAudioError extends Error {
  readonly permanent = true as const;
  constructor(message: string) {
    super(message);
    this.name = 'PermanentAudioError';
  }
}

// Message-level signatures, for providers that flatten the status into text.
// Kept narrow: anything ambiguous should be retried, because wrongly calling a
// transient failure permanent silently drops real audio.
const PERMANENT_MESSAGE = /audio file is too short|minimum audio length|too short|invalid file format|could not be decoded|unsupported file|unrecognized file format|file is empty|is not a valid/i;

/**
 * True when the bytes are the problem.
 *
 * 400 / 415 / 422 mean the request will not become valid by being repeated.
 * 429 and 5xx are the provider having a bad moment and DO deserve a retry, so
 * they deliberately fall through to false.
 */
export function isPermanentAudioError(err: unknown): boolean {
  if (err instanceof PermanentAudioError) return true;
  if (err == null || typeof err !== 'object') return false;
  const e = err as { status?: number; message?: string; permanent?: boolean };
  if (e.permanent === true) return true;
  if (e.status === 400 || e.status === 415 || e.status === 422) return true;
  return PERMANENT_MESSAGE.test(e.message ?? '');
}

/** Wrap a permanent provider rejection so callers upstream can skip, not retry. */
export function asPermanentAudioError(err: unknown): PermanentAudioError | null {
  if (!isPermanentAudioError(err)) return null;
  if (err instanceof PermanentAudioError) return err;
  return new PermanentAudioError(err instanceof Error ? err.message : 'Audio rejected by provider');
}
