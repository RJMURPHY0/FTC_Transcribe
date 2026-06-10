import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { getAuthUser } from '@/lib/auth';

export const dynamic = 'force-dynamic';

export async function GET() {
  const user = await getAuthUser().catch((e: unknown) => ({ error: String(e) }));

  let dbInfo: Record<string, unknown> = {};
  try {
    const total = await prisma.recording.count();
    const nullUser = await prisma.recording.count({ where: { userId: null } });
    const byUser = await prisma.$queryRaw<{ userId: string | null; count: bigint }[]>`
      SELECT "userId", COUNT(*) as count FROM "Recording" GROUP BY "userId"`;
    dbInfo = {
      total,
      nullUser,
      byUser: byUser.map(r => ({ userId: r.userId, count: Number(r.count) })),
    };
  } catch (e) {
    dbInfo = { error: String(e) };
  }

  return NextResponse.json({ user, db: dbInfo });
}
