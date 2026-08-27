import { cache } from 'react';
import { createClient as createSupabaseClient } from '@supabase/supabase-js';
import { createClient } from '@/lib/supabase/server';
import { prisma } from '@/lib/db';
import { getUserOrgId } from '@/lib/contacts-db';

export interface AuthUser {
  id: string;
  email: string;
  canSeeAll: boolean;
  canPlayAudio: boolean;
  // True only for the super-admin email. Distinct from canSeeAll
  // (which other admins may also hold): only the super-admin sets the global
  // default for app-wide preferences like card animations.
  isSuperAdmin: boolean;
  // The viewer's Contacts organisation. Bounds what canSeeAll can reach, so an
  // admin at one customer cannot list another customer's meetings. Null for a
  // user in no org, which then only ever sees their own recordings.
  orgId: string | null;
}

// In-process permission cache — avoids a DB round-trip on every server render.
// TTL is 5 min; permissions change rarely (super-admin only writes them).
const permCache = new Map<string, { canSeeAll: boolean; canPlayAudio: boolean; orgId: string | null; expires: number }>();
const PERM_TTL_MS = 5 * 60 * 1000;

// Overridable per environment; the literal fallback keeps existing deploys
// working until SUPER_ADMIN_EMAIL is set in Vercel.
const SUPER_ADMIN_EMAIL = process.env.SUPER_ADMIN_EMAIL || 'ryan.murphy@ftc-ss.com';

// getUser() verifies the JWT with the Supabase Auth server rather than
// trusting the cookie contents (getSession decodes without verification, so a
// crafted cookie could impersonate any user). This is the app's only auth
// boundary — middleware just redirects for UX. cache() dedupes the network
// round-trip across a single server render pass, so pages that call
// getAuthUser in several components still verify once per request.
export const getAuthUser = cache(async (): Promise<AuthUser | null> => {
  const supabase = await createClient();
  let user = null;
  try {
    const { data, error } = await supabase.auth.getUser();
    if (!error) user = data.user;
  } catch {
    // Auth server unreachable — treat as unauthenticated rather than trusting
    // an unverifiable cookie.
  }
  if (!user) return null;

  if (user.email === SUPER_ADMIN_EMAIL) {
    return {
      id: user.id, email: user.email, canSeeAll: true, canPlayAudio: true,
      isSuperAdmin: true, orgId: await getUserOrgId(user.id).catch(() => null),
    };
  }

  const cached = permCache.get(user.id);
  if (cached && cached.expires > Date.now()) {
    return {
      id: user.id, email: user.email ?? '', canSeeAll: cached.canSeeAll,
      canPlayAudio: cached.canPlayAudio, isSuperAdmin: false, orgId: cached.orgId,
    };
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

  // Cached alongside the permission flags: both come from the same rarely
  // changing source and both are needed on every render that lists recordings.
  const orgId = await getUserOrgId(user.id).catch(() => null);

  permCache.set(user.id, { canSeeAll, canPlayAudio, orgId, expires: Date.now() + PERM_TTL_MS });

  return { id: user.id, email: user.email ?? '', canSeeAll, canPlayAudio, isSuperAdmin: false, orgId };
});

/**
 * Verify a desktop/native client from an `Authorization: Bearer <token>`
 * header instead of a cookie.
 *
 * Same boundary as getAuthUser(): the token is checked against the Supabase
 * Auth server, never decoded and trusted. Separate function because desktop
 * clients carry no cookies, so createClient()'s cookie jar has nothing to read.
 * Routes using this must also be listed in middleware's public allowlist, or
 * the cookie-less request is redirected to /login before it ever runs.
 * Not wrapped in cache(): a request carries one token, and these routes are
 * called once per request rather than from a render tree.
 */
export async function getBearerUser(request: Request): Promise<AuthUser | null> {
  const header = request.headers.get('authorization') ?? '';
  const token = header.toLowerCase().startsWith('bearer ') ? header.slice(7).trim() : '';
  if (!token) return null;
  if (!process.env.NEXT_PUBLIC_SUPABASE_URL || !process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY) return null;

  let user = null;
  try {
    const supabase = createSupabaseClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
      { auth: { persistSession: false, autoRefreshToken: false } },
    );
    const { data, error } = await supabase.auth.getUser(token);
    if (!error) user = data.user;
  } catch {
    // Auth server unreachable: treat as unauthenticated rather than guessing.
  }
  if (!user) return null;

  const orgId = await getUserOrgId(user.id).catch(() => null);
  if (user.email === SUPER_ADMIN_EMAIL) {
    return { id: user.id, email: user.email, canSeeAll: true, canPlayAudio: true, isSuperAdmin: true, orgId };
  }
  return { id: user.id, email: user.email ?? '', canSeeAll: false, canPlayAudio: true, isSuperAdmin: false, orgId };
}

/**
 * Accept either transport: cookie session first (the web app), falling back to
 * a bearer token (the desktop app). Routes shared by both call this.
 */
export async function getAnyUser(request: Request): Promise<AuthUser | null> {
  return (await getAuthUser()) ?? (await getBearerUser(request));
}

// The access rule lives in its own dependency-free module so it can be read and
// tested without React/Supabase/Prisma in the way. Re-exported here because
// every route already imports it alongside getAuthUser.
export { canAccessRecording } from '@/lib/recording-access';
export type { RecordingOwnership } from '@/lib/recording-access';
