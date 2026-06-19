import { createClient } from '@/lib/supabase/server';
import { prisma } from '@/lib/db';

export interface AuthUser {
  id: string;
  email: string;
  canSeeAll: boolean;
}

// In-process permission cache — avoids a DB round-trip on every server render.
// TTL is 5 min; permissions change rarely (super-admin only writes them).
const permCache = new Map<string, { canSeeAll: boolean; expires: number }>();
const PERM_TTL_MS = 5 * 60 * 1000;

const SUPER_ADMIN_EMAIL = 'ryan.murphy@ftc-ss.com';

export async function getAuthUser(): Promise<AuthUser | null> {
  const supabase = await createClient();
  // getSession reads the cookie directly (no network call); safe because
  // middleware already validated the JWT on every request.
  const { data: { session } } = await supabase.auth.getSession();
  const user = session?.user;
  if (!user) return null;

  if (user.email === SUPER_ADMIN_EMAIL) {
    return { id: user.id, email: user.email, canSeeAll: true };
  }

  const cached = permCache.get(user.id);
  if (cached && cached.expires > Date.now()) {
    return { id: user.id, email: user.email ?? '', canSeeAll: cached.canSeeAll };
  }

  let canSeeAll = false;
  try {
    const perm = await prisma.transcribePermission.findUnique({
      where: { userId: user.id },
      select: { canSeeAll: true },
    });
    canSeeAll = perm?.canSeeAll ?? false;
  } catch { /* table may not exist in dev */ }

  permCache.set(user.id, { canSeeAll, expires: Date.now() + PERM_TTL_MS });

  return { id: user.id, email: user.email ?? '', canSeeAll };
}
