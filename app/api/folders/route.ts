import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { getAuthUser } from '@/lib/auth';

export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    const user = await getAuthUser();
    if (!user) return NextResponse.json({ error: 'Not authenticated.' }, { status: 401 });
    const folders = await prisma.folder.findMany({
      // Mirror the home page's folderScope: can-see-all admins see every
      // folder, everyone else sees their own.
      where: user.canSeeAll ? {} : { userId: user.id },
      orderBy: { createdAt: 'asc' },
      include: { _count: { select: { recordings: true } } },
    });
    return NextResponse.json(folders);
  } catch {
    return NextResponse.json({ error: 'Failed to fetch folders.' }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json() as { name?: unknown };
    const name = typeof body.name === 'string' ? body.name.trim().slice(0, 80) : '';
    if (!name) return NextResponse.json({ error: 'Folder name required.' }, { status: 400 });
    const user = await getAuthUser();
    const folder = await prisma.folder.create({ data: { name, userId: user?.id ?? null } });
    return NextResponse.json(folder);
  } catch {
    return NextResponse.json({ error: 'Failed to create folder.' }, { status: 500 });
  }
}
