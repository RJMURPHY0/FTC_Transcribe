import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { getAuthUser, canAccessRecording } from '@/lib/auth';
import { cosineSim, LEGACY_MODEL_VERSION } from '@/lib/voice-id';
import { createVoiceProfileTagged } from '@/lib/voice-profile-store';
import type { TranscriptSegment } from '@/lib/ai';

export const dynamic = 'force-dynamic';

const CUID_RE = /^c[a-z0-9]{20,}$/;

export async function PATCH(
  req: NextRequest,
  { params }: { params: { id: string } },
) {
  if (!CUID_RE.test(params.id)) {
    return NextResponse.json({ error: 'Invalid ID' }, { status: 400 });
  }

  const body = await req.json() as { renames?: unknown };
  const raw = body.renames;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return NextResponse.json({ error: 'renames must be an object mapping old names to new names.' }, { status: 400 });
  }

  // Sanitise: values must be non-empty strings, max 80 chars
  const renames: Record<string, string> = {};
  for (const [from, to] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof to === 'string' && to.trim()) {
      renames[from] = to.trim().slice(0, 80);
    }
  }

  if (!Object.keys(renames).length) {
    return NextResponse.json({ error: 'No valid renames provided.' }, { status: 400 });
  }

  const transcript = await prisma.transcript.findUnique({
    where: { recordingId: params.id },
  });

  if (!transcript) {
    return NextResponse.json({ error: 'No transcript found.' }, { status: 404 });
  }

  let segments: TranscriptSegment[] = [];
  try {
    const parsed = JSON.parse(transcript.segments) as unknown;
    if (!Array.isArray(parsed)) {
      return NextResponse.json({ error: 'Could not parse segments.' }, { status: 500 });
    }
    segments = parsed as TranscriptSegment[];
  } catch {
    return NextResponse.json({ error: 'Could not parse segments.' }, { status: 500 });
  }

  const user = await getAuthUser();
  const rec = await prisma.recording.findUnique({
    where: { id: params.id },
    select: { userId: true, deletedAt: true },
  });
  if (!rec || rec.deletedAt) {
    return NextResponse.json({ error: 'Recording not found.' }, { status: 404 });
  }
  if (!canAccessRecording(rec.userId, user)) {
    return NextResponse.json({ error: 'Not allowed.' }, { status: 403 });
  }

  const updated = segments.map(seg => ({
    ...seg,
    speaker: renames[seg.speaker] ?? seg.speaker,
  }));

  await prisma.transcript.update({
    where: { recordingId: params.id },
    data: { segments: JSON.stringify(updated) },
  });

  // Relearn loop: renaming "Speaker 2" → "Dave" teaches the system Dave's voice.
  // The recording's stored voiceprint for that speaker becomes a VoiceProfile,
  // so future recordings auto-label Dave without any enrollment.
  try {
    const embeddings = await prisma.speakerEmbedding.findMany({ where: { recordingId: params.id } });
    for (const [from, to] of Object.entries(renames)) {
      if (/^Speaker \d+$/i.test(to)) continue; // renaming to a generic label teaches nothing
      const row = embeddings.find(e => e.speakerLabel === from);
      if (!row) continue;

      let rowEmbedding: number[];
      try { rowEmbedding = JSON.parse(row.embedding) as number[]; } catch { continue; }

      // Skip if we already have a near-identical sample for this person
      const existing = await prisma.voiceProfile.findMany({
        where: { personName: to },
        select: { embedding: true },
      });
      const isDuplicate = existing.some(p => {
        try { return cosineSim(rowEmbedding, JSON.parse(p.embedding) as number[]) > 0.95; }
        catch { return false; }
      });

      if (!isDuplicate) {
        const excerpt = updated
          .filter(seg => seg.speaker === to)
          .map(seg => seg.text)
          .join(' ')
          .slice(0, 300);
        // Tag with the SOURCE embedding's model space — a relabel on an old
        // CAM++ recording produces a CAM++ sample, not a current-model one.
        let rowVersion = LEGACY_MODEL_VERSION;
        try {
          const v = await prisma.$queryRaw<Array<{ modelVersion: string }>>`
            SELECT "modelVersion" FROM "SpeakerEmbedding" WHERE "id" = ${row.id}`;
          if (v[0]?.modelVersion) rowVersion = v[0].modelVersion;
        } catch { /* column missing */ }
        await createVoiceProfileTagged({
          userId: user?.id ?? null,
          personName: to,
          embedding: row.embedding,
          durationS: row.durationS,
          source: 'relabel',
          recordingId: params.id,
          excerpt,
        }, rowVersion);
      }
      await prisma.speakerEmbedding.update({
        where: { id: row.id },
        data: { speakerLabel: to },
      });
    }
  } catch (err) {
    console.warn('[speakers] voiceprint relearn failed:', err);
  }

  return NextResponse.json({ ok: true });
}
