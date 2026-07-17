import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { getAuthUser } from '@/lib/auth';
import { ensureSchema } from '@/lib/ensure-schema';
import { cosineSim } from '@/lib/voice-id';

export const dynamic = 'force-dynamic';

// List one person's training samples with provenance + consistency.
// Consistency = cosine similarity of the sample to the person's centroid —
// a low score flags a sample that probably captured someone else's voice.
export async function GET(request: NextRequest) {
  const user = await getAuthUser();
  if (!user) return NextResponse.json({ error: 'Not authenticated.' }, { status: 401 });

  const name = request.nextUrl.searchParams.get('name')?.trim();
  if (!name) return NextResponse.json({ error: 'name query param required.' }, { status: 400 });

  await ensureSchema();
  // Scope to the caller's own samples (+ unclaimed legacy null-userId rows),
  // same visibility rule as samples/audio/route.ts — canSeeAll sees everyone's.
  // Without this, listing by personName returned other tenants' voiceprint rows.
  const rows = await prisma.voiceProfile.findMany({
    where: {
      personName: name,
      ...(user.canSeeAll ? {} : { OR: [{ userId: user.id }, { userId: null }] }),
    },
    orderBy: { createdAt: 'desc' },
    select: {
      id: true, source: true, durationS: true, deviceLabel: true,
      recordingId: true, excerpt: true, createdAt: true, embedding: true,
      // audioMime is set exactly when a playable enrollment clip was stored —
      // checking it avoids pulling the clip bytes on every list request.
      audioMime: true,
    },
  });

  // Resolve recording titles + audio availability for meeting-derived samples
  const recIds = [...new Set(rows.map(r => r.recordingId).filter((x): x is string => !!x))];
  const recs = recIds.length
    ? await prisma.recording.findMany({
        where: { id: { in: recIds } },
        select: { id: true, title: true, deletedAt: true, audioPath: true, _count: { select: { chunks: true } } },
      })
    : [];
  const titleOf = new Map(recs.map(r => [r.id, r.deletedAt ? null : r.title]));
  const audioOf = new Map(recs.map(r => [r.id, !r.deletedAt && (r._count.chunks > 0 || !!r.audioPath)]));

  // Segment times per recording — lets each sample point at the exact stretch
  // of the meeting audio that trained it, so the user can listen and verify.
  type Seg = { start: number; end: number; text: string; speaker?: string | number };
  const transcripts = recIds.length
    ? await prisma.transcript.findMany({
        where: { recordingId: { in: recIds } },
        select: { recordingId: true, segments: true },
      })
    : [];
  const segsOf = new Map<string, Seg[]>();
  for (const t of transcripts) {
    try { segsOf.set(t.recordingId, JSON.parse(t.segments) as Seg[]); } catch { /* unparseable */ }
  }

  // First contiguous run of this speaker's segments (≤2s gaps), capped at 20s.
  function deriveClip(recordingId: string | null): { start: number; end: number } | null {
    if (!recordingId) return null;
    const own = (segsOf.get(recordingId) ?? []).filter(s => String(s.speaker) === name && s.end > s.start);
    if (!own.length) return null;
    let end = own[0].end;
    const start = own[0].start;
    for (let i = 1; i < own.length; i++) {
      if (own[i].start - end <= 2 && own[i].end - start <= 20) end = own[i].end;
      else break;
    }
    return { start: Math.max(0, start), end: Math.min(end, start + 20) };
  }

  // Consistency vs the duration-agnostic centroid of all samples
  const embs = rows.map(r => {
    try { return JSON.parse(r.embedding) as number[]; } catch { return null; }
  });
  let consistency: Array<number | null> = rows.map(() => null);
  const valid = embs.filter((e): e is number[] => !!e);
  if (valid.length >= 2) {
    const dim = valid[0].length;
    const centroid = new Array(dim).fill(0);
    for (const e of valid) for (let d = 0; d < dim; d++) centroid[d] += e[d];
    for (let d = 0; d < dim; d++) centroid[d] /= valid.length;
    consistency = embs.map(e => (e ? Math.round(cosineSim(e, centroid) * 100) / 100 : null));
  }

  return NextResponse.json({
    samples: rows.map((r, i) => {
      const clip = deriveClip(r.recordingId);
      const recordingHasAudio = r.recordingId ? audioOf.get(r.recordingId) ?? false : false;
      return {
        id: r.id,
        source: r.source,
        durationS: r.durationS,
        deviceLabel: r.deviceLabel,
        createdAt: r.createdAt.toISOString(),
        recordingId: r.recordingId,
        recordingTitle: r.recordingId ? titleOf.get(r.recordingId) ?? null : null,
        excerpt: r.excerpt,
        consistency: consistency[i],
        // Playable clip: enrollment samples stream their stored clip; meeting
        // samples seek into the recording's audio at the trained segment.
        clipUrl: r.audioMime
          ? `/api/voice-profiles/samples/audio?id=${r.id}`
          : recordingHasAudio && clip
            ? `/api/recordings/${r.recordingId}/audio`
            : null,
        clipStart: r.audioMime ? 0 : clip?.start ?? null,
        clipEnd: r.audioMime ? null : clip?.end ?? null,
      };
    }),
  });
}

// Delete a single training sample by id
export async function DELETE(request: NextRequest) {
  const user = await getAuthUser();
  if (!user) return NextResponse.json({ error: 'Not authenticated.' }, { status: 401 });

  const id = request.nextUrl.searchParams.get('id')?.trim();
  if (!id) return NextResponse.json({ error: 'id query param required.' }, { status: 400 });

  // Ownership gate before delete — same rule as samples/audio/route.ts: owner,
  // unclaimed (null userId), or can-see-all. Blocks cross-user deletion by id.
  const row = await prisma.voiceProfile.findUnique({
    where: { id }, select: { userId: true },
  });
  if (!row) {
    return NextResponse.json({ error: 'Sample not found.' }, { status: 404 });
  }
  if (row.userId && row.userId !== user.id && !user.canSeeAll) {
    return NextResponse.json({ error: 'Not allowed.' }, { status: 403 });
  }
  const deleted = await prisma.voiceProfile.deleteMany({ where: { id } });
  if (deleted.count === 0) {
    return NextResponse.json({ error: 'Sample not found.' }, { status: 404 });
  }
  return NextResponse.json({ ok: true });
}
