// One-off: add VoiceProfile.clipStartS / clipEndS / speakerLabel and
// user_settings.voice_training.
//
//   node scripts/apply-voice-training-columns.js
//
// lib/ensure-schema.ts is a no-op unless RUN_SCHEMA_CHECK=1, so new columns
// need a script run against the production DATABASE_URL. All additive:
// existing rows read as null span / empty label / no consent, which is exactly
// what they are. Idempotent, safe to re-run.
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
  'ALTER TABLE "VoiceProfile" ADD COLUMN IF NOT EXISTS "clipStartS" DOUBLE PRECISION',
  'ALTER TABLE "VoiceProfile" ADD COLUMN IF NOT EXISTS "clipEndS" DOUBLE PRECISION',
  `ALTER TABLE "VoiceProfile" ADD COLUMN IF NOT EXISTS "speakerLabel" TEXT NOT NULL DEFAULT ''`,
  'ALTER TABLE "user_settings" ADD COLUMN IF NOT EXISTS "voice_training" BOOLEAN',
];

(async () => {
  for (const sql of STATEMENTS) {
    await prisma.$executeRawUnsafe(sql);
    console.log('ok:', sql);
  }

  const [vp] = await prisma.$queryRawUnsafe(
    `SELECT count(*)::int AS n FROM information_schema.columns
     WHERE table_name = 'VoiceProfile'
       AND column_name IN ('clipStartS', 'clipEndS', 'speakerLabel')`,
  );
  const [us] = await prisma.$queryRawUnsafe(
    `SELECT count(*)::int AS n FROM information_schema.columns
     WHERE table_name = 'user_settings' AND column_name = 'voice_training'`,
  );
  console.log(`\nVoiceProfile span columns present: ${vp.n}/3`);
  console.log(`user_settings.voice_training present: ${us.n}/1`);
  if (vp.n !== 3 || us.n !== 1) process.exitCode = 1;

  await prisma.$disconnect();
})().catch(async (err) => {
  console.error(err.message);
  await prisma.$disconnect();
  process.exit(1);
});
