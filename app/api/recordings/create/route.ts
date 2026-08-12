import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { getAuthUser } from '@/lib/auth';
import { logAudit, requestIp } from '@/lib/audit';
import { rateLimit } from '@/lib/rate-limit';

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

  // Middleware already redirects anonymous traffic, but this is the data
  // boundary: every new recording must have a verified owner.
  const user = await getAuthUser();
  if (!user) return NextResponse.json({ error: 'Not authenticated.' }, { status: 401 });

  const limited = rateLimit(`recording-create:${user.id}`, 60, 60 * 60 * 1000);
  if (!limited.ok) {
    return NextResponse.json(
      { error: 'Too many recordings created — try again shortly.' },
      { status: 429, headers: { 'Retry-After': String(limited.retryAfterS) } },
    );
  }

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
      userId: user.id,
    },
  });

  await logAudit({
    userId: user.id,
    userEmail: user.email,
    action: 'recording.create',
    targetType: 'recording',
    targetId: recording.id,
    ip: requestIp(req),
    metadata: { source, meetingType },
  });

  return NextResponse.json({ id: recording.id });
}
