import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { getAuthUser } from '@/lib/auth';

export const dynamic = 'force-dynamic';

const VALID_MEETING_TYPES = new Set(['general', 'standup', 'sales', 'interview', 'review']);
const VALID_CHANNEL_LAYOUTS = new Set(['mic-sys', 'mono']);

export async function POST(req: NextRequest) {
  let source = 'web';
  let meetingType = 'general';
  let channelLayout: string | null = null;
  try {
    const body = await req.json() as { source?: string; meetingType?: string; channelLayout?: string };
    if (body.source === 'teams') source = 'teams';
    if (body.meetingType && VALID_MEETING_TYPES.has(body.meetingType)) meetingType = body.meetingType;
    // Recorded for diagnostics only. Finalize reads the real layout off the
    // audio, so nothing downstream trusts this field.
    if (body.channelLayout && VALID_CHANNEL_LAYOUTS.has(body.channelLayout)) channelLayout = body.channelLayout;
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
      channelLayout,
      userId: user?.id ?? null,
    },
  });
  return NextResponse.json({ id: recording.id });
}
