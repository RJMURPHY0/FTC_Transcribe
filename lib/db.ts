import { PrismaClient } from '@prisma/client';

const globalForPrisma = globalThis as unknown as { prisma: PrismaClient };

export const prisma = globalForPrisma.prisma || new PrismaClient();

const dbUrl = process.env.DATABASE_URL ?? '';
if (process.env.NODE_ENV === 'production' && dbUrl && !dbUrl.includes('supabase.co')) {
  console.warn('[db] DATABASE_URL does not look like Supabase; recordings/transcripts may not be in Supabase.');
}

if (process.env.NODE_ENV !== 'production') globalForPrisma.prisma = prisma;

// ── Transient-failure retry ──────────────────────────────────────────────────
// On Vercel serverless + the Supabase pooler, a cold lambda occasionally can't
// reach the DB or times out grabbing a pooled connection. These blips are
// retryable — the same query succeeds a moment later. Without this, a single
// blip was swallowed into an empty result and the user saw "No recordings yet"
// even though their meetings were safe in the database.
const TRANSIENT_SIGNATURES = [
  'P1001', // can't reach database server
  'P1002', // server reached but timed out
  'P1008', // operations timed out
  'P1017', // server closed the connection
  'P2024', // timed out fetching a connection from the pool
  "can't reach database",
  'connection', 'econnreset', 'etimedout', 'timed out',
  'terminating connection', 'server closed', 'too many clients',
];

function isTransient(err: unknown): boolean {
  const code = (err as { code?: string })?.code ?? '';
  const msg  = (err instanceof Error ? err.message : String(err)).toLowerCase();
  return TRANSIENT_SIGNATURES.some(s => code === s || msg.includes(s.toLowerCase()));
}

/**
 * Run a read/idempotent DB operation, retrying transient connection failures.
 * Non-transient errors (bad query, constraint violation) rethrow immediately so
 * real bugs still fail fast. Defaults: 3 attempts, 150ms → 450ms backoff.
 */
export async function withDbRetry<T>(
  op: () => Promise<T>,
  attempts = 3,
): Promise<T> {
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await op();
    } catch (err) {
      lastErr = err;
      if (!isTransient(err) || i === attempts - 1) throw err;
      await new Promise(r => setTimeout(r, 150 * (i + 1)));
    }
  }
  throw lastErr;
}
