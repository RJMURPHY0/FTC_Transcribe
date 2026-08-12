// One-off: add Recording.channelLayout. Same DDL as lib/ensure-schema.ts, which
// is a no-op unless RUN_SCHEMA_CHECK=1, so new columns need an explicit run.
//
//   node scripts/apply-channel-layout-column.js
//
// Additive and nullable: existing rows read as NULL, which every code path
// already treats as "layout unknown, detect it from the audio".
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
  await prisma.$executeRawUnsafe(
    `ALTER TABLE "Recording" ADD COLUMN IF NOT EXISTS "channelLayout" TEXT`,
  );
  const [row] = await prisma.$queryRawUnsafe(
    `SELECT column_name, data_type, is_nullable
       FROM information_schema.columns
      WHERE table_name = 'Recording' AND column_name = 'channelLayout'`,
  );
  console.log(row ? `ok: ${row.column_name} ${row.data_type} nullable=${row.is_nullable}` : 'FAILED: column not present');
  process.exitCode = row ? 0 : 1;
}

main()
  .catch((e) => { console.error(e.message); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());
