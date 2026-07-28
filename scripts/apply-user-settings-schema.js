// One-off: create the user_settings table on the REAL app DB.
//
// The Supabase MCP is pinned to the wrong project (qnvrdhydofjrhjpquywg); the
// live app DB is ijeeghdxokfvlfarojlm. This script reads DATABASE_URL straight
// from .env.local and applies the DDL there, so it can never hit the wrong DB.
// Same DDL as lib/ensure-schema.ts. Run: node scripts/apply-user-settings-schema.js
const fs = require('fs');
const path = require('path');

const envPath = path.join(__dirname, '..', '.env.local');
const env = fs.readFileSync(envPath, 'utf8');
const m = env.match(/^DATABASE_URL\s*=\s*"?([^"\r\n]+)"?/m);
const url = m && m[1];
if (!url) { console.error('DATABASE_URL not found in .env.local'); process.exit(1); }

// Guard: refuse to run against anything but the known-good project.
if (!url.includes('ijeeghdxokfvlfarojlm')) {
  console.error('DATABASE_URL is not the expected project (ijeeghdxokfvlfarojlm). Aborting.');
  process.exit(1);
}

const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient({ datasources: { db: { url } } });

async function main() {
  await prisma.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS user_settings (
      user_id    TEXT NOT NULL PRIMARY KEY,
      live_fx    BOOLEAN,
      updated_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`);
  const check = await prisma.$queryRawUnsafe(
    `SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_name='user_settings'`,
  );
  console.log('user_settings present:', JSON.stringify(check));
}

main().finally(() => prisma.$disconnect());
