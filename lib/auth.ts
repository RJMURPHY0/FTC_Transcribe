import { createClient } from '@/lib/supabase/server';
import { prisma } from '@/lib/db';

export interface AuthUser {
  id: string;
  email: string;
  canSeeAll: boolean;
  canPlayAudio: boolean;
}

// In-process permission cache — avoids a DB round-trip on every server render.
// TTL is 5 min; permissions change rarely (super-admin only writes them).
const permCache = new Map<string, { canSeeAll: boolean; canPlayAudio: boolean; expires: number }>();
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
    return { id: user.id, email: user.email, canSeeAll: true, canPlayAudio: true };
  }

  const cached = permCache.get(user.id);
  if (cached && cached.expires > Date.now()) {
    return { id: user.id, email: user.email ?? '', canSeeAll: cached.canSeeAll, canPlayAudio: cached.canPlayAudio };
  }

  let canSeeAll = false;
  let canPlayAudio = true; // no permission row = default allowances
  try {
    const perm = await prisma.transcribePermission.findUnique({
      where: { userId: user.id },
      select: { canSeeAll: true, canPlayAudio: true },
    });
    canSeeAll = perm?.canSeeAll ?? false;
    canPlayAudio = perm?.canPlayAudio ?? true;
  } catch { /* table may not exist in dev */ }

  permCache.set(user.id, { canSeeAll, canPlayAudio, expires: Date.now() + PERM_TTL_MS });

  return { id: user.id, email: user.email ?? '', canSeeAll, canPlayAudio };
}

/**
 * Row-level visibility rule for a recording, mirroring the recording page and
 * the audio route: access is granted to the owner, to anyone for an unclaimed
 * (null-owner / legacy) recording, or to an admin with canSeeAll.
 *
 * Middleware only proves a user is logged in — it never checks WHICH user owns
 * WHICH row — so every per-recording route must call this itself. Pass the
 * recording's `userId` (most routes already fetch it, so no extra query).
 */
export function canAccessRecording(recordingUserId: string | null, user: AuthUser | null): boolean {
  if (!user) return false;
  if (recordingUserId && recordingUserId !== user.id && !user.canSeeAll) return false;
  return true;
}
