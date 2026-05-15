import { writeFile, unlink } from 'fs/promises';
import os from 'os';
import path from 'path';
import { transcribeAudio } from '@/lib/ai';
import type { RawSegment } from '@/lib/ai';
import { isDeepgramReady, transcribeWithDeepgram } from '@/lib/deepgram';
import type { DeepgramRawSegment } from '@/lib/deepgram';

export const MAX_CHUNK_ATTEMPTS = 4;

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
  const ext = mimeType.includes('mp4') ? '.mp4' : mimeType.includes('ogg') ? '.ogg' : '.webm';
  return transcribeChunkWithRetry(audioData, ext);
}

export async function transcribeChunk(
  audioData: Buffer,
  mimeType: string,
): Promise<{ text: string; segments: RawSegment[] | DeepgramRawSegment[] }> {
  if (isDeepgramReady) {
    const result = await transcribeChunkWithDeepgramRetry(audioData, mimeType);
    return { text: result.text, segments: 'segments' in result ? result.segments : result.rawSegments };
  }
  const ext = mimeType.includes('mp4') ? '.mp4' : mimeType.includes('ogg') ? '.ogg' : '.webm';
  const result = await transcribeChunkWithRetry(audioData, ext);
  return { text: result.text, segments: result.rawSegments };
}
