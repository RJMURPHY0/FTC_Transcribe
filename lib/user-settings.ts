import { prisma } from '@/lib/db';

// Per-user preference resolution with a super-admin-set global default.
//
//   own row (value not null)  →  DEFAULT row (value not null)  →  hardcoded
//
// The super-admin writes the DEFAULT row (applies to everyone who hasn't set
// their own); any other user writes only their own row. See lib/auth.ts
// isSuperAdmin (email-gated, distinct from canSeeAll).

const DEFAULT_ROW = 'DEFAULT';
const HARD_DEFAULT_LIVE_FX = true;

/** Resolve the effective "card animations" value for a user. */
export async function resolveLiveFx(userId: string): Promise<boolean> {
  try {
    const [own, def] = await Promise.all([
      prisma.userSetting.findUnique({ where: { userId }, select: { liveFx: true } }),
      prisma.userSetting.findUnique({ where: { userId: DEFAULT_ROW }, select: { liveFx: true } }),
    ]);
    if (own?.liveFx != null) return own.liveFx;
    if (def?.liveFx != null) return def.liveFx;
  } catch {
    // Table missing (fresh/dev DB) or transient failure — fall back to on.
  }
  return HARD_DEFAULT_LIVE_FX;
}

/**
 * Persist the "card animations" value. Super-admin writes the global DEFAULT
 * (so it becomes everyone's default); anyone else writes their own override.
 */
export async function setLiveFx(userId: string, isSuperAdmin: boolean, enabled: boolean): Promise<void> {
  const targetId = isSuperAdmin ? DEFAULT_ROW : userId;
  await prisma.userSetting.upsert({
    where: { userId: targetId },
    create: { userId: targetId, liveFx: enabled },
    update: { liveFx: enabled },
  });
}
