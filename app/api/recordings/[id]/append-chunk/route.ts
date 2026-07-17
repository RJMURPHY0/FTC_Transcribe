import { createHash } from 'crypto';
import { NextRequest, NextResponse } from 'next/server';
import { waitUntil } from '@vercel/functions';
import { prisma } from '@/lib/db';
import { getAuthUser, canAccessRecording } from '@/lib/auth';
import { enqueueFinalizeJob } from '@/lib/finalize-recording';
import { transcribeChunk } from '@/lib/transcribe-chunk';

export const dynamic = 'force-dynamic';
// Extended to accommodate background transcription via waitUntil
export const maxDuration = 120;

const CUID_RE = /^c[a-z0-9]{20,}$/;
const ALLOWED_MIME = new Set(['audio/webm', 'audio/mp4', 'audio/ogg', 'audio/mpeg', 'audio/wav', 'audio/m4a', 'audio/x-m4a']);
const MAX_CHUNK_BYTES = 10 * 1024 * 1024; // 10 MB

export async function POST(
  request: NextRequest,
  { params }: { params: { id: string } },
) {
  if (!CUID_RE.test(params.id)) {
    return NextResponse.json({ error: 'Invalid recording ID.' }, { status: 400 });
  }

  try {
    const formData  = await request.formData();
    const file      = formData.get('audio') as File | null;
    const offsetStr = formData.get('offset') as string | null;

    if (!file || file.size === 0) {
      return NextResponse.json({ error: 'No audio provided.' }, { status: 400 });
    }
    if (file.size > MAX_CHUNK_BYTES) {
      return NextResponse.json({ error: 'Chunk too large (max 10 MB).' }, { status: 413 });
    }

    const baseMime = file.type.split(';')[0].trim();
    if (!ALLOWED_MIME.has(baseMime)) {
      return NextResponse.json({ error: 'Invalid file type.' }, { status: 415 });
    }

    const timeOffset = Math.max(0, parseFloat(offsetStr ?? '0'));
    if (!isFinite(timeOffset)) {
      return NextResponse.json({ error: 'Invalid offset.' }, { status: 400 });
    }

    // Confirm the recording exists AND belongs to the caller — same visibility
    // rule as the recording page: owner, unclaimed, or can-see-all.
    const user = await getAuthUser();
    const recording = await prisma.recording.findUnique({ where: { id: params.id } });
    if (!recording) {
      return NextResponse.json({ error: 'Recording not found.' }, { status: 404 });
    }
    if (!canAccessRecording(recording.userId, user)) {
      return NextResponse.json({ error: 'Not allowed.' }, { status: 403 });
    }

    const bytes = await file.arrayBuffer();
    const audioBuffer = Buffer.from(bytes);
    // Retry-safe: clients retry failed uploads up to 4x, and a lost response
    // means the chunk was stored but the client retries anyway. The content
    // hash + partial unique index makes the duplicate insert a no-op instead
    // of duplicated audio (which showed up as duplicated notes).
    const contentHash = createHash('sha256').update(audioBuffer).digest('hex');

    let chunkRecord: { id: string };
    try {
      chunkRecord = await prisma.$transaction(async (tx) => {
        const chunk = await tx.chunkBlob.create({
          data: {
            recordingId: params.id,
            audioData:   audioBuffer,
            offset:      timeOffset,
            mimeType:    baseMime,
            contentHash,
          },
          select: { id: true },
        });
        await tx.recording.update({
          where: { id: params.id },
          data:  { status: 'uploading' },
        });
        return chunk;
      });
    } catch (err) {
      if ((err as { code?: string }).code === 'P2002') {
        // Same audio already stored — the retry succeeded the first time
        return NextResponse.json({ ok: true, deduped: true });
      }
      throw err;
    }

    const jobId = await enqueueFinalizeJob(params.id);

    // Transcribe this chunk in the background so finalize only needs to run AI analysis.
    // waitUntil keeps the serverless function alive after the HTTP response is sent.
    if (jobId) {
      waitUntil(transcribeChunkBackground(chunkRecord.id, jobId, params.id, timeOffset, baseMime));
    }

    return NextResponse.json({ ok: true });
  } catch (error) {
    console.error('[append-chunk]', error);
    return NextResponse.json({ error: 'Failed to save chunk.' }, { status: 500 });
  }
}

async function transcribeChunkBackground(
  chunkId: string,
  jobId: string,
  recordingId: string,
  offset: number,
  mimeType: string,
): Promise<void> {
  // Idempotency: skip if a previous background run already succeeded
  const existing = await prisma.chunkTranscript.findUnique({
    where: { jobId_chunkId: { jobId, chunkId } },
    select: { status: true },
  });
  if (existing?.status === 'succeeded') return;

  await prisma.chunkTranscript.upsert({
    where: { jobId_chunkId: { jobId, chunkId } },
    create: { jobId, recordingId, chunkId, offset, status: 'processing', attempts: 1 },
    update: { status: 'processing', attempts: { increment: 1 }, lastError: '' },
  });

  try {
    const blob = await prisma.chunkBlob.findUniqueOrThrow({
      where: { id: chunkId },
      select: { audioData: true },
    });

    if ((blob.audioData as Buffer).length < 1000) {
      await prisma.chunkTranscript.update({
        where: { jobId_chunkId: { jobId, chunkId } },
        data: { status: 'succeeded', transcript: '', segments: '[]', processedAt: new Date(), lastError: '' },
      });
      return;
    }

    const { text, segments, voiceData } = await transcribeChunk(blob.audioData as Buffer, mimeType);

    await prisma.chunkTranscript.update({
      where: { jobId_chunkId: { jobId, chunkId } },
      data: {
        status: 'succeeded',
        transcript: text.trim(),
        segments: JSON.stringify(segments),
        voiceData: voiceData ? JSON.stringify(voiceData) : '',
        processedAt: new Date(),
        lastError: '',
      },
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Background transcription failed';
    await prisma.chunkTranscript.update({
      where: { jobId_chunkId: { jobId, chunkId } },
      data: { status: 'failed', lastError: msg.slice(0, 500), processedAt: null },
    }).catch(() => {});
    console.error('[append-chunk bg]', chunkId, msg);
  }
}
