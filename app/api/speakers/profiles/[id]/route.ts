import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { getAuthUser } from '@/lib/auth';

export const dynamic = 'force-dynamic';

// DELETE /api/speakers/profiles/[id]
export async function DELETE(
  _req: NextRequest,
  { params }: { params: { id: string } },
) {
  const user = await getAuthUser();

  const profile = await prisma.speakerProfile.findUnique({ where: { id: params.id } });
  if (!profile) return NextResponse.json({ error: 'Not found.' }, { status: 404 });

  // Only delete own profiles (null userId = any user can delete for anon mode)
  if (user?.id && profile.userId && profile.userId !== user.id) {
    return NextResponse.json({ error: 'Forbidden.' }, { status: 403 });
  }

  await prisma.speakerProfile.delete({ where: { id: params.id } });
  return NextResponse.json({ ok: true });
}
