import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { diarizeSegments, identifySpeakerNames } from '@/lib/ai';
import type { TranscriptSegment, RawSegment } from '@/lib/ai';
import { reanalyzeSpeakers } from '@/lib/finalize-recording';

export const dynamic = 'force-dynamic';
export const maxDuration = 800;

const CUID_RE = /^c[a-z0-9]{20,}$/;

export async function POST(
  _req: NextRequest,
  { params }: { params: { id: string } },
) {
  if (!CUID_RE.test(params.id)) {
    return NextResponse.json({ error: 'Invalid ID' }, { status: 400 });
  }

  // Preferred path: acoustic voice separation. Re-clusters this recording's
  // stored per-turn voiceprints and re-matches them against the CURRENT set of
  // enrolled voice profiles, so voices learned since the meeting was processed
  // are applied and the transcript is split by who actually spoke — not by an
  // LLM guessing from the text. Falls through for legacy meetings that captured
  // no voiceprints.
  try {
    const voice = await reanalyzeSpeakers(params.id);
    if (voice.resolved) {
      return NextResponse.json({ ok: true, method: 'voice' });
    }
  } catch (err) {
    console.warn('[rediarize] voice re-analysis failed, falling back to text:', err);
  }

  // Fallback: LLM text diarization on the transcript. Used only when there is no
  // acoustic data to work from (older meetings recorded before voiceprints were
  // captured, mobile imports, or voice ID disabled).
  const transcript = await prisma.transcript.findUnique({
    where: { recordingId: params.id },
  });

  if (!transcript) {
    return NextResponse.json({ error: 'No transcript found for this recording.' }, { status: 404 });
  }

  let existing: TranscriptSegment[] = [];
  try {
    existing = JSON.parse(transcript.segments) as TranscriptSegment[];
  } catch {
    return NextResponse.json({ error: 'Could not parse transcript segments.' }, { status: 500 });
  }

  if (!existing.length) {
    return NextResponse.json({ error: 'Transcript has no segments to diarise.' }, { status: 400 });
  }

  // Strip speaker labels — we only need the raw audio-derived timing and text
  const rawSegments: RawSegment[] = existing.map(s => ({
    start: s.start,
    end: s.end,
    text: s.text,
  }));

  try {
    const diarized = await diarizeSegments(rawSegments);
    const speakerNames = await identifySpeakerNames(diarized);
    const finalSegments = Object.keys(speakerNames).length > 0
      ? diarized.map(seg => ({ ...seg, speaker: speakerNames[seg.speaker] ?? seg.speaker }))
      : diarized;

    await prisma.transcript.update({
      where: { recordingId: params.id },
      data: { segments: JSON.stringify(finalSegments) },
    });

    return NextResponse.json({ ok: true, method: 'text' });
  } catch (err) {
    console.error('[rediarize]', err);
    return NextResponse.json({ error: 'Diarization failed.' }, { status: 500 });
  }
}
