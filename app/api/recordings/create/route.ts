import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db';

export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  let source = 'web';
  try {
    const body = await req.json() as { source?: string };
    if (body.source === 'teams') source = 'teams';
  } catch { /* no body — fine */ }

  const recording = await prisma.recording.create({
    data: {
      title: `Recording – ${new Date().toLocaleDateString('en-GB', {
        day: 'numeric',
        month: 'short',
        year: 'numeric',
      })}`,
      status: 'uploading',
      source,
    },
  });
  return NextResponse.json({ id: recording.id });
}
