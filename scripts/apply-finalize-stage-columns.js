// One-off: add FinalizeJob.stage / startedAt / completedAt. Same DDL as
// lib/ensure-schema.ts, which is a no-op unless RUN_SCHEMA_CHECK=1.
//
//   node scripts/apply-finalize-stage-columns.js
//
// These back the processing progress bar and its ETA. All additive: existing
// jobs read as stage '' with null timestamps, which the UI treats as "no
// measurement yet" and falls back to the old constant estimate.
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

async function main() {
  await prisma.$executeRawUnsafe(`ALTER TABLE "FinalizeJob" ADD COLUMN IF NOT EXISTS "stage" TEXT NOT NULL DEFAULT ''`);
  await prisma.$executeRawUnsafe(`ALTER TABLE "FinalizeJob" ADD COLUMN IF NOT EXISTS "startedAt" TIMESTAMP(3)`);
  await prisma.$executeRawUnsafe(`ALTER TABLE "FinalizeJob" ADD COLUMN IF NOT EXISTS "completedAt" TIMESTAMP(3)`);
  const rows = await prisma.$queryRawUnsafe(
    `SELECT column_name FROM information_schema.columns
      WHERE table_name = 'FinalizeJob' AND column_name IN ('stage','startedAt','completedAt')`,
  );
  const found = rows.map((r) => r.column_name).sort();
  console.log(found.length === 3 ? `ok: ${found.join(', ')}` : `FAILED: only ${found.join(', ') || 'none'}`);
  process.exitCode = found.length === 3 ? 0 : 1;
}

main()
  .catch((e) => { console.error(e.message); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());
