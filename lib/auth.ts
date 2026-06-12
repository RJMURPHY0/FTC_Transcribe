import { createClient } from '@/lib/supabase/server';
import { prisma } from '@/lib/db';

export interface AuthUser {
  id: string;
  email: string;
  canSeeAll: boolean;
}

export async function getAuthUser(): Promise<AuthUser | null> {
  const supabase = await createClient();
  // getSession reads the cookie directly (no network call); safe because
  // middleware already validated the JWT with getUser() on every request.
  const { data: { session } } = await supabase.auth.getSession();
  const user = session?.user;
  if (!user) return null;

  // Super admin email always gets full access, regardless of DB row
  const SUPER_ADMIN_EMAIL = 'ryan.murphy@ftc-ss.com';
  let canSeeAll = user.email === SUPER_ADMIN_EMAIL;

  if (!canSeeAll) {
    try {
      const perm = await prisma.transcribePermission.findUnique({
        where: { userId: user.id },
        select: { canSeeAll: true },
      });
      canSeeAll = perm?.canSeeAll ?? false;
    } catch { /* table may not exist in dev */ }
  }

  return { id: user.id, email: user.email ?? '', canSeeAll };
}
