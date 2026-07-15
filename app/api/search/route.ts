import { NextRequest, NextResponse } from 'next/server';
import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/db';
import { vectorSearch } from '@/lib/embeddings';
import { getAuthUser } from '@/lib/auth';
import { getMemberUserIds } from '@/lib/contacts-db';

export const dynamic = 'force-dynamic';

interface Result {
  id: string;
  title: string;
  createdAt: Date;
  meetingType: string;
  source: string;
  excerpt: string;
  similarity?: number;
}

export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams;
  const q = sp.get('q')?.trim() ?? '';
  if (q.length < 2) return NextResponse.json([]);

  const mode     = sp.get('mode');                 // 'ai' → semantic; else plain text
  const source   = sp.get('source');               // 'web' | 'teams'
  const type     = sp.get('type');                  // meetingType
  const from     = sp.get('from');                  // ISO date lower bound
  const org      = sp.get('org');
  const team     = sp.get('team');
  const assignee = sp.get('assignee');

  const user      = await getAuthUser();
  const userId    = user?.id ?? null;
  const canSeeAll = user?.canSeeAll ?? false;

  // ── User scope (mirrors dashboard) ─────────────────────────────────────────
  let scope: Prisma.RecordingWhereInput = {};
  if (!canSeeAll) {
    scope = userId ? { OR: [{ userId }, { userId: null }] } : {};
  } else if (assignee) {
    scope = { userId: assignee };
  } else if (org || team) {
    const ids = await getMemberUserIds(org, team);
    scope = ids.length > 0 ? { userId: { in: ids } } : { userId: '__no_match__' };
  }

  // ── Shared filter fragment ──────────────────────────────────────────────────
  const baseWhere: Prisma.RecordingWhereInput = {
    status: 'completed',
    deletedAt: null,
    ...(source === 'web' || source === 'teams' ? { source } : {}),
    ...(type ? { meetingType: type } : {}),
    ...(from ? { createdAt: { gte: new Date(from) } } : {}),
    ...scope,
  };

  // ── AI / semantic mode ───────────────────────────────────────────────────────
  if (mode === 'ai') {
    // vectorSearch scopes by a single userId; pass the assignee (or the user's
    // own id for non-admins) as a cheap narrow, then re-apply the full filter
    // set when hydrating so source/type/date/org still constrain the results.
    const vecUser = canSeeAll ? (assignee ?? null) : userId;
    const hits = await vectorSearch(q, vecUser, 20);
    if (hits.length === 0) return NextResponse.json([]);

    const recIds = hits.map(h => h.recordingId);
    const recs = await prisma.recording.findMany({
      where: { id: { in: recIds }, ...baseWhere },
      select: { id: true, title: true, createdAt: true, meetingType: true, source: true },
    });
    const byId = Object.fromEntries(recs.map(r => [r.id, r]));

    const results: Result[] = hits
      .filter(h => byId[h.recordingId])
      .slice(0, 10)
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

  // ── Normal mode: plain ILIKE across title + transcript + AI notes ─────────────
  const like = { contains: q, mode: 'insensitive' as const };
  const recSelect = { id: true, title: true, createdAt: true, meetingType: true, source: true };

  const [titleMatches, notesMatches, transcriptMatches] = await Promise.all([
    // Title
    prisma.recording.findMany({
      where:   { title: like, ...baseWhere },
      select:  recSelect,
      orderBy: { createdAt: 'desc' },
      take:    10,
    }),
    // Meeting notes (AI summary): overview / key points / action items / decisions / topics
    prisma.recording.findMany({
      where: {
        ...baseWhere,
        summary: {
          OR: [
            { overview:    like },
            { keyPoints:   like },
            { actionItems: like },
            { decisions:   like },
            { topics:      like },
          ],
        },
      },
      select:  { ...recSelect, summary: { select: { overview: true } } },
      orderBy: { createdAt: 'desc' },
      take:    10,
    }),
    // Transcript full text
    prisma.transcript.findMany({
      where:  { fullText: like, recording: baseWhere },
      select: {
        recordingId: true,
        fullText:    true,
        recording:   { select: recSelect },
      },
      take: 10,
    }),
  ]);

  const seen = new Set<string>();
  const results: Result[] = [];

  for (const r of titleMatches) {
    if (seen.has(r.id)) continue;
    seen.add(r.id);
    results.push({ ...r, excerpt: '' });
  }

  for (const r of notesMatches) {
    if (seen.has(r.id)) continue;
    seen.add(r.id);
    const overview = r.summary?.overview ?? '';
    results.push({
      id: r.id, title: r.title, createdAt: r.createdAt,
      meetingType: r.meetingType, source: r.source,
      excerpt: overview.slice(0, 180),
    });
  }

  for (const t of transcriptMatches) {
    if (seen.has(t.recordingId)) continue;
    seen.add(t.recordingId);
    const lower = t.fullText.toLowerCase();
    const pos   = lower.indexOf(q.toLowerCase());
    const start = Math.max(0, pos - 60);
    const excerpt = (start > 0 ? '…' : '') + t.fullText.slice(start, pos + q.length + 100).trim() + '…';
    results.push({ ...t.recording, excerpt });
  }

  return NextResponse.json(results.slice(0, 12));
}
