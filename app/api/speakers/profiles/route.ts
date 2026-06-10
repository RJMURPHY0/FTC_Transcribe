import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { getAuthUser } from '@/lib/auth';
import { extractFeatures } from '@/lib/speaker-profiles';
import type { TranscriptSegment } from '@/lib/ai';

export const dynamic = 'force-dynamic';

export async function GET() {
  const user = await getAuthUser();
  const profiles = await prisma.speakerProfile.findMany({
    where:   { userId: user?.id ?? undefined },
    orderBy: { sampleCount: 'desc' },
    select:  { id: true, name: true, sampleCount: true, createdAt: true },
  });
  return NextResponse.json(profiles);
}

export async function POST(req: NextRequest) {
  const user = await getAuthUser();
  const body = await req.json() as {
    name:         string;
    recordingId:  string;
    speakerLabel: string;
  };

  if (!body.name?.trim()) {
    return NextResponse.json({ error: 'Name required.' }, { status: 400 });
  }

  // Extract features from the recording's transcript for this speaker
  const transcript = await prisma.transcript.findUnique({
    where:  { recordingId: body.recordingId },
    select: { segments: true },
  });

  let features = { avgSegDuration: 0, avgPause: 0, speakingRate: 0, topWords: [] as string[] };
  if (transcript?.segments) {
    try {
      const allSegs = JSON.parse(transcript.segments) as TranscriptSegment[];
      const speakerSegs = allSegs.filter(s => String(s.speaker) === String(body.speakerLabel));
      if (speakerSegs.length) features = extractFeatures(speakerSegs);
    } catch { /* ignore parse errors */ }
  }

  const profile = await prisma.speakerProfile.create({
    data: {
      userId:      user?.id ?? null,
      name:        body.name.trim(),
      features:    JSON.stringify(features),
      sampleCount: 1,
    },
  });

  return NextResponse.json({ id: profile.id });
}
