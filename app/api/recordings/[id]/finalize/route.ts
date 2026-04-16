import { NextRequest, NextResponse } from 'next/server';
import { writeFile, unlink } from 'fs/promises';
import path from 'path';
import os from 'os';
import { prisma } from '@/lib/db';
import {
  transcribeAudio,
  diarizeSegments,
  analyzeTranscript,
  generateTitle,
  generateTopics,
} from '@/lib/ai';
import type { RawSegment } from '@/lib/ai';

export const dynamic = 'force-dynamic';
export const maxDuration = 300;

const CUID_RE = /^c[a-z0-9]{20,}$/;

/** Write bytes to a temp file, call fn, then always unlink */
async function withTempFile<T>(
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

/** Transcribe one chunk with up to maxAttempts retries and exponential backoff */
async function transcribeChunkWithRetry(
  audioData: Buffer,
  ext: string,
  maxAttempts = 4,
): Promise<{ text: string; rawSegments: RawSegment[] }> {
  let lastErr: Error = new Error('Transcription failed');
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    if (attempt > 0) {
      // Exponential backoff: 2s, 4s, 8s
      await new Promise((r) => setTimeout(r, 2000 * Math.pow(2, attempt - 1)));
    }
    try {
      const result = await withTempFile(audioData, ext, (fp) => transcribeAudio(fp));
      return result;
    } catch (err) {
      lastErr = err instanceof Error ? err : new Error('Transcription error');
      console.warn(`[finalize] chunk transcription attempt ${attempt + 1}/${maxAttempts} failed:`, lastErr.message);
    }
  }
  throw lastErr;
}

export async function POST(
  _request: NextRequest,
  { params }: { params: { id: string } },
) {
  if (!CUID_RE.test(params.id)) {
    return NextResponse.json({ error: 'Invalid recording ID.' }, { status: 400 });
  }

  // Mark as processing immediately
  await prisma.recording.update({
    where: { id: params.id },
    data:  { status: 'processing' },
  }).catch(() => {});

  try {
    // ── Step 1: Transcribe any stored audio chunks ────────────────────────────
    //
    // Each chunk is retried independently — one bad chunk won't kill the whole
    // recording.  We only delete the raw audio AFTER all chunks are processed
    // so that the RetryButton can re-trigger finalize successfully.

    const chunks = await prisma.chunkBlob.findMany({
      where:   { recordingId: params.id },
      orderBy: { offset: 'asc' },
    });

    if (chunks.length > 0) {
      let fullText = '';
      const allSegments: RawSegment[] = [];
      const processedChunkIds: string[] = [];

      for (const chunk of chunks) {
        const ext = chunk.mimeType.includes('mp4') ? '.mp4'
                  : chunk.mimeType.includes('ogg') ? '.ogg'
                  : '.webm';

        try {
          const { text, rawSegments } = await transcribeChunkWithRetry(
            chunk.audioData as Buffer,
            ext,
          );

          // Skip empty/silence chunks — don't treat them as errors
          if (text.trim()) {
            const shifted: RawSegment[] = rawSegments.map((s) => ({
              start: s.start + chunk.offset,
              end:   s.end   + chunk.offset,
              text:  s.text,
            }));
            fullText += (fullText ? ' ' : '') + text.trim();
            allSegments.push(...shifted);
          }

          processedChunkIds.push(chunk.id);
        } catch (chunkErr) {
          // One chunk failed all retries — log it but continue with other chunks
          // rather than aborting the whole recording
          console.error(`[finalize] chunk ${chunk.id} failed permanently, skipping:`, chunkErr);
          processedChunkIds.push(chunk.id); // still mark as processed so we don't retry it forever
        }
      }

      if (fullText.trim()) {
        // Save / replace transcript
        const existing = await prisma.transcript.findUnique({ where: { recordingId: params.id } });
        if (existing) {
          await prisma.transcript.update({
            where: { recordingId: params.id },
            data:  { fullText, segments: JSON.stringify(allSegments) },
          });
        } else {
          await prisma.transcript.create({
            data: { recordingId: params.id, fullText, segments: JSON.stringify(allSegments) },
          });
        }
      }

      // Only delete chunks that were fully processed — this preserves any
      // chunks that might have been added during a concurrent upload
      if (processedChunkIds.length > 0) {
        await prisma.chunkBlob.deleteMany({
          where: { id: { in: processedChunkIds } },
        });
      }
    }

    // ── Step 2: Run AI analysis on the complete transcript ───────────────────

    const transcript = await prisma.transcript.findUnique({ where: { recordingId: params.id } });

    if (!transcript || !transcript.fullText.trim()) {
      await prisma.recording.update({ where: { id: params.id }, data: { status: 'failed' } }).catch(() => {});
      return NextResponse.json({ error: 'No transcript to analyse.' }, { status: 422 });
    }

    const rawSegments: RawSegment[] = JSON.parse(transcript.segments);

    const [diarized, analysis, shortTitle, topics] = await Promise.all([
      diarizeSegments(rawSegments),
      analyzeTranscript(transcript.fullText),
      generateTitle(transcript.fullText),
      generateTopics(rawSegments),
    ]);

    const dateStr = new Date().toLocaleDateString('en-GB', {
      day: 'numeric', month: 'short', year: 'numeric',
    });
    const title = shortTitle ? `${shortTitle} – ${dateStr}` : null;

    await prisma.transcript.update({
      where: { recordingId: params.id },
      data:  { segments: JSON.stringify(diarized) },
    });

    await prisma.summary.upsert({
      where:  { recordingId: params.id },
      create: {
        recordingId: params.id,
        overview:    analysis.overview,
        keyPoints:   JSON.stringify(analysis.keyPoints),
        actionItems: JSON.stringify(analysis.actionItems),
        decisions:   JSON.stringify(analysis.decisions),
        topics:      JSON.stringify(topics),
      },
      update: {
        overview:    analysis.overview,
        keyPoints:   JSON.stringify(analysis.keyPoints),
        actionItems: JSON.stringify(analysis.actionItems),
        decisions:   JSON.stringify(analysis.decisions),
        topics:      JSON.stringify(topics),
      },
    });

    await prisma.recording.update({
      where: { id: params.id },
      data:  { status: 'completed', ...(title ? { title } : {}) },
    });

    return NextResponse.json({ ok: true });
  } catch (error) {
    console.error('[finalize]', error);
    await prisma.recording.update({
      where: { id: params.id },
      data:  { status: 'failed' },
    }).catch(() => {});
    return NextResponse.json({ error: 'Finalization failed.' }, { status: 500 });
  }
}
