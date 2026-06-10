import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { getAuthUser } from '@/lib/auth';

export const dynamic = 'force-dynamic';

const VALID_MEETING_TYPES = new Set(['general', 'standup', 'sales', 'interview', 'review']);

export async function POST(req: NextRequest) {
  let source = 'web';
  let meetingType = 'general';
  try {
    const body = await req.json() as { source?: string; meetingType?: string };
    if (body.source === 'teams') source = 'teams';
    if (body.meetingType && VALID_MEETING_TYPES.has(body.meetingType)) meetingType = body.meetingType;
  } catch { /* no body — fine */ }

  const user = await getAuthUser();
  const recording = await prisma.recording.create({
    data: {
      title: `Recording – ${new Date().toLocaleDateString('en-GB', {
        day: 'numeric',
        month: 'short',
        year: 'numeric',
      })}`,
      status: 'uploading',
      source,
      meetingType,
      userId: user?.id ?? null,
    },
  });
  return NextResponse.json({ id: recording.id });
}
