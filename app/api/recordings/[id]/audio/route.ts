import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db';

export const dynamic = 'force-dynamic';

const CUID_RE = /^c[a-z0-9]{20,}$/;

export async function GET(
  _req: NextRequest,
  { params }: { params: { id: string } },
) {
  if (!CUID_RE.test(params.id)) {
    return NextResponse.json({ error: 'Invalid recording ID.' }, { status: 400 });
  }

  const chunks = await prisma.chunkBlob.findMany({
    where:   { recordingId: params.id },
    orderBy: { offset: 'asc' },
    select:  { audioData: true, mimeType: true },
  });

  if (chunks.length === 0) {
    return NextResponse.json({ error: 'No audio found.' }, { status: 404 });
  }

  const totalLength = chunks.reduce((sum, c) => sum + c.audioData.length, 0);
  const merged = new Uint8Array(totalLength);
  let pos = 0;
  for (const chunk of chunks) {
    merged.set(new Uint8Array(chunk.audioData), pos);
    pos += chunk.audioData.length;
  }

  const mimeType = chunks[0].mimeType || 'audio/webm';

  return new NextResponse(merged, {
    headers: {
      'Content-Type':   mimeType,
      'Content-Length': String(totalLength),
      'Cache-Control':  'no-store',
      'Accept-Ranges':  'bytes',
    },
  });
}
