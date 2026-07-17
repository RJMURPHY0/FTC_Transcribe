import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { getAuthUser, canAccessRecording } from '@/lib/auth';
import { finalizeRecording } from '@/lib/finalize-recording';

export const dynamic = 'force-dynamic';
export const maxDuration = 800;

const CUID_RE = /^c[a-z0-9]{20,}$/;

export async function POST(
  _request: NextRequest,
  { params }: { params: { id: string } },
) {
  if (!CUID_RE.test(params.id)) {
    return NextResponse.json({ error: 'Invalid recording ID.' }, { status: 400 });
  }

  // Ownership gate (cron runs use /api/jobs/finalize, not this route) — same
  // visibility rule as the recording page: owner, unclaimed, or can-see-all.
  const user = await getAuthUser();
  const recording = await prisma.recording.findUnique({
    where: { id: params.id },
    select: { userId: true },
  });
  if (!recording) {
    return NextResponse.json({ error: 'Recording not found.' }, { status: 404 });
  }
  if (!canAccessRecording(recording.userId, user)) {
    return NextResponse.json({ error: 'Not allowed.' }, { status: 403 });
  }

  const result = await finalizeRecording(params.id);
  if (!result.ok) {
    return NextResponse.json({ error: result.reason }, { status: 500 });
  }
  if (!result.completed) {
    return NextResponse.json({
      ok: true,
      completed: false,
      pendingChunks: result.pendingChunks,
      failedChunks: result.failedChunks,
      reason: result.reason,
    }, { status: 202 });
  }
  return NextResponse.json({ ok: true, completed: true });
}
