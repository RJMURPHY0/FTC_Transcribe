import { NextRequest, NextResponse } from 'next/server';
import { prisma, withDbRetry } from '@/lib/db';

export const dynamic = 'force-dynamic';
// ?voice=1 may download the voiceprint models (~35 MB) on a cold start
export const maxDuration = 120;

export async function GET(request: NextRequest) {
  let db = false;
  let recordings = -1;
  try {
    // Retry transient pooler/cold-start blips so a healthy DB isn't reported as
    // "Not configured" on the Settings page.
    recordings = await withDbRetry(() => prisma.recording.count());
    db = true;
  } catch { /* genuinely unreachable */ }

  // Deep voice-ID probe on demand only — initialises the sherpa-onnx engine
  let voice: { ok: boolean; dim?: number; error?: string } | undefined;
  if (request.nextUrl.searchParams.get('voice') === '1') {
    const { probeVoiceId } = await import('@/lib/voice-id');
    voice = await probeVoiceId();
  }

  // Teams-notification readiness on demand: it only fires when BOTH a service
  // role key is set AND at least one microsoft_integrations webhook exists.
  // `ready` is the single "is it actually working" answer.
  let teams: { ready: boolean; serviceKey: boolean; webhooks: number } | undefined;
  if (request.nextUrl.searchParams.get('teams') === '1') {
    const serviceKey = !!process.env.SUPABASE_SERVICE_ROLE_KEY;
    let webhooks = 0;
    try {
      const rows = await prisma.$queryRawUnsafe<{ n: number }[]>(
        `SELECT count(teams_webhook_url)::int AS n FROM microsoft_integrations`,
      );
      webhooks = Number(rows[0]?.n ?? 0);
    } catch { /* table absent in this env */ }
    teams = { ready: serviceKey && webhooks > 0, serviceKey, webhooks };
  }

  return NextResponse.json({
    db,
    recordings,
    openai:     !!(process.env.OPENAI_API_KEY    && !process.env.OPENAI_API_KEY.startsWith('your_')),
    anthropic:  !!(process.env.ANTHROPIC_API_KEY && !process.env.ANTHROPIC_API_KEY.startsWith('your_')),
    groq:       !!(process.env.GROQ_API_KEY      && !process.env.GROQ_API_KEY.startsWith('your_')),
    airtable:   !!(process.env.AIRTABLE_API_KEY  && process.env.AIRTABLE_BASE_ID),
    openrouter: !!process.env.OPENROUTER_API_KEY,
    ...(voice ? { voice } : {}),
    ...(teams ? { teams } : {}),
  });
}
