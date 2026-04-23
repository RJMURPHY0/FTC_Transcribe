import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { enqueueFinalizeJob } from '@/lib/finalize-recording';

export const dynamic = 'force-dynamic';
// No AI calls here — just a DB write, so a short timeout is plenty.
export const maxDuration = 30;

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

    // Confirm the recording exists
    const recording = await prisma.recording.findUnique({ where: { id: params.id } });
    if (!recording) {
      return NextResponse.json({ error: 'Recording not found.' }, { status: 404 });
    }

    // Store raw bytes — transcription happens later in /finalize.
    // This means the upload phase can never fail due to AI API errors or rate limits.
    const bytes = await file.arrayBuffer();
    await prisma.$transaction([
      prisma.chunkBlob.create({
        data: {
          recordingId: params.id,
          audioData:   Buffer.from(bytes),
          offset:      timeOffset,
          mimeType:    baseMime,
        },
      }),
      prisma.recording.update({
        where: { id: params.id },
        data:  { status: 'uploading' },
      }),
    ]);

    await enqueueFinalizeJob(params.id);

    return NextResponse.json({ ok: true });
  } catch (error) {
    console.error('[append-chunk]', error);
    return NextResponse.json({ error: 'Failed to save chunk.' }, { status: 500 });
  }
}
