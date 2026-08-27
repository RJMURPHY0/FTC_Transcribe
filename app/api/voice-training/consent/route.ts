import { NextRequest, NextResponse } from 'next/server';
import { getAnyUser } from '@/lib/auth';
import { logAudit, requestIp } from '@/lib/audit';
import { resolveVoiceTraining, setVoiceTraining } from '@/lib/user-settings';

export const dynamic = 'force-dynamic';

// The single source of truth for "may the dictation app train my voiceprint".
//
// Both products read and write this one row, which is what makes the toggle in
// the desktop app and the toggle on /voice-setup the same switch rather than
// two settings that drift apart. Accepts a cookie session (web) or a bearer
// token (desktop), so the route is in middleware's public allowlist and does
// its own auth.

export async function GET(request: NextRequest) {
  const user = await getAnyUser(request);
  if (!user) return NextResponse.json({ error: 'Not authenticated.' }, { status: 401 });

  return NextResponse.json({ enabled: await resolveVoiceTraining(user.id) });
}

export async function PUT(request: NextRequest) {
  const user = await getAnyUser(request);
  if (!user) return NextResponse.json({ error: 'Not authenticated.' }, { status: 401 });

  let enabled: unknown;
  try {
    ({ enabled } = await request.json());
  } catch {
    return NextResponse.json({ error: 'Body must be JSON.' }, { status: 400 });
  }
  if (typeof enabled !== 'boolean') {
    return NextResponse.json({ error: '`enabled` must be true or false.' }, { status: 400 });
  }

  await setVoiceTraining(user.id, enabled);

  // Granting or withdrawing consent to process biometric data always leaves a
  // trail, in both directions.
  await logAudit({
    userId: user.id,
    userEmail: user.email,
    action: enabled ? 'voice.training.optIn' : 'voice.training.optOut',
    targetType: 'userSetting',
    ip: requestIp(request),
  });

  return NextResponse.json({ enabled });
}
