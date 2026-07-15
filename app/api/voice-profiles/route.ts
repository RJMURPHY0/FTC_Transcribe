import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { getAuthUser } from '@/lib/auth';
import { ensureSchema } from '@/lib/ensure-schema';
import { embedAudioSample } from '@/lib/voice-id';

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
    select: { personName: true, durationS: true, source: true, createdAt: true },
    orderBy: { createdAt: 'desc' },
  });

  const people = new Map<string, { name: string; samples: number; totalDurationS: number; lastAdded: string }>();
  for (const r of rows) {
    const p = people.get(r.personName) ?? { name: r.personName, samples: 0, totalDurationS: 0, lastAdded: r.createdAt.toISOString() };
    p.samples += 1;
    p.totalDurationS += r.durationS;
    people.set(r.personName, p);
  }
  return NextResponse.json({ people: [...people.values()] });
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
    await prisma.voiceProfile.create({
      data: {
        userId: user.id,
        personName: name,
        embedding: JSON.stringify(result.embedding),
        durationS: result.durationS,
        source: 'enrollment',
        deviceLabel,
      },
    });
    saved += 1;
  }

  if (saved === 0) {
    return NextResponse.json({ error: errors[0] ?? 'No usable samples.', errors }, { status: 422 });
  }
  return NextResponse.json({ ok: true, saved, errors });
}

// Remove a person's voice profiles: ?name=...
export async function DELETE(request: NextRequest) {
  const user = await getAuthUser();
  if (!user) return NextResponse.json({ error: 'Not authenticated.' }, { status: 401 });

  const name = request.nextUrl.searchParams.get('name')?.trim();
  if (!name) return NextResponse.json({ error: 'name query param required.' }, { status: 400 });

  const deleted = await prisma.voiceProfile.deleteMany({ where: { personName: name } });
  return NextResponse.json({ ok: true, deleted: deleted.count });
}
