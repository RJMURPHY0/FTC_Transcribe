import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { getAuthUser } from '@/lib/auth';

export const dynamic = 'force-dynamic';
// Index builds on a populated table can take a while.
export const maxDuration = 300;

// One-shot, super-admin-only endpoint to apply the performance indexes to a
// live (already-populated) database WITHOUT locking writes. CREATE INDEX
// CONCURRENTLY can't run inside a transaction, so each statement is issued on
// its own via $executeRawUnsafe (autocommit). Everything is IF NOT EXISTS, so
// re-running is a harmless no-op. Hit this once after deploying the index
// changes; the hot path never runs DDL itself.
const STATEMENTS: string[] = [
  `CREATE EXTENSION IF NOT EXISTS pg_trgm`,
  `CREATE INDEX CONCURRENTLY IF NOT EXISTS "Recording_userId_deletedAt_createdAt_idx" ON "Recording" ("userId", "deletedAt", "createdAt")`,
  `CREATE INDEX CONCURRENTLY IF NOT EXISTS "Recording_folderId_deletedAt_createdAt_idx" ON "Recording" ("folderId", "deletedAt", "createdAt")`,
  `CREATE INDEX CONCURRENTLY IF NOT EXISTS "Recording_userId_source_deletedAt_createdAt_idx" ON "Recording" ("userId", "source", "deletedAt", "createdAt")`,
  `CREATE INDEX CONCURRENTLY IF NOT EXISTS "Recording_title_trgm_idx" ON "Recording" USING gin ("title" gin_trgm_ops)`,
  `CREATE INDEX CONCURRENTLY IF NOT EXISTS "Transcript_fullText_trgm_idx" ON "Transcript" USING gin ("fullText" gin_trgm_ops)`,
];

export async function POST() {
  const user = await getAuthUser();
  if (!user) return NextResponse.json({ error: 'Not authenticated.' }, { status: 401 });
  if (!user.canSeeAll) return NextResponse.json({ error: 'Admin only.' }, { status: 403 });

  const results: { statement: string; ok: boolean; error?: string }[] = [];
  for (const sql of STATEMENTS) {
    try {
      await prisma.$executeRawUnsafe(sql);
      results.push({ statement: sql, ok: true });
    } catch (e) {
      results.push({ statement: sql, ok: false, error: e instanceof Error ? e.message : String(e) });
    }
  }

  const applied = results.filter(r => r.ok).length;
  return NextResponse.json({ ok: true, applied, total: STATEMENTS.length, results });
}
