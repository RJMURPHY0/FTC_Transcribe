import { writeFile, unlink } from 'fs/promises';
import os from 'os';
import path from 'path';
import { transcribeAudio } from '@/lib/ai';
import type { RawSegment } from '@/lib/ai';
import { isDeepgramReady, transcribeWithDeepgram } from '@/lib/deepgram';
import type { DeepgramRawSegment } from '@/lib/deepgram';
import { analyzeChunkVoices, isVoiceIdEnabled } from '@/lib/voice-id';
import type { ChunkVoiceData } from '@/lib/voice-id';

export const MAX_CHUNK_ATTEMPTS = 4;

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
): Promise<{ text: string; segments: DeepgramRawSegment[] } | { text: string; rawSegments: RawSegment[] }> {
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

export async function transcribeChunk(
  audioData: Buffer,
  mimeType: string,
): Promise<{ text: string; segments: RawSegment[] | DeepgramRawSegment[]; voiceData: ChunkVoiceData | null }> {
  // Acoustic voice analysis (diarization + voiceprints) runs in parallel with
  // transcription — it reads the waveform, not the text. Never blocks or fails the chunk.
  const voicePromise: Promise<ChunkVoiceData | null> = isVoiceIdEnabled
    ? analyzeChunkVoices(audioData, mimeType).catch(() => null)
    : Promise.resolve(null);

  if (isDeepgramReady) {
    const result = await transcribeChunkWithDeepgramRetry(audioData, mimeType);
    return {
      text: result.text,
      segments: 'segments' in result ? result.segments : result.rawSegments,
      voiceData: await voicePromise,
    };
  }
  const result = await transcribeChunkWithRetry(audioData, extForMime(mimeType));
  return { text: result.text, segments: result.rawSegments, voiceData: await voicePromise };
}
