import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { getAuthUser } from '@/lib/auth';

export const dynamic = 'force-dynamic';

// Stream a stored enrollment clip so the user can hear exactly what trained
// the voiceprint. Meeting-derived samples play via /api/recordings/[id]/audio.
export async function GET(request: NextRequest) {
  const user = await getAuthUser();
  if (!user) return NextResponse.json({ error: 'Not authenticated.' }, { status: 401 });

  const id = request.nextUrl.searchParams.get('id')?.trim();
  if (!id) return NextResponse.json({ error: 'id query param required.' }, { status: 400 });

  const row = await prisma.voiceProfile.findUnique({
    where: { id },
    select: { audioData: true, audioMime: true },
  });
  if (!row?.audioData?.length) {
    return NextResponse.json({ error: 'No clip stored for this sample.' }, { status: 404 });
  }

  return new NextResponse(new Uint8Array(row.audioData), {
    headers: {
      'Content-Type':   row.audioMime || 'audio/webm',
      'Content-Length': String(row.audioData.length),
      'Cache-Control':  'private, max-age=3600',
    },
  });
}
