import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { getAuthUser } from '@/lib/auth';
import { getAdminClient } from '@/lib/supabase/admin';

export const dynamic = 'force-dynamic';

const CUID_RE = /^c[a-z0-9]{20,}$/;

export async function GET(
  _req: NextRequest,
  { params }: { params: { id: string } },
) {
  if (!CUID_RE.test(params.id)) {
    return NextResponse.json({ error: 'Invalid recording ID.' }, { status: 400 });
  }

  const user = await getAuthUser();
  if (!user) return NextResponse.json({ error: 'Not authenticated.' }, { status: 401 });
  if (!user.canPlayAudio) {
    return NextResponse.json({ error: 'Audio playback is disabled for your account.' }, { status: 403 });
  }

  const recording = await prisma.recording.findUnique({
    where: { id: params.id },
    select: { userId: true, audioPath: true, deletedAt: true },
  });
  if (!recording || recording.deletedAt) {
    return NextResponse.json({ error: 'Recording not found.' }, { status: 404 });
  }
  // Same visibility rule as the recording page: owner, unclaimed, or can-see-all.
  if (recording.userId && recording.userId !== user.id && !user.canSeeAll) {
    return NextResponse.json({ error: 'Not allowed.' }, { status: 403 });
  }

  // Pre-archive recordings (and installs without a service key) keep audio in
  // the ChunkBlob table — serve it merged, exactly as during processing.
  const chunks = await prisma.chunkBlob.findMany({
    where:   { recordingId: params.id },
    orderBy: { offset: 'asc' },
    select:  { audioData: true, mimeType: true },
  });

  if (chunks.length > 0) {
    const totalLength = chunks.reduce((sum, c) => sum + c.audioData.length, 0);
    const merged = new Uint8Array(totalLength);
    let pos = 0;
    for (const chunk of chunks) {
      merged.set(new Uint8Array(chunk.audioData), pos);
      pos += chunk.audioData.length;
    }

    return new NextResponse(merged, {
      headers: {
        'Content-Type':   chunks[0].mimeType || 'audio/webm',
        'Content-Length': String(totalLength),
        'Cache-Control':  'no-store',
        'Accept-Ranges':  'bytes',
      },
    });
  }

  // Archived audio lives in Supabase Storage — redirect to a short-lived
  // signed URL so bytes stream straight from storage (Range support included).
  if (recording.audioPath) {
    const admin = getAdminClient();
    if (admin) {
      const [bucket, ...rest] = recording.audioPath.split('/');
      const { data, error } = await admin.storage
        .from(bucket)
        .createSignedUrl(rest.join('/'), 3600);
      if (!error && data?.signedUrl) {
        return NextResponse.redirect(data.signedUrl, 307);
      }
    }
  }

  return NextResponse.json({ error: 'No audio found.' }, { status: 404 });
}
