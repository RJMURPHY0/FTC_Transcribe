import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { getAuthUser, canAccessRecording } from '@/lib/auth';
import { measuredCost } from '@/lib/finalize-progress';
import {
  asStage, remainingSeconds, stageProgress, STAGE_LABEL,
  estimateFinalizeSeconds,
} from '@/lib/estimate';

export const dynamic = 'force-dynamic';

// Ultra-light status probe for the client poller. Returns just enough to decide
// whether the full page needs re-fetching — avoids pulling the whole transcript
// on every 3s tick (the old ProcessingPoller did a full router.refresh()).
//
// It also carries the progress bar: which phase the worker is in, how far
// through it is, and how much longer to expect. That last number is measured
// from this deployment's own completed work rather than guessed, and it is
// built from the chunks still outstanding rather than from meeting length,
// because meeting length turned out not to predict it at all.
export async function GET(_req: NextRequest, { params }: { params: { id: string } }) {
  const user = await getAuthUser();
  if (!user) return NextResponse.json({ error: 'Not authenticated.' }, { status: 401 });

  const rec = await prisma.recording
    .findUnique({
      where: { id: params.id },
      select: {
        status: true,
        userId: true,
        orgId: true,
        duration: true,
        transcript: { select: { id: true } },
        _count: { select: { chunks: true } },
        finalizeJob: { select: { stage: true, startedAt: true, deadLettered: true } },
      },
    })
    .catch(() => null);

  if (!rec) return NextResponse.json({ status: 'unknown', hasTranscript: false }, { status: 404 });
  if (!canAccessRecording(rec, user)) {
    return NextResponse.json({ error: 'Not allowed.' }, { status: 403 });
  }

  const stage = asStage(rec.finalizeJob?.stage, rec.status);
  const chunksTotal = rec._count.chunks;
  // Anything terminal counts as done: `skipped` chunks hold no transcribable
  // audio and are never coming back, so leaving them out of the numerator
  // would park the bar just short of the end for ever.
  const chunksDone = stage === 'queued' || chunksTotal === 0
    ? 0
    : await prisma.chunkTranscript
      .count({ where: { recordingId: params.id, status: { in: ['succeeded', 'skipped'] } } })
      .catch(() => 0);

  const startedAt = rec.finalizeJob?.startedAt ?? null;
  const elapsedS = startedAt ? Math.max(0, (Date.now() - startedAt.getTime()) / 1000) : 0;

  const done = rec.status === 'completed' || rec.status === 'failed';
  const cost = await measuredCost(rec.userId);
  const pendingChunks = Math.max(0, chunksTotal - chunksDone);

  // How far through the expected run we are by the clock. Feeds the phases
  // that have nothing countable of their own, so the bar keeps moving through
  // diarisation and the AI pass instead of freezing.
  const expectedTotal = estimateFinalizeSeconds(pendingChunks, cost);
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
    etaS: done ? 0 : remainingSeconds(pendingChunks, cost, elapsedS),
    // A dead-lettered job is not coming back on its own. The page needs to say
    // so and offer Retry rather than poll a queue that has given up.
    abandoned: !!rec.finalizeJob?.deadLettered,
  });
}
