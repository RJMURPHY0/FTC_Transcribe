import { NextResponse } from 'next/server';
import { getAuthUser } from '@/lib/auth';
import { resolveLiveFx, setLiveFx } from '@/lib/user-settings';

export const dynamic = 'force-dynamic';

// GET → the current user's effective preferences (own → default → hardcoded).
export async function GET() {
  const user = await getAuthUser();
  if (!user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  const liveFx = await resolveLiveFx(user.id);
  return NextResponse.json({ liveFx, isSuperAdmin: user.isSuperAdmin });
}

// PUT { liveFx: boolean } → super-admin sets the global default; anyone else
// sets their own override.
export async function PUT(req: Request) {
  const user = await getAuthUser();
  if (!user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

  const body = await req.json().catch(() => ({}));
  if (typeof body.liveFx !== 'boolean') {
    return NextResponse.json({ error: 'liveFx (boolean) required' }, { status: 400 });
  }

  try {
    await setLiveFx(user.id, user.isSuperAdmin, body.liveFx);
  } catch {
    return NextResponse.json({ error: 'could not save' }, { status: 500 });
  }
  return NextResponse.json({ liveFx: body.liveFx, isSuperAdmin: user.isSuperAdmin });
}
