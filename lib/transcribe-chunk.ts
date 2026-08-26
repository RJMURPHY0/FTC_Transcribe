import { writeFile, unlink } from 'fs/promises';
import os from 'os';
import path from 'path';
import { transcribeAudio } from '@/lib/ai';
import type { RawSegment } from '@/lib/ai';
import { isDeepgramReady, transcribeWithDeepgram } from '@/lib/deepgram';
import type { DeepgramRawSegment } from '@/lib/deepgram';
import { analyzeChunkVoices, isVoiceIdEnabled, splitChannelsToWav } from '@/lib/voice-id';
import type { ChunkVoiceData } from '@/lib/voice-id';

export const MAX_CHUNK_ATTEMPTS = 4;

// Transcribe each side of an online meeting separately and merge on the shared
// timeline. Crosstalk then reads as two clean overlapping lines instead of one
// garbled one, and each side is transcribed without the other bleeding into it.
//
// The cost is one extra transcription call per meeting chunk. In-person
// recordings are single-channel and never take this path, so they are
// unaffected. Set MEETING_DUAL_TRANSCRIBE=false to fall back to a single pass
// over the mixed audio if that cost ever stops being worth it.
const DUAL_TRANSCRIBE = process.env.MEETING_DUAL_TRANSCRIBE !== 'false';

type Channel = 'mic' | 'system';
type TaggedSegment = { start: number; end: number; text: string; speaker?: number | string; channel?: Channel };

function extForMime(mimeType: string): string {
  return mimeType.includes('mp4') ? '.mp4'
    : mimeType.includes('ogg') ? '.ogg'
    : mimeType.includes('wav') ? '.wav'
    : mimeType.includes('mpeg') ? '.mp3'
    : mimeType.includes('m4a') ? '.m4a'
    : '.webm';
}

export async function withTempFile<T>(
  data: Buffer,
  ext: string,
  fn: (filePath: string) => Promise<T>,
): Promise<T> {
  const tempPath = path.join(os.tmpdir(), `chunk-${Date.now()}-${Math.random().toString(36).slice(2)}${ext}`);
  await writeFile(tempPath, data);
  try {
    return await fn(tempPath);
  } finally {
    await unlink(tempPath).catch(() => {});
  }
}

export async function transcribeChunkWithRetry(audioData: Buffer, ext: string) {
  let lastErr: Error = new Error('Transcription failed');

  for (let attempt = 0; attempt < MAX_CHUNK_ATTEMPTS; attempt++) {
    if (attempt > 0) {
      await new Promise((r) => setTimeout(r, 2000 * Math.pow(2, attempt - 1)));
    }
    try {
      return await withTempFile(audioData, ext, (filePath) => transcribeAudio(filePath));
    } catch (err) {
      lastErr = err instanceof Error ? err : new Error('Transcription error');
      console.warn(`[transcribe-chunk] attempt ${attempt + 1}/${MAX_CHUNK_ATTEMPTS} failed:`, lastErr.message);
    }
  }

  throw lastErr;
}

export async function transcribeChunkWithDeepgramRetry(
  audioData: Buffer,
  mimeType: string,
): Promise<{ text: string; segments: DeepgramRawSegment[] } | { text: string; rawSegments: RawSegment[]; language: string }> {
  let lastErr: Error = new Error('Deepgram failed');

  for (let attempt = 0; attempt < MAX_CHUNK_ATTEMPTS; attempt++) {
    if (attempt > 0) await new Promise(r => setTimeout(r, 2000 * Math.pow(2, attempt - 1)));
    try {
      return await transcribeWithDeepgram(audioData, mimeType);
    } catch (err) {
      lastErr = err instanceof Error ? err : new Error('Deepgram error');
      console.warn(`[transcribe-chunk] Deepgram attempt ${attempt + 1}/${MAX_CHUNK_ATTEMPTS} failed:`, lastErr.message);
    }
  }

  console.warn('[transcribe-chunk] Deepgram failed after retries, falling back to Groq/OpenAI');
  return transcribeChunkWithRetry(audioData, extForMime(mimeType));
}

