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
        const segments = [...mic.segments, ...system.segments].sort((a, b) => a.start - b.start);
        const text = segments.map((s) => s.text.trim()).filter(Boolean).join(' ');
        return {
          text,
          segments: segments as RawSegment[] | DeepgramRawSegment[],
          voiceData: await voicePromise,
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
