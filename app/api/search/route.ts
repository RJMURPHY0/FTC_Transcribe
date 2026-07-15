import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { vectorSearch } from '@/lib/embeddings';
import { getAuthUser } from '@/lib/auth';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const q = req.nextUrl.searchParams.get('q')?.trim() ?? '';
  if (q.length < 2) return NextResponse.json([]);

  const user   = await getAuthUser();
  const userId = user?.id ?? null;
  const canSeeAll = user?.canSeeAll ?? false;

  // Try vector search first
  const vectorHits = await vectorSearch(q, canSeeAll ? null : userId);

  if (vectorHits.length > 0) {
    const recIds = vectorHits.map(h => h.recordingId);
    const recordings = await prisma.recording.findMany({
      where: { id: { in: recIds }, status: 'completed', deletedAt: null },
      select: { id: true, title: true, createdAt: true, meetingType: true, source: true },
    });
    const byId = Object.fromEntries(recordings.map(r => [r.id, r]));

    const results = vectorHits
      .filter(h => byId[h.recordingId])
      .map(h => ({
        id:          h.recordingId,
        title:       byId[h.recordingId].title,
        createdAt:   byId[h.recordingId].createdAt,
        meetingType: byId[h.recordingId].meetingType,
        source:      byId[h.recordingId].source,
        excerpt:     h.excerpt.slice(0, 200),
        similarity:  h.similarity,
      }));

    return NextResponse.json(results);
  }

  // Fallback: full-text ILIKE search across title + transcript
  const userScope = canSeeAll ? {} : userId
    ? { OR: [{ userId }, { userId: null }] }
    : {};

  const [titleMatches, transcriptMatches] = await Promise.all([
    prisma.recording.findMany({
      where:   { title: { contains: q, mode: 'insensitive' }, status: 'completed', deletedAt: null, ...userScope },
      select:  { id: true, title: true, createdAt: true, meetingType: true, source: true },
      orderBy: { createdAt: 'desc' },
      take:    10,
    }),
    prisma.transcript.findMany({
      where:   { fullText: { contains: q, mode: 'insensitive' }, recording: { status: 'completed', deletedAt: null, ...userScope } },
      select:  {
        recordingId: true,
        fullText:    true,
        recording:   { select: { id: true, title: true, createdAt: true, meetingType: true, source: true } },
      },
      take: 10,
    }),
  ]);

  const seen = new Set<string>();
  const results: Array<{
    id: string; title: string; createdAt: Date;
    meetingType: string; source: string; excerpt: string;
  }> = [];

  for (const r of titleMatches) {
    if (seen.has(r.id)) continue;
    seen.add(r.id);
    results.push({ ...r, excerpt: '' });
  }

  for (const t of transcriptMatches) {
    if (seen.has(t.recordingId)) continue;
    seen.add(t.recordingId);

    // Extract a short excerpt around the first match
    const lower = t.fullText.toLowerCase();
    const pos   = lower.indexOf(q.toLowerCase());
    const start = Math.max(0, pos - 60);
    const excerpt = (start > 0 ? '…' : '') + t.fullText.slice(start, pos + q.length + 100).trim() + '…';

    results.push({ ...t.recording, excerpt });
  }

  return NextResponse.json(results.slice(0, 10));
}