// Whisper has no concept of silence. Handed a channel that is mostly quiet —
// which is exactly what your own microphone looks like on a call, since you
// spend most of it listening — it transcribes the speech and lays the
// timestamps out as though that speech ran continuously from zero.
//
// Measured on a real Google Meet recording (cmt9xwh4t, 26 Aug 2026): on one
// chunk the ASR put the first words at 0.0s while the diarizer, reading the
// waveform, found no speech until 19.3s. The transcript then interleaves the
// two sides in the wrong order and click-to-seek lands nowhere near the line
// you clicked.
//
// The diarizer already knows where the speech actually is, and already runs on
// every chunk, so no new provider or extra cost is needed to fix this: map the
// ASR's own speech timeline onto the true one. Deepgram, which does handle
// silence, produces a near-identity map and is left alone by the drift gate.
const ANCHOR_DRIFT_S = parseFloat(process.env.VOICE_ANCHOR_DRIFT_S ?? '1.5');
const ANCHOR_TOTAL_DRIFT = parseFloat(process.env.VOICE_ANCHOR_TOTAL_DRIFT ?? '0.25');

interface Span { start: number; end: number }

function mergeSpans(spans: Array<{ start: number; end: number }>): Span[] {
  const sorted = spans.filter((s) => s.end > s.start)
    .map((s) => ({ start: s.start, end: s.end }))
    .sort((a, b) => a.start - b.start);
  const out: Span[] = [];
  for (const s of sorted) {
    const last = out[out.length - 1];
    if (last && s.start <= last.end) last.end = Math.max(last.end, s.end);
    else out.push(s);
  }
  return out;
}

/** Seconds of speech lying before `t`. */
function speechBefore(spans: Span[], t: number): number {
  let acc = 0;
  for (const s of spans) {
    if (t <= s.start) break;
    acc += Math.min(t, s.end) - s.start;
    if (t < s.end) break;
  }
  return acc;
}

/** The inverse: wall-clock time at which `c` seconds of speech have elapsed. */
function timeAtSpeech(spans: Span[], c: number): number {
  let acc = 0;
  for (const s of spans) {
    const d = s.end - s.start;
    if (c <= acc + d) return s.start + (c - acc);
    acc += d;
  }
  return spans.length ? spans[spans.length - 1].end : 0;
}

/**
 * Re-time one channel's ASR segments against the diarizer's speech regions for
 * the same channel.
 *
 * Both timelines describe the same words, so a segment's position measured in
 * *elapsed speech* is trustworthy in either even when its wall-clock position
 * is not. Converting between them through that shared coordinate is monotone,
 * which matters: it can reorder nothing and cannot make two segments overlap
 * that did not already.
 *
 * Left alone unless the correction is worth more than the risk of applying it,
 * so an ASR that already timed the channel correctly is passed through
 * untouched rather than nudged.
 */
export function anchorSegmentsToSpeech<T extends { start: number; end: number }>(
  segments: T[],
  turns: Array<{ start: number; end: number }>,
): T[] {
  if (!segments.length || !turns.length) return segments;
  const truth = mergeSpans(turns);
  const asr = mergeSpans(segments);
  const truthTotal = truth.reduce((n, s) => n + (s.end - s.start), 0);
  const asrTotal = asr.reduce((n, s) => n + (s.end - s.start), 0);
  if (truthTotal <= 0 || asrTotal <= 0) return segments;

  // Only correct a channel that shows the actual symptom, so a side the ASR
  // already timed well is never nudged for the sake of it. Collapsed silence
  // shows up two ways: speech that starts earlier than any speech exists, and
  // a speech total that cannot be reconciled with the waveform's.
  const leadDrift = Math.abs(truth[0].start - asr[0].start);
  const totalDrift = Math.abs(truthTotal - asrTotal) / truthTotal;
  if (leadDrift < ANCHOR_DRIFT_S && totalDrift < ANCHOR_TOTAL_DRIFT) return segments;

  const map = (t: number) => timeAtSpeech(truth, (speechBefore(asr, t) / asrTotal) * truthTotal);

  let maxShift = 0;
  for (const s of segments) {
    maxShift = Math.max(maxShift, Math.abs(map(s.start) - s.start), Math.abs(map(s.end) - s.end));
  }
  if (maxShift < ANCHOR_DRIFT_S) return segments;

  return segments.map((s) => {
    const start = map(s.start);
    const end = Math.max(start + 0.05, map(s.end));
    return { ...s, start: Math.round(start * 100) / 100, end: Math.round(end * 100) / 100 };
  });
}

