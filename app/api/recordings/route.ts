import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { getAuthUser } from '@/lib/auth';

export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    const user = await getAuthUser();
    if (!user) return NextResponse.json({ error: 'Not authenticated.' }, { status: 401 });
    // Scope to the user's own (and unclaimed) recordings unless they're an admin,
    // and never return soft-deleted rows. Previously this returned every user's
    // recordings, including deleted ones.
    const scope = user.canSeeAll ? {} : { OR: [{ userId: user.id }, { userId: null }] };

    const recordings = await prisma.recording.findMany({
      where: { deletedAt: null, ...scope },
      take: 100,
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
