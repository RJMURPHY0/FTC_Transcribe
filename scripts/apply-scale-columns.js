// One-off: the columns behind the queue-fairness and tenancy work.
//
//   node scripts/apply-scale-columns.js
//
// Same DDL as lib/ensure-schema.ts, which is a no-op unless RUN_SCHEMA_CHECK=1.
// All additive and all nullable/defaulted, so existing rows keep working:
//
//   FinalizeJob.nextAttemptAt  null  = claimable now (current behaviour)
//   FinalizeJob.deadLettered   false = still retried (current behaviour)
//   Recording.orgId            null  = untenanted, backfilled below
//
// The backfill reads each owner's current organisation from the Contacts
// app's org_members table, which lives in the same database.
const { readFileSync } = require('fs');
const path = require('path');
const { PrismaClient } = require('@prisma/client');

function envLocal(key) {
  const txt = readFileSync(path.join(__dirname, '..', '.env.local'), 'utf8');
  const m = txt.match(new RegExp(`^${key}=(.*)$`, 'm'));
  if (!m) throw new Error(`${key} not in .env.local`);
  return m[1].trim().replace(/^["']|["']$/g, '');
}

const prisma = new PrismaClient({ datasources: { db: { url: envLocal('DATABASE_URL') } } });

const STATEMENTS = [
  `ALTER TABLE "FinalizeJob" ADD COLUMN IF NOT EXISTS "nextAttemptAt" TIMESTAMP(3)`,
  `ALTER TABLE "FinalizeJob" ADD COLUMN IF NOT EXISTS "deadLettered" BOOLEAN NOT NULL DEFAULT false`,
  `CREATE INDEX IF NOT EXISTS "FinalizeJob_status_deadLettered_nextAttemptAt_idx"
     ON "FinalizeJob" ("status", "deadLettered", "nextAttemptAt")`,
  `ALTER TABLE "Recording" ADD COLUMN IF NOT EXISTS "orgId" TEXT`,
  `CREATE INDEX IF NOT EXISTS "Recording_orgId_deletedAt_createdAt_idx"
     ON "Recording" ("orgId", "deletedAt", "createdAt")`,
];

(async () => {
  for (const sql of STATEMENTS) {
    await prisma.$executeRawUnsafe(sql);
    console.log('ok:', sql.split('\n')[0].trim().slice(0, 90));
  }

  // Backfill orgId from the owner's current org membership. Recordings whose
  // owner is in no org stay null, which reads as "untenanted" and is visible
  // only to the owner and the super admin.
  const filled = await prisma.$executeRawUnsafe(`
    UPDATE "Recording" r
       SET "orgId" = m.org_id::text
      FROM public.org_members m
     WHERE m.user_id = r."userId"::uuid
       AND r."userId" IS NOT NULL
       AND r."orgId" IS NULL
  `);
  console.log(`backfilled orgId on ${filled} recording(s)`);

  const summary = await prisma.$queryRawUnsafe(`
    SELECT COUNT(*)::int AS total,
           COUNT("orgId")::int AS with_org
      FROM "Recording"
  `);
  console.log('recordings:', JSON.stringify(summary[0]));

  await prisma.$disconnect();
})().catch((err) => {
  console.error('FAILED:', err.message);
  process.exit(1);
});
