import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { getAuthUser, canAccessRecording } from '@/lib/auth';
import { logAudit, requestIp } from '@/lib/audit';
import { meetingDocFrom, exportFilename, readDocLogo } from '@/lib/export-doc';
import { renderMeetingPdf } from '@/lib/export-pdf';

export const dynamic = 'force-dynamic';
// PDF generation is CPU-intensive — use Node.js runtime (default), not Edge
export const runtime = 'nodejs';

const CUID_RE = /^c[a-z0-9]{20,}$/;

export async function GET(
  _req: NextRequest,
  { params }: { params: { id: string } },
) {
  if (!CUID_RE.test(params.id)) {
    return NextResponse.json({ error: 'Invalid recording ID.' }, { status: 400 });
  }

  const user = await getAuthUser();

  const recording = await prisma.recording
    .findUnique({ where: { id: params.id }, include: { summary: true } })
    .catch(() => null);

  if (!recording || recording.deletedAt) {
    return NextResponse.json({ error: 'Recording not found.' }, { status: 404 });
  }
  // Same visibility rule as the recording page: owner, unclaimed, or can-see-all.
  if (!canAccessRecording(recording.userId, user)) {
    return NextResponse.json({ error: 'Not allowed.' }, { status: 403 });
  }

  await logAudit({
    userId: user?.id,
    userEmail: user?.email,
    action: 'recording.export',
    targetType: 'recording',
    targetId: params.id,
    ip: requestIp(_req),
    metadata: { format: 'pdf' },
  });

  let buffer: Buffer;
  try {
    buffer = await renderMeetingPdf(meetingDocFrom(recording), await readDocLogo());
  } catch (err) {
    console.error('[pdf-export] render error:', err);
    return NextResponse.json({ error: 'Failed to generate PDF.' }, { status: 500 });
  }

  return new NextResponse(new Uint8Array(buffer), {
    headers: {
      'Content-Type':        'application/pdf',
      'Content-Disposition': `attachment; filename="${exportFilename(recording.title)}.pdf"`,
      'Cache-Control':       'no-store',
    },
  });
}
