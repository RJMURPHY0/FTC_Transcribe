import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db';

export const dynamic = 'force-dynamic';

// Ultra-light status probe for the client poller. Returns just enough to decide
// whether the full page needs re-fetching — avoids pulling the whole transcript
// on every 3s tick (the old ProcessingPoller did a full router.refresh()).
export async function GET(_req: NextRequest, { params }: { params: { id: string } }) {
  const rec = await prisma.recording
    .findUnique({
      where: { id: params.id },
      select: { status: true, transcript: { select: { id: true } } },
    })
    .catch(() => null);

  if (!rec) return NextResponse.json({ status: 'unknown', hasTranscript: false }, { status: 404 });

  return NextResponse.json({ status: rec.status, hasTranscript: !!rec.transcript });
}
