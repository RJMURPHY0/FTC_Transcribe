import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db';

export const dynamic = 'force-dynamic';

const CUID_RE = /^c[a-z0-9]{20,}$/;

export async function PATCH(
  request: NextRequest,
  { params }: { params: { id: string } },
) {
  if (!CUID_RE.test(params.id)) {
    return NextResponse.json({ error: 'Invalid folder ID.' }, { status: 400 });
  }
  try {
    const body = await request.json() as { name?: unknown };
    const name = typeof body.name === 'string' ? body.name.trim().slice(0, 80) : '';
    if (!name) return NextResponse.json({ error: 'Folder name required.' }, { status: 400 });
    const folder = await prisma.folder.update({ where: { id: params.id }, data: { name } });
    return NextResponse.json(folder);
  } catch {
    return NextResponse.json({ error: 'Failed to rename folder.' }, { status: 500 });
  }
}

export async function DELETE(
  _request: NextRequest,
  { params }: { params: { id: string } },
) {
  if (!CUID_RE.test(params.id)) {
    return NextResponse.json({ error: 'Invalid folder ID.' }, { status: 400 });
  }
  try {
    // Unassign recordings first, then delete folder
    await prisma.recording.updateMany({
      where: { folderId: params.id },
      data: { folderId: null },
    });
    await prisma.folder.delete({ where: { id: params.id } });
    return NextResponse.json({ ok: true });
  } catch {
    return NextResponse.json({ error: 'Failed to delete folder.' }, { status: 500 });
  }
}
