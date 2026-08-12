import { prisma } from '@/lib/db';
import { getUserOrgId } from '@/lib/contacts-db';

/**
 * Append-only audit trail for user-visible actions. Rows carry the actor, the
 * Contacts org they belong to (Transcribe hangs off the Contacts org tables),
 * the target, and the caller IP.
 *
 * A failed audit write must never fail the action it describes — errors are
 * logged and swallowed. Awaited (not fire-and-forget) because Vercel kills
 * pending promises once the response is sent.
 */
export async function logAudit(entry: {
  userId?: string | null;
  userEmail?: string | null;
  action: string;          // dot-namespaced, e.g. 'recording.delete'
  targetType?: string;     // e.g. 'recording', 'voiceProfile'
  targetId?: string;
  ip?: string | null;
  metadata?: Record<string, unknown>;
}): Promise<void> {
  try {
    const orgId = entry.userId ? await getUserOrgId(entry.userId) : null;
    await prisma.auditLog.create({
      data: {
        userId: entry.userId ?? null,
        userEmail: entry.userEmail ?? null,
        orgId,
        action: entry.action,
        targetType: entry.targetType ?? null,
        targetId: entry.targetId ?? null,
        ip: entry.ip ?? null,
        metadata: entry.metadata ? JSON.stringify(entry.metadata) : null,
      },
    });
  } catch (err) {
    console.error('[audit] write failed:', err instanceof Error ? err.message : err);
  }
}

/** Caller IP as Vercel reports it (first hop of x-forwarded-for). */
export function requestIp(req: { headers: { get(name: string): string | null } }): string | null {
  const fwd = req.headers.get('x-forwarded-for');
  if (fwd) return fwd.split(',')[0].trim();
  return req.headers.get('x-real-ip');
}
