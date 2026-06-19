import { prisma } from './db';

// Idempotent — ADD COLUMN IF NOT EXISTS is a no-op when columns already exist.
// Called before any query that depends on userId so the app self-heals on first boot.
let applied = false;

export async function ensureSchema() {
  if (applied) return;
  try {
    await prisma.$executeRaw`ALTER TABLE "Recording" ADD COLUMN IF NOT EXISTS "userId" TEXT`;
    await prisma.$executeRaw`ALTER TABLE "Recording" ADD COLUMN IF NOT EXISTS "source" TEXT NOT NULL DEFAULT 'web'`;
    await prisma.$executeRaw`ALTER TABLE "Recording" ADD COLUMN IF NOT EXISTS "meetingType" TEXT NOT NULL DEFAULT 'general'`;
    await prisma.$executeRaw`ALTER TABLE "Folder"    ADD COLUMN IF NOT EXISTS "userId" TEXT`;
    await prisma.$executeRaw`CREATE INDEX IF NOT EXISTS "Recording_userId_idx" ON "Recording" ("userId")`;
    await prisma.$executeRaw`CREATE INDEX IF NOT EXISTS "Folder_userId_idx"    ON "Folder"    ("userId")`;
    await prisma.$executeRaw`ALTER TABLE "Summary" ADD COLUMN IF NOT EXISTS "actionItemsChecked" TEXT NOT NULL DEFAULT '[]'`;
    await prisma.$executeRaw`
      CREATE TABLE IF NOT EXISTS transcribe_permissions (
        user_id     TEXT        NOT NULL PRIMARY KEY,
        can_see_all BOOLEAN     NOT NULL DEFAULT FALSE,
        granted_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`;
    applied = true;
  } catch { /* already up to date or DB unavailable */ }
}
