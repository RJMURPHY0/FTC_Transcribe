import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import type { TranscriptSegment } from '@/lib/ai';

export const dynamic = 'force-dynamic';

const CUID_RE = /^c[a-z0-9]{20,}$/;

export async function PATCH(
  req: NextRequest,
  { params }: { params: { id: string } },
) {
  if (!CUID_RE.test(params.id)) {
    return NextResponse.json({ error: 'Invalid ID' }, { status: 400 });
  }

  const body = await req.json() as { renames?: unknown };
  const raw = body.renames;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return NextResponse.json({ error: 'renames must be an object mapping old names to new names.' }, { status: 400 });
  }

  // Sanitise: values must be non-empty strings, max 80 chars
  const renames: Record<string, string> = {};
  for (const [from, to] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof to === 'string' && to.trim()) {
      renames[from] = to.trim().slice(0, 80);
    }
  }

  if (!Object.keys(renames).length) {
    return NextResponse.json({ error: 'No valid renames provided.' }, { status: 400 });
  }

  const transcript = await prisma.transcript.findUnique({
    where: { recordingId: params.id },
  });

  if (!transcript) {
    return NextResponse.json({ error: 'No transcript found.' }, { status: 404 });
  }

  let segments: TranscriptSegment[] = [];
  try {
    const parsed = JSON.parse(transcript.segments) as unknown;
    if (!Array.isArray(parsed)) {
      return NextResponse.json({ error: 'Could not parse segments.' }, { status: 500 });
    }
    segments = parsed as TranscriptSegment[];
  } catch {
    return NextResponse.json({ error: 'Could not parse segments.' }, { status: 500 });
  }

  const updated = segments.map(seg => ({
    ...seg,
    speaker: renames[seg.speaker] ?? seg.speaker,
  }));

  await prisma.transcript.update({
    where: { recordingId: params.id },
    data: { segments: JSON.stringify(updated) },
  });

  return NextResponse.json({ ok: true });
}
