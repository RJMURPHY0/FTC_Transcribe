import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { prisma } from '@/lib/db';

export const dynamic = 'force-dynamic';

// One-time migration: assigns all unowned recordings and folders to the calling user.
// Accepts a Bearer token so the client-side session (which always works) can trigger this.
export async function POST(req: NextRequest) {
  const token = req.headers.get('authorization')?.replace('Bearer ', '');
  if (!token) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    { global: { headers: { Authorization: `Bearer ${token}` } } },
  );
  const { data: { user } } = await supabase.auth.getUser(token);
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
