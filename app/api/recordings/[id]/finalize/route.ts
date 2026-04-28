import { NextRequest, NextResponse } from 'next/server';
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
