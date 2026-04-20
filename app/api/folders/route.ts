import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db';

export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    const folders = await prisma.folder.findMany({
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
    const folder = await prisma.folder.create({ data: { name } });
    return NextResponse.json(folder);
  } catch {
    return NextResponse.json({ error: 'Failed to create folder.' }, { status: 500 });
  }
}
