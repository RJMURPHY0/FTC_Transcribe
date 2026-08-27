import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { getAuthUser } from '@/lib/auth';
import { logAudit, requestIp } from '@/lib/audit';
import { ensureSchema } from '@/lib/ensure-schema';
import { embedAudioSample, EMB_MODEL_VERSION } from '@/lib/voice-id';
import { createVoiceProfileTagged } from '@/lib/voice-profile-store';

export const dynamic = 'force-dynamic';
// Cold start may download the voiceprint models (~35 MB) before embedding
export const maxDuration = 120;

const ALLOWED_MIME = new Set(['audio/webm', 'audio/mp4', 'audio/ogg', 'audio/mpeg', 'audio/wav', 'audio/m4a', 'audio/x-m4a']);
const MAX_SAMPLE_BYTES = 10 * 1024 * 1024;

// List enrolled people with sample counts
export async function GET() {
  const user = await getAuthUser();
  if (!user) return NextResponse.json({ error: 'Not authenticated.' }, { status: 401 });

  await ensureSchema();
  const rows = await prisma.voiceProfile.findMany({
    // Same visibility rule as recordings (canAccessRecording): own rows plus
    // unclaimed legacy rows (null userId); can-see-all admins see everything.
    where: user.canSeeAll ? {} : { OR: [{ userId: user.id }, { userId: null }] },
    select: { id: true, personName: true, durationS: true, source: true, createdAt: true },
    orderBy: { createdAt: 'desc' },
  });

  // A voiceprint is only comparable to others made by the same embedding model,
  // so profiles recorded before a model change are silently ignored by every
  // match rather than producing wrong names. Silently is the problem: on
  // 2026-07-23 the switch to TitaNet retired every existing enrolment, and the
  // only visible symptom was meetings quietly going back to "Speaker 1".
  // Counting them here lets the page say so and ask for a re-record, which is
  // the only fix — embeddings cannot be converted between model spaces.
  let staleProfiles = 0;
  try {
    const [row] = await prisma.$queryRaw<Array<{ n: bigint }>>`
      SELECT COUNT(*)::bigint AS n FROM "VoiceProfile"
       WHERE "modelVersion" <> ${EMB_MODEL_VERSION}
         AND (${user.canSeeAll}::boolean OR "userId" = ${user.id}::text OR "userId" IS NULL)`;
    staleProfiles = Number(row?.n ?? 0);
  } catch { /* column missing in this env — nothing to warn about */ }

  // Which of this user's rows are usable at all, so the page can offer to
  // clear a person's dead samples rather than leaving a permanent warning
  // beside a voice that has already been relearned.
  const liveIds = new Set<string>();
  try {
    const live = await prisma.$queryRaw<Array<{ id: string }>>`
      SELECT "id" FROM "VoiceProfile" WHERE "modelVersion" = ${EMB_MODEL_VERSION}`;
    for (const r of live) liveIds.add(r.id);
  } catch { /* column missing — treat everything as current, as before */ }
  const hasVersionColumn = liveIds.size > 0 || staleProfiles > 0;

  const people = new Map<string, {
    name: string; samples: number; totalDurationS: number; lastAdded: string;
    enrolledSamples: number; currentSamples: number; staleSamples: number;
  }>();
  for (const r of rows) {
    const p = people.get(r.personName) ?? {
      name: r.personName, samples: 0, totalDurationS: 0, lastAdded: r.createdAt.toISOString(),
      enrolledSamples: 0, currentSamples: 0, staleSamples: 0,
    };
    p.samples += 1;
    p.totalDurationS += r.durationS;
    if (r.source === 'enrollment') p.enrolledSamples += 1;
    if (!hasVersionColumn || liveIds.has(r.id)) p.currentSamples += 1;
    else p.staleSamples += 1;
    people.set(r.personName, p);
  }
  // "learned" = never explicitly enrolled — built only from self-introductions
  // or manual renames. Surface it so the user can strengthen it if they want.
  const result = [...people.values()].map(p => ({ ...p, learned: p.enrolledSamples === 0 }));
  return NextResponse.json({ people: result, staleProfiles });
}