/** One side of a dual-channel meeting, through the normal provider routing. */
async function transcribeSide(
  wav: Buffer,
  channel: Channel,
): Promise<{ text: string; segments: TaggedSegment[]; language: string }> {
  const result = isDeepgramReady
    ? await transcribeChunkWithDeepgramRetry(wav, 'audio/wav')
    : await transcribeChunkWithRetry(wav, '.wav');
  const segments = ('segments' in result ? result.segments : result.rawSegments) as TaggedSegment[];
  return {
    text: result.text,
    segments: segments.map((s) => ({ ...s, channel })),
    language: 'language' in result ? result.language : '',
  };
}

export async function transcribeChunk(
  audioData: Buffer,
  mimeType: string,
): Promise<{ text: string; segments: RawSegment[] | DeepgramRawSegment[]; voiceData: ChunkVoiceData | null; language: string }> {
  // Acoustic voice analysis (diarization + voiceprints) runs in parallel with
  // transcription — it reads the waveform, not the text. Never blocks or fails the chunk.
  const voicePromise: Promise<ChunkVoiceData | null> = isVoiceIdEnabled
    ? analyzeChunkVoices(audioData, mimeType).catch(() => null)
    : Promise.resolve(null);

  // Online meeting captured as mic-plus-call? Detected from the audio, never
  // from what the client claimed it recorded.
  if (DUAL_TRANSCRIBE) {
    const split = await splitChannelsToWav(audioData, mimeType).catch(() => null);
    if (split) {
      try {
        const [mic, system] = await Promise.all([
          transcribeSide(split.mic, 'mic'),
          transcribeSide(split.system, 'system'),
        ]);
        // Anchor each side to its own diarized speech before merging. Doing it
        // per channel matters: the call channel is dense and usually needs no
        // correction, while the microphone channel is mostly silence and
        // usually does.
        const voiceData = await voicePromise;
        const turnsOn = (channel: Channel) =>
          (voiceData?.turns ?? []).filter((t) => t.channel === channel);
        const segments = [
          ...anchorSegmentsToSpeech(mic.segments, turnsOn('mic')),
          ...anchorSegmentsToSpeech(system.segments, turnsOn('system')),
        ].sort((a, b) => a.start - b.start);
        const text = segments.map((s) => s.text.trim()).filter(Boolean).join(' ');
        return {
          text,
          segments: segments as RawSegment[] | DeepgramRawSegment[],
          voiceData,
          language: mic.language || system.language,
        };
      } catch (err) {
        // One side failed: fall through to a single pass over the mixed audio
        // rather than losing the chunk. Diarisation is unaffected either way.
        console.warn('[transcribe-chunk] per-channel transcription failed, using mixed audio:',
          err instanceof Error ? err.message : err);
      }
    }
  }

  if (isDeepgramReady) {
    const result = await transcribeChunkWithDeepgramRetry(audioData, mimeType);
    return {
      text: result.text,
      segments: 'segments' in result ? result.segments : result.rawSegments,
      voiceData: await voicePromise,
      language: 'language' in result ? result.language : '',
    };
  }
  const result = await transcribeChunkWithRetry(audioData, extForMime(mimeType));
  return { text: result.text, segments: result.rawSegments, voiceData: await voicePromise, language: result.language };
}
