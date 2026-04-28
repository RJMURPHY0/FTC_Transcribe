import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { finalizeRecording, enqueueFinalizeJob } from '@/lib/finalize-recording';

export const dynamic = 'force-dynamic';
export const maxDuration = 800;

const MAX_RECORDINGS_PER_RUN = 5;

function isAuthorized(req: NextRequest): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return true;
  const auth = req.headers.get('authorization') ?? '';
  return auth === `Bearer ${secret}`;
}

async function runWorker() {
  let candidates: Array<{ id: string }> = [];

  try {
    const jobs = await prisma.finalizeJob.findMany({
      where: { status: { in: ['pending', 'failed', 'running'] } },
      orderBy: { updatedAt: 'asc' },
      take: MAX_RECORDINGS_PER_RUN,
      select: { recordingId: true },
    });

    candidates = jobs.map((j: { recordingId: string }) => ({ id: j.recordingId }));
  } catch {
    const recordings = await prisma.recording.findMany({
      where: {
        status: { in: ['uploading', 'processing', 'failed'] },
        chunks: { some: {} },
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

  const staleUploads = await prisma.recording.findMany({
    where: {
      status: 'uploading',
      chunks: { some: {} },
    },
    take: MAX_RECORDINGS_PER_RUN,
    select: { id: true },
  }).catch(() => []);

  for (const rec of staleUploads) {
    await enqueueFinalizeJob(rec.id);
  }

  const stats = await runWorker();
  return NextResponse.json({ ok: true, ...stats });
}

export async function POST(request: NextRequest) {
  return GET(request);
}