// Enroll: multipart form with `name` + one or more `samples` audio files
export async function POST(request: NextRequest) {
  const user = await getAuthUser();
  if (!user) return NextResponse.json({ error: 'Not authenticated.' }, { status: 401 });

  const formData = await request.formData();
  const name = (formData.get('name') as string | null)?.trim().slice(0, 80);
  const files = formData.getAll('samples').filter((f): f is File => f instanceof File);

  if (!name) return NextResponse.json({ error: 'Name is required.' }, { status: 400 });
  if (/^Speaker \d+$/i.test(name)) return NextResponse.json({ error: 'Please use a real name.' }, { status: 400 });
  if (!files.length) return NextResponse.json({ error: 'No audio samples provided.' }, { status: 400 });

  await ensureSchema();

  const deviceLabel = /mobile|iphone|android/i.test(request.headers.get('user-agent') ?? '') ? 'phone' : 'desktop';
  let saved = 0;
  const errors: string[] = [];

  for (const file of files.slice(0, 8)) {
    if (file.size === 0 || file.size > MAX_SAMPLE_BYTES) {
      errors.push('Sample skipped: empty or too large.');
      continue;
    }
    const baseMime = file.type.split(';')[0].trim() || 'audio/webm';
    if (!ALLOWED_MIME.has(baseMime)) {
      errors.push(`Sample skipped: unsupported type ${baseMime}.`);
      continue;
    }
    const buffer = Buffer.from(await file.arrayBuffer());
    const result = await embedAudioSample(buffer, baseMime);
    if (!result) {
      errors.push('Sample skipped: could not extract a voiceprint (need ≥2s of clear speech).');
      continue;
    }
    await createVoiceProfileTagged({
      userId: user.id,
      personName: name,
      embedding: JSON.stringify(result.embedding),
      durationS: result.durationS,
      source: 'enrollment',
      deviceLabel,
      // Keep the clip itself so the sample inspector can play it back —
      // enrollment clips are tiny (seconds of opus audio).
      audioData: buffer,
      audioMime: baseMime,
    }, EMB_MODEL_VERSION);
    saved += 1;
  }

  if (saved === 0) {
    return NextResponse.json({ error: errors[0] ?? 'No usable samples.', errors }, { status: 422 });
  }

  // Voice embeddings are biometric data — enrolment must always leave a trail.
  await logAudit({
    userId: user.id,
    userEmail: user.email,
    action: 'voice.enroll',
    targetType: 'voiceProfile',
    ip: requestIp(request),
    metadata: { personName: name, samples: saved },
  });

  return NextResponse.json({ ok: true, saved, errors });
}

// Remove a person's voice profiles: ?name=...
export async function DELETE(request: NextRequest) {
  const user = await getAuthUser();
  if (!user) return NextResponse.json({ error: 'Not authenticated.' }, { status: 401 });

  const name = request.nextUrl.searchParams.get('name')?.trim();
  if (!name) return NextResponse.json({ error: 'name query param required.' }, { status: 400 });

  // ?staleOnly=1 removes just the samples a retired embedding model produced.
  // They cannot be matched against anything and cannot be converted, so once a
  // person has been relearned in the current space these are pure noise in the
  // list. Kept as an explicit opt-in rather than automatic cleanup: they are
  // still the user's own voice data, and deleting it is their call.
  const staleOnly = request.nextUrl.searchParams.get('staleOnly') === '1';

  // Scoped like the GET above: a user can only delete their own (or unclaimed
  // legacy) samples; can-see-all admins keep the previous global delete.
  const scope = user.canSeeAll
    ? { personName: name }
    : { personName: name, OR: [{ userId: user.id }, { userId: null }] };

  let deleted: { count: number };
  if (staleOnly) {
    // Two steps rather than a raw DELETE: the id list keeps the ownership
    // scope in Prisma's hands instead of hand-rolling it into SQL.
    let staleIds: string[] = [];
    try {
      const rows = await prisma.$queryRaw<Array<{ id: string }>>`
        SELECT "id" FROM "VoiceProfile" WHERE "modelVersion" <> ${EMB_MODEL_VERSION}`;
      staleIds = rows.map(r => r.id);
    } catch {
      // No modelVersion column, so nothing in this DB is stale by definition.
      return NextResponse.json({ ok: true, deleted: 0 });
    }
    if (!staleIds.length) return NextResponse.json({ ok: true, deleted: 0 });
    deleted = await prisma.voiceProfile.deleteMany({
      where: { ...scope, id: { in: staleIds } },
    });
  } else {
    deleted = await prisma.voiceProfile.deleteMany({ where: scope });
  }

  await logAudit({
    userId: user.id,
    userEmail: user.email,
    action: staleOnly ? 'voice.deleteStale' : 'voice.delete',
    targetType: 'voiceProfile',
    ip: requestIp(request),
    metadata: { personName: name, deleted: deleted.count },
  });

  return NextResponse.json({ ok: true, deleted: deleted.count });
}
