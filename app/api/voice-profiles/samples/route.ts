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
  const rows = await prisma.voiceProfile.findMany({
    where: { personName: name },
    orderBy: { createdAt: 'desc' },
    select: {
      id: true, source: true, durationS: true, deviceLabel: true,
      recordingId: true, excerpt: true, createdAt: true, embedding: true,
    },
  });

  // Resolve recording titles for samples learned from meetings
  const recIds = [...new Set(rows.map(r => r.recordingId).filter((x): x is string => !!x))];
  const recs = recIds.length
    ? await prisma.recording.findMany({
        where: { id: { in: recIds } },
        select: { id: true, title: true, deletedAt: true },
      })
    : [];
  const titleOf = new Map(recs.map(r => [r.id, r.deletedAt ? null : r.title]));

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
    samples: rows.map((r, i) => ({
      id: r.id,
      source: r.source,
      durationS: r.durationS,
      deviceLabel: r.deviceLabel,
      createdAt: r.createdAt.toISOString(),
      recordingId: r.recordingId,
      recordingTitle: r.recordingId ? titleOf.get(r.recordingId) ?? null : null,
      excerpt: r.excerpt,
      consistency: consistency[i],
    })),
  });
}

// Delete a single training sample by id
export async function DELETE(request: NextRequest) {
  const user = await getAuthUser();
  if (!user) return NextResponse.json({ error: 'Not authenticated.' }, { status: 401 });

  const id = request.nextUrl.searchParams.get('id')?.trim();
  if (!id) return NextResponse.json({ error: 'id query param required.' }, { status: 400 });

  const deleted = await prisma.voiceProfile.deleteMany({ where: { id } });
  if (deleted.count === 0) {
    return NextResponse.json({ error: 'Sample not found.' }, { status: 404 });
  }
  return NextResponse.json({ ok: true });
}
