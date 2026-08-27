// Who may read which recording.
//
// Dependency-free, and separate from lib/auth for the same reason
// lib/audio-errors is separate from lib/transcribe-chunk: this is the rule the
// whole product's confidentiality rests on, and it should be readable and
// testable without booting React, Supabase or Prisma behind it.
//
// Prisma connects as the Postgres role and bypasses RLS entirely, so there is
// no database-level net underneath this. It is the boundary.

/** The viewer, reduced to just what the decision needs. */
export interface AccessSubject {
  id: string;
  canSeeAll: boolean;
  isSuperAdmin: boolean;
  orgId: string | null;
}

/** The two fields every per-recording route must select to be checkable. */
export interface RecordingOwnership {
  userId: string | null;
  orgId: string | null;
}

/**
 * Row-level visibility rule for a recording.
 *
 * Access is granted to the owner, to anyone for an unclaimed (null-owner,
 * legacy) recording, or to an admin with canSeeAll — but only within that
 * admin's OWN organisation.
 *
 * Middleware only proves a user is logged in, never WHICH user owns WHICH row,
 * so every per-recording route must call this itself.
 * scripts/check-recording-access.js fails the build if a route under
 * app/api/recordings/[id] forgets.
 *
 * The parameter is an object rather than a bare userId so that TypeScript
 * forces each caller to fetch `orgId` too. A route that supplied only the owner
 * id would silently skip the tenant check, which is precisely the kind of gap
 * that stays invisible until it is one customer's meetings in another's list.
 */
export function canAccessRecording(
  recording: RecordingOwnership,
  user: AccessSubject | null,
): boolean {
  if (!user) return false;
  // Owner, or an unclaimed legacy row.
  if (!recording.userId || recording.userId === user.id) return true;
  if (!user.canSeeAll) return false;
  // canSeeAll means "everyone in my organisation", not "everyone on the
  // platform". The super admin is the single deliberate exception, and the
  // only route to a cross-tenant read.
  if (user.isSuperAdmin) return true;
  if (!recording.orgId || !user.orgId) return false;
  return recording.orgId === user.orgId;
}
