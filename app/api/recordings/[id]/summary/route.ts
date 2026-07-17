import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { getAuthUser, canAccessRecording } from '@/lib/auth';
import { normaliseDue } from '@/lib/action-items';

export const dynamic = 'force-dynamic';

const CUID_RE = /^c[a-z0-9]{20,}$/;

export async function PATCH(
  request: NextRequest,
  { params }: { params: { id: string } },
) {
  if (!CUID_RE.test(params.id)) {
    return NextResponse.json({ error: 'Invalid recording ID.' }, { status: 400 });
  }

  try {
    const body = await request.json() as Record<string, unknown>;
    const { overview, keyPoints, actionItems, decisions, topics, actionItemsChecked, actionItemsDue } = body;

    const data: Record<string, string> = {};
    if (overview !== undefined)            data.overview            = String(overview).slice(0, 5000);
    if (keyPoints !== undefined)           data.keyPoints           = Array.isArray(keyPoints)           ? JSON.stringify(keyPoints.slice(0, 20).map(String))                    : '[]';
    if (actionItems !== undefined)         data.actionItems         = Array.isArray(actionItems)         ? JSON.stringify(actionItems.slice(0, 20).map(String))                  : '[]';
    if (decisions !== undefined)           data.decisions           = Array.isArray(decisions)           ? JSON.stringify(decisions.slice(0, 20).map(String))                    : '[]';
    if (topics !== undefined)              data.topics              = Array.isArray(topics)              ? JSON.stringify(topics.slice(0, 10))                                   : '[]';
    if (actionItemsChecked !== undefined)  data.actionItemsChecked  = Array.isArray(actionItemsChecked)  ? JSON.stringify(actionItemsChecked.filter(Number.isInteger).slice(0, 50)) : '[]';
    if (actionItemsDue !== undefined)      data.actionItemsDue      = Array.isArray(actionItemsDue)      ? JSON.stringify(actionItemsDue.slice(0, 20).map(normaliseDue))           : '[]';

    if (Object.keys(data).length === 0) {
      return NextResponse.json({ error: 'Nothing to update.' }, { status: 400 });
    }

    const user = await getAuthUser();
    const rec = await prisma.recording.findUnique({
      where: { id: params.id },
      select: { userId: true, deletedAt: true },
    });
    if (!rec || rec.deletedAt) {
      return NextResponse.json({ error: 'Recording not found.' }, { status: 404 });
    }
    if (!canAccessRecording(rec.userId, user)) {
      return NextResponse.json({ error: 'Not allowed.' }, { status: 403 });
    }

    await prisma.summary.update({ where: { recordingId: params.id }, data });

    return NextResponse.json({ ok: true });
  } catch (error) {
    console.error('[summary PATCH]', error);
    return NextResponse.json({ error: 'Failed to save.' }, { status: 500 });
  }
}
