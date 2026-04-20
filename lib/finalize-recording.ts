import { randomUUID } from 'crypto';
import { writeFile, unlink } from 'fs/promises';
import os from 'os';
import path from 'path';
import { prisma } from '@/lib/db';
import {
  transcribeAudio,
  diarizeSegments,
  analyzeTranscript,
  generateTitle,
  generateTopics,
} from '@/lib/ai';
import type { RawSegment } from '@/lib/ai';
import { backupToAirtable } from '@/lib/airtable-backup';

const LOCK_MS = 8 * 60 * 1000;
const MAX_CHUNK_ATTEMPTS = 4;
const PARALLEL_CHUNKS = 3; // transcribe up to 3 chunks simultaneously

// Estimated processing time in seconds for a given chunk count
export function estimateSeconds(chunkCount: number): number {
  if (chunkCount === 0) return 45;
  return Math.ceil(chunkCount / PARALLEL_CHUNKS) * 18 + 45;
}

async function runConcurrent<T>(tasks: (() => Promise<T>)[], limit: number): Promise<T[]> {
  const results: (T | undefined)[] = new Array(tasks.length);
  let idx = 0;
  async function worker() {
    while (idx < tasks.length) {
      const i = idx++;
      results[i] = await tasks[i]();
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, tasks.length) }, worker));
  return results as T[];
}

type FinalizeResult =
  | { ok: true; completed: true; failedChunks: 0; pendingChunks: 0 }
  | { ok: true; completed: false; failedChunks: number; pendingChunks: number; reason: string }
  | { ok: false; reason: string };

function isMissingFinalizeTablesError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return (
    message.includes('FinalizeJob')
    || message.includes('ChunkTranscript')
    || message.includes('relation "FinalizeJob" does not exist')
    || message.includes('relation "ChunkTranscript" does not exist')
  );
}

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

async function transcribeChunkWithRetry(audioData: Buffer, ext: string) {
  let lastErr: Error = new Error('Transcription failed');

  for (let attempt = 0; attempt < MAX_CHUNK_ATTEMPTS; attempt++) {
    if (attempt > 0) {
      await new Promise((r) => setTimeout(r, 2000 * Math.pow(2, attempt - 1)));
    }

    try {
      return await withTempFile(audioData, ext, (filePath) => transcribeAudio(filePath));
    } catch (err) {
      lastErr = err instanceof Error ? err : new Error('Transcription error');
      console.warn(`[finalize] chunk attempt ${attempt + 1}/${MAX_CHUNK_ATTEMPTS} failed:`, lastErr.message);
    }
  }

  throw lastErr;
}

