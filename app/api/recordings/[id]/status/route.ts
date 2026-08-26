import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { getAuthUser, canAccessRecording } from '@/lib/auth';
import { measuredRatio } from '@/lib/finalize-progress';
import {
  asStage, remainingSeconds, stageProgress, STAGE_LABEL,
  BASE_OVERHEAD_S, CHUNK_AUDIO_S,
} from '@/lib/estimate';

export const dynamic = 'force-dynamic';

// Ultra-light status probe for the client poller. Returns just enough to decide
// whether the full page needs re-fetching — avoids pulling the whole transcript
// on every 3s tick (the old ProcessingPoller did a full router.refresh()).
//
// It also carries the progress bar: which phase the worker is in, how far
// through it is, and how much longer to expect. That last number is measured
// from this account's own completed recordings rather than guessed, because
// the old constant was routinely 10x short and read as a hang.
export async function GET(_req: NextRequest, { params }: { params: { id: string } }) {
  const user = await getAuthUser();
  if (!user) return NextResponse.json({ error: 'Not authenticated.' }, { status: 401 });

  const rec = await prisma.recording
    .findUnique({
      where: { id: params.id },
      select: {
        status: true,
        userId: true,
        duration: true,
        transcript: { select: { id: true } },
        _count: { select: { chunks: true } },
        finalizeJob: { select: { stage: true, startedAt: true } },
      },
    })
    .catch(() => null);

  if (!rec) return NextResponse.json({ status: 'unknown', hasTranscript: false }, { status: 404 });
  if (!canAccessRecording(rec.userId, user)) {
    return NextResponse.json({ error: 'Not allowed.' }, { status: 403 });
  }

  const stage = asStage(rec.finalizeJob?.stage, rec.status);
  const chunksTotal = rec._count.chunks;
  const chunksDone = stage === 'queued' || chunksTotal === 0
    ? 0
    : await prisma.chunkTranscript
      .count({ where: { recordingId: params.id, status: 'succeeded' } })
      .catch(() => 0);

  // While a meeting is still uploading its duration is 0, so chunk count is
  // the only length signal available.
  const audioSeconds = rec.duration > 0 ? rec.duration : chunksTotal * CHUNK_AUDIO_S;
  const startedAt = rec.finalizeJob?.startedAt ?? null;
  const elapsedS = startedAt ? Math.max(0, (Date.now() - startedAt.getTime()) / 1000) : 0;

  const done = rec.status === 'completed' || rec.status === 'failed';
  const ratio = done ? 0 : await measuredRatio(rec.userId);

  // How far through the expected run we are by the clock. Feeds the phases
  // that have nothing countable of their own, so the bar keeps moving through
  // diarisation and the AI pass instead of freezing.
  const expectedTotal = BASE_OVERHEAD_S + audioSeconds * (ratio || 1);
  const timeFraction = expectedTotal > 0 ? elapsedS / expectedTotal : 0;

  return NextResponse.json({
    status: rec.status,
    hasTranscript: !!rec.transcript,
    stage,
    stageLabel: STAGE_LABEL[stage],
    progress: stageProgress(stage, chunksDone, chunksTotal, timeFraction),
    chunksDone,
    chunksTotal,
    elapsedS: Math.round(elapsedS),
    etaS: done ? 0 : remainingSeconds(audioSeconds, ratio, elapsedS),
  });
}
