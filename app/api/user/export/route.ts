import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { getAuthUser } from '@/lib/auth';
import { logAudit, requestIp } from '@/lib/audit';
import { rateLimit } from '@/lib/rate-limit';

export const dynamic = 'force-dynamic';

/**
 * GDPR data-access export: everything this user owns, as one JSON download.
 * Recordings with transcripts and summaries, plus voice-profile metadata
 * (biometric enrolments are listed, but raw embeddings / audio bytes stay out
 * of a casually-downloadable file — they serve no data-subject purpose and
 * would be a leak vector).
 */
export async function GET(req: NextRequest) {
  const user = await getAuthUser();
  if (!user) return NextResponse.json({ error: 'Not authenticated.' }, { status: 401 });

  const limited = rateLimit(`user-export:${user.id}`, 5, 60 * 60 * 1000);
  if (!limited.ok) {
    return NextResponse.json(
      { error: 'Export limit reached — try again later.' },
      { status: 429, headers: { 'Retry-After': String(limited.retryAfterS) } },
    );
  }

  const [recordings, voiceProfiles] = await Promise.all([
    prisma.recording.findMany({
      where: { userId: user.id, deletedAt: null },
      orderBy: { createdAt: 'asc' },
      select: {
        id: true,
        title: true,
        status: true,
        source: true,
        meetingType: true,
        duration: true,
        createdAt: true,
        transcript: { select: { fullText: true, segments: true, language: true } },
        summary: {
          select: {
            overview: true,
            keyPoints: true,
            actionItems: true,
            decisions: true,
          },
        },
      },
    }),
    prisma.voiceProfile.findMany({
      where: { userId: user.id },
      orderBy: { createdAt: 'asc' },
      select: { personName: true, source: true, durationS: true, deviceLabel: true, createdAt: true },
    }),
  ]);

  await logAudit({
    userId: user.id,
    userEmail: user.email,
    action: 'user.export_data',
    targetType: 'user',
    targetId: user.id,
    ip: requestIp(req),
    metadata: { recordings: recordings.length, voiceProfiles: voiceProfiles.length },
  });

  return NextResponse.json(
    {
      exportedAt: new Date().toISOString(),
      user: { id: user.id, email: user.email },
      recordings,
      voiceProfiles,
    },
    {
      headers: {
        'Content-Disposition': `attachment; filename="transcribe-export-${new Date().toISOString().slice(0, 10)}.json"`,
        'Cache-Control': 'no-store',
      },
    },
  );
}
