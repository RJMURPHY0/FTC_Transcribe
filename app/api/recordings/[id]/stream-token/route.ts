import { NextRequest, NextResponse } from 'next/server';
import { getAuthUser } from '@/lib/auth';
import { rateLimit } from '@/lib/rate-limit';

export const dynamic = 'force-dynamic';

const DG_KEY = process.env.DEEPGRAM_API_KEY;

// access-check-exempt: mints a short-lived Deepgram caption token; touches no
// per-recording data (the id param is unused), so per-user auth + throttle is
// the right gate rather than canAccessRecording.
export async function GET(_req: NextRequest) {
  const user = await getAuthUser();
  if (!user) return NextResponse.json({ error: 'Not authenticated.' }, { status: 401 });

  // Each call creates a real Deepgram API key — throttle per user.
  const limited = rateLimit(`stream-token:${user.id}`, 10, 5 * 60 * 1000);
  if (!limited.ok) {
    return NextResponse.json(
      { error: 'Too many caption sessions — try again shortly.' },
      { status: 429, headers: { 'Retry-After': String(limited.retryAfterS) } },
    );
  }

  if (!DG_KEY) {
    return NextResponse.json({ error: 'Deepgram not configured.' }, { status: 503 });
  }

  // Fetch Deepgram project ID
  const projectRes = await fetch('https://api.deepgram.com/v1/projects', {
    headers: { Authorization: `Token ${DG_KEY}` },
  }).catch(() => null);

  if (!projectRes?.ok) {
    return NextResponse.json({ error: 'Failed to reach Deepgram.' }, { status: 502 });
  }

  const { projects } = await projectRes.json() as { projects: Array<{ project_id: string }> };
  const projectId = projects?.[0]?.project_id;
  if (!projectId) {
    return NextResponse.json({ error: 'No Deepgram project found.' }, { status: 502 });
  }

  // Create a short-lived key (5 min TTL, streaming scope only)
  const keyRes = await fetch(`https://api.deepgram.com/v1/projects/${projectId}/keys`, {
    method:  'POST',
    headers: { Authorization: `Token ${DG_KEY}`, 'Content-Type': 'application/json' },
    body:    JSON.stringify({
      comment:                  'FTC Transcribe live caption session',
      scopes:                   ['usage:write'],
      time_to_live_in_seconds:  300,
    }),
  }).catch(() => null);

  if (!keyRes?.ok) {
    return NextResponse.json({ error: 'Failed to create Deepgram token.' }, { status: 502 });
  }

  const { key } = await keyRes.json() as { key: string };
  return NextResponse.json({ token: key });
}