async function analyzeAndCompleteRecording(recordingId: string): Promise<FinalizeResult> {
  const transcript = await prisma.transcript.findUnique({ where: { recordingId } });
  if (!transcript || !transcript.fullText.trim()) {
    await prisma.recording.update({ where: { id: recordingId }, data: { status: 'failed' } }).catch(() => {});
    return { ok: false, reason: 'No transcript to analyse.' };
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
  const title = shortTitle ? `${shortTitle} - ${dateStr}` : null;

  await prisma.transcript.update({
    where: { recordingId },
    data: { segments: JSON.stringify(diarized) },
  });

  await prisma.summary.upsert({
    where: { recordingId },
    create: {
      recordingId,
      overview: analysis.overview,
      keyPoints: JSON.stringify(analysis.keyPoints),
      actionItems: JSON.stringify(analysis.actionItems),
      decisions: JSON.stringify(analysis.decisions),
      topics: JSON.stringify(topics),
    },
    update: {
      overview: analysis.overview,
      keyPoints: JSON.stringify(analysis.keyPoints),
      actionItems: JSON.stringify(analysis.actionItems),
      decisions: JSON.stringify(analysis.decisions),
      topics: JSON.stringify(topics),
    },
  });

  const completedRecording = await prisma.recording.update({
    where: { id: recordingId },
    data: { status: 'completed', ...(title ? { title } : {}) },
  });

  // Fire-and-forget Airtable backup — never blocks the main flow
  void backupToAirtable({
    recordingId,
    title:       completedRecording.title,
    createdAt:   completedRecording.createdAt,
    status:      'completed',
    overview:    analysis.overview,
    keyPoints:   analysis.keyPoints,
    actionItems: analysis.actionItems,
    decisions:   analysis.decisions,
    fullText:    transcript.fullText,
  });

  return { ok: true, completed: true, failedChunks: 0, pendingChunks: 0 };
}

async function finalizeLegacy(recordingId: string): Promise<FinalizeResult> {
  await prisma.recording.update({ where: { id: recordingId }, data: { status: 'processing' } }).catch(() => {});

  const chunks = await prisma.chunkBlob.findMany({
    where: { recordingId },
    orderBy: { offset: 'asc' },
  });

  let failedChunks = 0;

  if (chunks.length > 0) {
    let fullText = '';
    const allSegments: RawSegment[] = [];

    for (const chunk of chunks) {
      const ext = chunk.mimeType.includes('mp4') ? '.mp4'
        : chunk.mimeType.includes('ogg') ? '.ogg'
        : '.webm';

      try {
        const { text, rawSegments } = await transcribeChunkWithRetry(chunk.audioData as Buffer, ext);
        if (text.trim()) {
          fullText += (fullText ? ' ' : '') + text.trim();
        }

        const shifted = rawSegments.map((s) => ({
          start: s.start + chunk.offset,
          end: s.end + chunk.offset,
          text: s.text,
        }));
        allSegments.push(...shifted);
      } catch (err) {
        failedChunks += 1;
        console.error(`[finalize] chunk ${chunk.id} failed after retries:`, err);
      }
    }

    if (fullText.trim()) {
      await prisma.transcript.upsert({
        where: { recordingId },
        create: {
          recordingId,
          fullText,
          segments: JSON.stringify(allSegments),
        },
        update: {
          fullText,
          segments: JSON.stringify(allSegments),
        },
      });
    }

    if (failedChunks === 0) {
      await prisma.chunkBlob.deleteMany({ where: { recordingId } });
    } else {
      await prisma.recording.update({ where: { id: recordingId }, data: { status: 'failed' } }).catch(() => {});
      return {
        ok: true,
        completed: false,
        failedChunks,
        pendingChunks: 0,
        reason: 'Some chunks failed. Audio was preserved so retry can continue.',
      };
    }
  }

  return analyzeAndCompleteRecording(recordingId);
}

async function acquireJobLock(recordingId: string): Promise<{ id: string; token: string } | null> {
  const token = randomUUID();
  const lockUntil = new Date(Date.now() + LOCK_MS);

  const job = await prisma.finalizeJob.upsert({
    where: { recordingId },
    create: { recordingId, status: 'pending' },
    update: {},
    select: { id: true },
  });

  const claim = await prisma.finalizeJob.updateMany({
    where: {
      id: job.id,
      OR: [{ lockUntil: null }, { lockUntil: { lt: new Date() } }],
    },
    data: {
      lockToken: token,
      lockUntil,
      status: 'running',
      attempts: { increment: 1 },
      lastError: '',
    },
  });

  if (claim.count === 0) return null;
  await prisma.recording.update({ where: { id: recordingId }, data: { status: 'processing' } }).catch(() => {});
  return { id: job.id, token };
}

async function refreshJobLock(jobId: string, token: string): Promise<void> {
  await prisma.finalizeJob.updateMany({
    where: { id: jobId, lockToken: token },
    data: { lockUntil: new Date(Date.now() + LOCK_MS) },
  });
}

async function releaseJobLock(jobId: string, token: string): Promise<void> {
  await prisma.finalizeJob.updateMany({
    where: { id: jobId, lockToken: token },
    data: { lockToken: null, lockUntil: null },
  });
}

async function finalizeWithJobs(recordingId: string): Promise<FinalizeResult> {
  const lock = await acquireJobLock(recordingId);
  if (!lock) {
    return { ok: true, completed: false, failedChunks: 0, pendingChunks: 0, reason: 'already-processing' };
  }

  try {
    const chunks = await prisma.chunkBlob.findMany({
      where: { recordingId },
      orderBy: [{ offset: 'asc' }, { createdAt: 'asc' }],
    });

    // Process chunks in parallel batches — skips already-succeeded chunks on retry
    await runConcurrent(
      chunks.map((chunk) => async () => {
        const existing = await prisma.chunkTranscript.findUnique({
          where: { jobId_chunkId: { jobId: lock.id, chunkId: chunk.id } },
        });
        if (existing?.status === 'succeeded') return;

        await refreshJobLock(lock.id, lock.token);

        await prisma.chunkTranscript.upsert({
          where: { jobId_chunkId: { jobId: lock.id, chunkId: chunk.id } },
          create: {
            jobId: lock.id,
            recordingId,
            chunkId: chunk.id,
            offset: chunk.offset,
            status: 'processing',
            attempts: 1,
          },
          update: {
            status: 'processing',
            attempts: { increment: 1 },
            lastError: '',
          },
        });

        const ext = chunk.mimeType.includes('mp4') ? '.mp4'
          : chunk.mimeType.includes('ogg') ? '.ogg'
          : '.webm';

        try {
          const { text, rawSegments } = await transcribeChunkWithRetry(chunk.audioData as Buffer, ext);
          await prisma.chunkTranscript.update({
            where: { jobId_chunkId: { jobId: lock.id, chunkId: chunk.id } },
            data: {
              status: 'succeeded',
              transcript: text.trim(),
              segments: JSON.stringify(rawSegments),
              processedAt: new Date(),
              lastError: '',
            },
          });
        } catch (err) {
          const msg = err instanceof Error ? err.message : 'Chunk transcription failed';
          await prisma.chunkTranscript.update({
            where: { jobId_chunkId: { jobId: lock.id, chunkId: chunk.id } },
            data: {
              status: 'failed',
              lastError: msg.slice(0, 500),
              processedAt: null,
            },
          });
        }
      }),
      PARALLEL_CHUNKS,
    );

    const [failedChunks, pendingChunks, rows] = await Promise.all([
      prisma.chunkTranscript.count({ where: { jobId: lock.id, status: 'failed' } }),
      prisma.chunkTranscript.count({ where: { jobId: lock.id, status: { in: ['pending', 'processing'] } } }),
      prisma.chunkTranscript.findMany({
        where: { jobId: lock.id, status: 'succeeded' },
        orderBy: [{ offset: 'asc' }, { createdAt: 'asc' }],
      }),
    ]);

    let fullText = '';
    const allSegments: RawSegment[] = [];

    for (const row of rows) {
      if (row.transcript.trim()) {
        fullText += (fullText ? ' ' : '') + row.transcript.trim();
      }

      let parsed: RawSegment[] = [];
      try {
        parsed = JSON.parse(row.segments) as RawSegment[];
      } catch {
        parsed = [];
      }

      const shifted = parsed.map((s) => ({
        start: s.start + row.offset,
        end: s.end + row.offset,
        text: s.text,
      }));

      allSegments.push(...shifted);
    }

    if (fullText.trim()) {
      await prisma.transcript.upsert({
        where: { recordingId },
        create: { recordingId, fullText, segments: JSON.stringify(allSegments) },
        update: { fullText, segments: JSON.stringify(allSegments) },
      });
    }

    if (failedChunks > 0 || pendingChunks > 0) {
      await prisma.finalizeJob.update({
        where: { id: lock.id },
        data: {
          status: 'failed',
          lastError: `pending=${pendingChunks}, failed=${failedChunks}`,
        },
      });
      await prisma.recording.update({ where: { id: recordingId }, data: { status: 'failed' } }).catch(() => {});
      return {
        ok: true,
        completed: false,
        failedChunks,
        pendingChunks,
        reason: 'Some chunks failed and were kept for retry.',
      };
    }

    const completed = await analyzeAndCompleteRecording(recordingId);
    if (!completed.ok) {
      await prisma.finalizeJob.update({ where: { id: lock.id }, data: { status: 'failed', lastError: completed.reason } });
      return completed;
    }

    await prisma.finalizeJob.update({ where: { id: lock.id }, data: { status: 'completed', lastError: '' } });

    await prisma.chunkBlob.deleteMany({ where: { recordingId } });

    return completed;
  } finally {
    await releaseJobLock(lock.id, lock.token);
  }
}

export async function enqueueFinalizeJob(recordingId: string): Promise<void> {
  try {
    await prisma.finalizeJob.upsert({
      where: { recordingId },
      create: { recordingId, status: 'pending' },
      update: { status: 'pending', lastError: '' },
    });
  } catch (err) {
    if (!isMissingFinalizeTablesError(err)) {
      console.warn('[finalize] enqueue warning:', err);
    }
  }
}

export async function finalizeRecording(recordingId: string): Promise<FinalizeResult> {
  try {
    return await finalizeWithJobs(recordingId);
  } catch (err) {
    if (!isMissingFinalizeTablesError(err)) {
      console.error('[finalize] job mode failed, falling back to legacy mode:', err);
    }
    return finalizeLegacy(recordingId);
  }
}
