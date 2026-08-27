import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { getAnyUser } from '@/lib/auth';
import { logAudit, requestIp } from '@/lib/audit';
import { rateLimit } from '@/lib/rate-limit';
import { cosineSim, embedAudioSample, EMB_MODEL_VERSION } from '@/lib/voice-id';
import { createVoiceProfileTagged } from '@/lib/voice-profile-store';
import { resolveVoiceTraining } from '@/lib/user-settings';
import { DICTATION_APP } from '@/lib/branding';

export const dynamic = 'force-dynamic';
// Cold start may download the voiceprint models (~35 MB) before embedding.
export const maxDuration = 120;

const ALLOWED_MIME = new Set(['audio/wav', 'audio/x-wav', 'audio/webm', 'audio/mp4', 'audio/ogg', 'audio/mpeg']);
const MAX_CLIP_BYTES = 8 * 1024 * 1024;
// A dictation clip is one person talking into a close mic. Below this there is
// not enough voice to embed; above it the clip is a monologue, and the extra
// seconds add storage rather than accuracy.
const MIN_CLIP_S = 3;
const MAX_CLIP_S = 45;
// Ceiling on how much of one voice we keep. Past this, another near-identical
// clip of the same person shifts nothing and just costs storage.
const MAX_DICTATION_SAMPLES = 15;
// Two clips this similar carry the same information.
const DUP_SIM = 0.97;

/**
 * Accept one dictation snippet from the desktop app and turn it into a voice
 * training sample.
 *
 * The audio is kept alongside the voiceprint. That is what makes the sample
 * playable in the inspector, and it is the difference between a future model
 * change being a re-embed and being a request that every user re-records: the
 * enrolments made before this app stored audio are unrecoverable for exactly
 * that reason.
 *
 * Consent is checked here, server-side, on every request. A client that stops
 * asking, or a stale build that never knew to ask, still cannot upload.
 */
export async function POST(request: NextRequest) {
  const user = await getAnyUser(request);
  if (!user) return NextResponse.json({ error: 'Not authenticated.' }, { status: 401 });

  const limited = rateLimit(`voice-training:${user.id}`, 120, 60 * 60 * 1000);
  if (!limited.ok) {
    return NextResponse.json(
      { error: 'Too many uploads, try later.' },
      { status: 429, headers: { 'Retry-After': String(limited.retryAfterS) } },
    );
  }

  if (!(await resolveVoiceTraining(user.id))) {
    return NextResponse.json(
      { error: 'Voice training is off for this account.', code: 'consent_off' },
      { status: 403 },
    );
  }

  const form = await request.formData();
  const clip = form.get('clip');
  if (!(clip instanceof File)) {
    return NextResponse.json({ error: 'No clip provided.' }, { status: 400 });
  }
  if (clip.size === 0 || clip.size > MAX_CLIP_BYTES) {
    return NextResponse.json({ error: 'Clip empty or too large.' }, { status: 400 });
  }
  const mime = clip.type.split(';')[0].trim() || 'audio/wav';
  if (!ALLOWED_MIME.has(mime)) {
    return NextResponse.json({ error: `Unsupported type ${mime}.` }, { status: 400 });
  }

  // The person's own name on their own account. The desktop app never sends a
  // name: it has no business asserting who its user is, and a typo there would
  // create a second person.
  const personName = await accountDisplayName(user.id, user.email);
  if (!personName) {
    return NextResponse.json(
      { error: 'No display name on this account, cannot attribute the sample.', code: 'no_name' },
      { status: 409 },
    );
  }

  const buffer = Buffer.from(await clip.arrayBuffer());
  const result = await embedAudioSample(buffer, mime);
  if (!result) {
    return NextResponse.json({ error: 'No usable speech in clip.', code: 'no_speech' }, { status: 422 });
  }
  if (result.durationS < MIN_CLIP_S || result.durationS > MAX_CLIP_S) {
    return NextResponse.json(
      { error: `Clip must be ${MIN_CLIP_S}-${MAX_CLIP_S}s, got ${result.durationS}s.`, code: 'bad_length' },
      { status: 422 },
    );
  }

  // Existing dictation samples in the CURRENT model space only: a campplus row
  // cannot be compared to a titanet one, so counting or de-duplicating against
  // it would be meaningless.
  const existing = await prisma.$queryRaw<Array<{ id: string; embedding: string }>>`
    SELECT "id", "embedding" FROM "VoiceProfile"
    WHERE "userId" = ${user.id}
      AND "source" = ${DICTATION_APP.id}
      AND "modelVersion" = ${EMB_MODEL_VERSION}`;

  for (const row of existing) {
    try {
      if (cosineSim(result.embedding, JSON.parse(row.embedding) as number[]) > DUP_SIM) {
        return NextResponse.json({ ok: true, stored: false, reason: 'duplicate' });
      }
    } catch { /* unparseable row, ignore it rather than block the upload */ }
  }
  if (existing.length >= MAX_DICTATION_SAMPLES) {
    return NextResponse.json({ ok: true, stored: false, reason: 'enough_samples' });
  }

  const created = await createVoiceProfileTagged({
    userId: user.id,
    personName,
    embedding: JSON.stringify(result.embedding),
    durationS: result.durationS,
    source: DICTATION_APP.id,
    deviceLabel: (form.get('deviceLabel') as string | null)?.slice(0, 40) || 'desktop',
    audioData: buffer,
    audioMime: mime,
    excerpt: (form.get('excerpt') as string | null)?.slice(0, 300) ?? '',
    // The clip IS the sample, so the playable span is the whole of it.
    clipStartS: 0,
    clipEndS: result.durationS,
  }, EMB_MODEL_VERSION);

  await logAudit({
    userId: user.id,
    userEmail: user.email,
    action: 'voice.training.sample',
    targetType: 'voiceProfile',
    targetId: created.id,
    ip: requestIp(request),
    metadata: { personName, durationS: result.durationS, source: DICTATION_APP.id },
  });

  return NextResponse.json({
    ok: true,
    stored: true,
    id: created.id,
    durationS: result.durationS,
    samples: existing.length + 1,
  });
}

/**
 * The name this person's meetings should label them with. Reuses
 * getMemberNames, the same lookup finalize uses to name the microphone channel
 * of an online meeting (lib/finalize-recording.ts localSpeakerName), so a
 * dictation sample and a meeting land on ONE person rather than creating a
 * near-duplicate profile under a slightly different spelling.
 */
async function accountDisplayName(userId: string, email: string): Promise<string> {
  try {
    const { getMemberNames } = await import('@/lib/contacts-db');
    const name = (await getMemberNames([userId]))[userId]?.trim();
    if (name) return name.slice(0, 80);
  } catch (err) {
    console.error('[voice-training] display name lookup failed:', err);
  }
  // Last resort so a sample is never dropped for want of a name: the local
  // part of the email, title-cased. Unlike a meeting there is no "You"
  // fallback, because a voice profile named "You" would be a real person.
  const local = email.split('@')[0]?.replace(/[._-]+/g, ' ').trim();
  if (!local) return '';
  return local.replace(/\b\w/g, (c) => c.toUpperCase()).slice(0, 80);
}
