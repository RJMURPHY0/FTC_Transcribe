import { createClient } from '@/lib/supabase/server';
import { prisma } from '@/lib/db';

export interface AuthUser {
  id: string;
  email: string;
  canSeeAll: boolean;
}

export async function getAuthUser(): Promise<AuthUser | null> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return null;

  let canSeeAll = false;
  try {
    const perm = await prisma.transcribePermission.findUnique({
      where: { userId: user.id },
      select: { canSeeAll: true },
    });
    canSeeAll = perm?.canSeeAll ?? false;
  } catch { /* table may not exist in dev */ }

  return { id: user.id, email: user.email ?? '', canSeeAll };
}
