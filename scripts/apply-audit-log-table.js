// One-off: create the AuditLog table. Same DDL as lib/ensure-schema.ts, which
// is a no-op unless RUN_SCHEMA_CHECK=1, so new tables need an explicit run.
//
//   node scripts/apply-audit-log-table.js
//
// Purely additive: nothing reads the table until lib/audit.ts ships, and a
// failed audit write never fails the action it describes.
const { readFileSync } = require('fs');
const path = require('path');
const { PrismaClient } = require('@prisma/client');

// Same .env.local reader the other one-off scripts use.
function envLocal(key) {
  const txt = readFileSync(path.join(__dirname, '..', '.env.local'), 'utf8');
  const m = txt.match(new RegExp(`^${key}=(.*)$`, 'm'));
  if (!m) throw new Error(`${key} not in .env.local`);
  return m[1].trim().replace(/^["']|["']$/g, '');
}

const prisma = new PrismaClient({ datasources: { db: { url: envLocal('DATABASE_URL') } } });

async function main() {
  await prisma.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS "AuditLog" (
      "id"         TEXT NOT NULL PRIMARY KEY,
      "createdAt"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "userId"     TEXT,
      "userEmail"  TEXT,
      "orgId"      TEXT,
      "action"     TEXT NOT NULL,
      "targetType" TEXT,
      "targetId"   TEXT,
      "ip"         TEXT,
      "metadata"   TEXT
    )`);
  await prisma.$executeRawUnsafe(
    `CREATE INDEX IF NOT EXISTS "AuditLog_userId_createdAt_idx" ON "AuditLog"("userId", "createdAt")`,
  );
  await prisma.$executeRawUnsafe(
    `CREATE INDEX IF NOT EXISTS "AuditLog_targetId_idx" ON "AuditLog"("targetId")`,
  );
  await prisma.$executeRawUnsafe(
    `CREATE INDEX IF NOT EXISTS "AuditLog_createdAt_idx" ON "AuditLog"("createdAt")`,
  );
  const [row] = await prisma.$queryRawUnsafe(
    `SELECT COUNT(*)::int AS cols
       FROM information_schema.columns
      WHERE table_name = 'AuditLog'`,
  );
  console.log(row && row.cols >= 10 ? `ok: AuditLog present (${row.cols} columns)` : 'FAILED: AuditLog not present');
  process.exitCode = row && row.cols >= 10 ? 0 : 1;
}

main()
  .catch((e) => { console.error(e.message); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());
