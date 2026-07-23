import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { getAuthUser } from '@/lib/auth';
import { getAdminClient } from '@/lib/supabase/admin';

export const dynamic = 'force-dynamic';

const CUID_RE = /^c[a-z0-9]{20,}$/;

function extForMime(mime: string): string {
  return mime.includes('mp4') ? '.mp4' : mime.includes('ogg') ? '.ogg' : '.webm';
}

function safeFilename(title: string, ext: string): string {
  const base = title.replace(/[^\w\- ]+/g, '').trim().slice(0, 80) || 'recording';
  return `${base}${ext}`;
}

export async function GET(
  req: NextRequest,
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
    select: { userId: true, audioPath: true, deletedAt: true, title: true },
  });
  if (!recording || recording.deletedAt) {
    return NextResponse.json({ error: 'Recording not found.' }, { status: 404 });
  }
  // Same visibility rule as the recording page: owner, unclaimed, or can-see-all.
  if (recording.userId && recording.userId !== user.id && !user.canSeeAll) {
    return NextResponse.json({ error: 'Not allowed.' }, { status: 403 });
  }

  const wantsDownload = req.nextUrl.searchParams.get('download') === '1';

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

    const mime = chunks[0].mimeType || 'audio/webm';
    const baseHeaders: Record<string, string> = {
      'Content-Type':  mime,
      // Audio bytes for a recording never change — let the browser cache them
      // so replays and seeks don't re-pull every chunk from the database.
      'Cache-Control': 'private, max-age=3600',
      'Accept-Ranges': 'bytes',
    };
    if (wantsDownload) {
      baseHeaders['Content-Disposition'] = `attachment; filename="${safeFilename(recording.title, extForMime(mime))}"`;
    }

    // Honour Range so <audio> can seek without restarting from byte 0 —
    // advertising Accept-Ranges while returning 200s makes browsers loop.
    const range = req.headers.get('range');
    const m = range?.match(/^bytes=(\d*)-(\d*)$/);
    if (m && (m[1] || m[2])) {
      let start: number;
      let end: number;
      if (m[1]) {
        start = parseInt(m[1], 10);
        end = m[2] ? Math.min(parseInt(m[2], 10), totalLength - 1) : totalLength - 1;
      } else {
        // suffix form: last N bytes
        start = Math.max(totalLength - parseInt(m[2], 10), 0);
        end = totalLength - 1;
      }
      if (start >= totalLength || start > end) {
        return new NextResponse(null, {
          status: 416,
          headers: { 'Content-Range': `bytes */${totalLength}` },
        });
      }
      return new NextResponse(merged.slice(start, end + 1), {
        status: 206,
        headers: {
          ...baseHeaders,
          'Content-Range':  `bytes ${start}-${end}/${totalLength}`,
          'Content-Length': String(end - start + 1),
        },
      });
    }

    return new NextResponse(merged, {
      headers: { ...baseHeaders, 'Content-Length': String(totalLength) },
    });
  }

  // Archived audio lives in Supabase Storage — redirect to a short-lived
  // signed URL so bytes stream straight from storage (Range support included).
  if (recording.audioPath) {
    const admin = getAdminClient();
    if (admin) {
      const [bucket, ...rest] = recording.audioPath.split('/');
      const storagePath = rest.join('/');
      const ext = storagePath.includes('.') ? `.${storagePath.split('.').pop()}` : '.webm';
      const { data, error } = await admin.storage
        .from(bucket)
        .createSignedUrl(
          storagePath,
          3600,
          wantsDownload ? { download: safeFilename(recording.title, ext) } : undefined,
        );
      if (!error && data?.signedUrl) {
        return NextResponse.redirect(data.signedUrl, 307);
      }
    }
  }

  return NextResponse.json({ error: 'No audio found.' }, { status: 404 });
}
