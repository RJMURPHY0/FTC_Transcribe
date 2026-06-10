import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import type { TranscriptSegment } from '@/lib/ai';

export const dynamic = 'force-dynamic';

const CUID_RE = /^c[a-z0-9]{20,}$/;

// PATCH /api/recordings/[id]/transcript-segment
// Body: { segmentIndex: number; newSpeaker: string }
export async function PATCH(
  req: NextRequest,
  { params }: { params: { id: string } },
) {
  if (!CUID_RE.test(params.id)) {
    return NextResponse.json({ error: 'Invalid recording ID.' }, { status: 400 });
  }

  const body = await req.json() as { segmentIndices?: number[]; newSpeaker?: string };
  if (!Array.isArray(body.segmentIndices) || !body.segmentIndices.length || !body.newSpeaker?.trim()) {
    return NextResponse.json({ error: 'segmentIndices and newSpeaker required.' }, { status: 400 });
  }

  const transcript = await prisma.transcript.findUnique({
    where:  { recordingId: params.id },
    select: { id: true, segments: true },
  });
  if (!transcript) {
    return NextResponse.json({ error: 'Transcript not found.' }, { status: 404 });
  }

  let segments: TranscriptSegment[];
  try {
    segments = JSON.parse(transcript.segments) as TranscriptSegment[];
  } catch {
    return NextResponse.json({ error: 'Segment data corrupt.' }, { status: 500 });
  }

  for (const idx of body.segmentIndices) {
    if (idx < 0 || idx >= segments.length) {
      return NextResponse.json({ error: `Segment index ${idx} out of range.` }, { status: 400 });
    }
    segments[idx] = { ...segments[idx], speaker: body.newSpeaker.trim() };
  }

  await prisma.transcript.update({
    where: { id: transcript.id },
    data:  { segments: JSON.stringify(segments) },
  });

  return NextResponse.json({ ok: true });
}
