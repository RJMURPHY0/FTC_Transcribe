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

// ── Voice-training consent ────────────────────────────────────────────────────
//
// Whether the dictation desktop app may send short voice snippets here to
// train this person's voiceprint. Off until explicitly switched on: the desktop
// app keeps every recording on the device by default, and that default is a
// promise, not an oversight.
//
// Deliberately NOT a super-admin-defaultable setting like liveFx. Consent to
// process biometric data is per person and cannot be granted on their behalf,
// so there is no DEFAULT row fallback here.

/** Has this user opted in to dictation-snippet voice training? */
export async function resolveVoiceTraining(userId: string): Promise<boolean> {
  try {
    const own = await prisma.userSetting.findUnique({
      where: { userId },
      select: { voiceTraining: true },
    });
    return own?.voiceTraining === true;
  } catch {
    // Table or column missing (fresh/dev DB): fail closed.
    return false;
  }
}

/** Set this user's own consent. Never writes the DEFAULT row. */
export async function setVoiceTraining(userId: string, enabled: boolean): Promise<void> {
  await prisma.userSetting.upsert({
    where: { userId },
    create: { userId, voiceTraining: enabled },
    update: { voiceTraining: enabled },
  });
}
