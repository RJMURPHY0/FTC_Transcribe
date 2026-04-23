import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';

export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    const recordings = await prisma.recording.findMany({
      orderBy: { createdAt: 'desc' },
      include: {
        summary: { select: { overview: true, keyPoints: true, actionItems: true, decisions: true, topics: true } },
        folder: { select: { id: true, name: true } },
        _count: { select: { chunks: true } },
      },
    });
    return NextResponse.json(recordings);
  } catch {
    return NextResponse.json({ error: 'Failed to fetch recordings.' }, { status: 500 });
  }
}
