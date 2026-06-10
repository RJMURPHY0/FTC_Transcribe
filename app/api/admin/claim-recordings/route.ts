import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { getAuthUser } from '@/lib/auth';

export const dynamic = 'force-dynamic';

// One-time migration: assigns all unowned recordings and folders to the calling user.
// Safe to call multiple times — only touches rows where userId IS NULL.
export async function POST() {
  const user = await getAuthUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const [recordings, folders] = await Promise.all([
    prisma.recording.updateMany({
      where: { userId: null },
      data: { userId: user.id },
    }),
    prisma.folder.updateMany({
      where: { userId: null },
      data: { userId: user.id },
    }),
  ]);

  return NextResponse.json({
    ok: true,
    recordingsClaimed: recordings.count,
    foldersClaimed: folders.count,
  });
}
