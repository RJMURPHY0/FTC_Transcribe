import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { finalizeRecording, enqueueFinalizeJob } from '@/lib/finalize-recording';
import { deleteArchivedAudio } from '@/lib/audio-archive';

export const dynamic = 'force-dynamic';
export const maxDuration = 800;

// With real-time background transcription, each recording only needs analysis (~45s).
// Keep this low so the 5-min cron never times out.
const MAX_RECORDINGS_PER_RUN = 2;

function isAuthorized(req: NextRequest): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return true; // No secret configured → fail-open (dev / internal cron)
  const auth = req.headers.get('authorization') ?? '';
  return auth === `Bearer ${secret}`;
}

async function runWorker() {
  // Only process recordings where no new chunk arrived in the last 5 minutes.
  // Active recordings upload every 2 minutes, so this reliably means the session is over.
  const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000);

  let candidates: Array<{ id: string }> = [];

  try {
    const jobs = await prisma.finalizeJob.findMany({
      where: {
        status: { in: ['pending', 'failed', 'running'] },
        recording: {
          chunks: { none: { createdAt: { gt: fiveMinutesAgo } } },
        },
      },
      orderBy: { updatedAt: 'asc' },
      take: MAX_RECORDINGS_PER_RUN,
      select: { recordingId: true },
    });

    candidates = jobs.map((j: { recordingId: string }) => ({ id: j.recordingId }));
  } catch {
    // FinalizeJob table may not exist on older deployments — fall back to scanning recordings
    const recordings = await prisma.recording.findMany({
      where: {
        status: { in: ['uploading', 'processing', 'failed'] },
        chunks: {
          some: {},
          none: { createdAt: { gt: fiveMinutesAgo } },
        },
      },
      orderBy: { createdAt: 'asc' },
      take: MAX_RECORDINGS_PER_RUN,
      select: { id: true },
    });
    candidates = recordings;
  }

  let completed = 0;
  let partial = 0;
  let failed = 0;

  for (const rec of candidates) {
    const result = await finalizeRecording(rec.id);
    if (!result.ok) {
      failed += 1;
      continue;
    }
    if (result.completed) {
      completed += 1;
    } else {
      partial += 1;
    }
  }

  return {
    scanned: candidates.length,
    completed,
    partial,
    failed,
  };
}

export async function GET(request: NextRequest) {
  if (!isAuthorized(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  // Enqueue finalize jobs for any stale uploading recordings (no chunk in last 5 min)
  const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000);

  const staleUploads = await prisma.recording.findMany({
    where: {
      status: 'uploading',
      chunks: {
        some: {},
        none: { createdAt: { gt: fiveMinutesAgo } },
      },
    },
    take: MAX_RECORDINGS_PER_RUN,
    select: { id: true },
  }).catch(() => []);

  for (const rec of staleUploads) {
    await enqueueFinalizeJob(rec.id);
  }

  // Mark recordings that have been stuck in 'uploading' or 'processing' for over 24 hours
  // as failed. These are ghosts — abandoned sessions, mic-denied starts, or crashed uploads —
  // that will never complete on their own.
  const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
  await prisma.recording.updateMany({
    where: {
      status: { in: ['uploading', 'processing'] },
      createdAt: { lt: oneDayAgo },
    },
    data: { status: 'failed' },
  }).catch(() => {});

  // Purge soft-deleted recordings after 30 days (hard delete cascades
  // transcripts, summaries, chunks, and speaker embeddings). Archived audio
  // lives outside the DB, so remove those storage objects first.
  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  try {
    const purgeable = await prisma.recording.findMany({
      where: { deletedAt: { lt: thirtyDaysAgo }, audioPath: { not: '' } },
      select: { audioPath: true },
    });
    for (const r of purgeable) await deleteArchivedAudio(r.audioPath);
  } catch { /* best-effort */ }
  await prisma.recording.deleteMany({
    where: { deletedAt: { lt: thirtyDaysAgo } },
  }).catch(() => {});

  const stats = await runWorker();
  return NextResponse.json({ ok: true, ...stats });
}

export async function POST(request: NextRequest) {
  return GET(request);
}
