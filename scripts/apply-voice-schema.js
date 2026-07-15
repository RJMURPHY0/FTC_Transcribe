// One-off: create voice-ID tables/columns. Same DDL as lib/ensure-schema.ts.
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function main() {
  const stmts = [
    `ALTER TABLE "ChunkTranscript" ADD COLUMN IF NOT EXISTS "voiceData" TEXT NOT NULL DEFAULT ''`,
    `CREATE TABLE IF NOT EXISTS "VoiceProfile" (
      "id"          TEXT NOT NULL PRIMARY KEY,
      "userId"      TEXT,
      "personName"  TEXT NOT NULL,
      "embedding"   TEXT NOT NULL,
      "durationS"   DOUBLE PRECISION NOT NULL DEFAULT 0,
      "source"      TEXT NOT NULL DEFAULT 'enrollment',
      "deviceLabel" TEXT NOT NULL DEFAULT '',
      "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`,
    `CREATE INDEX IF NOT EXISTS "VoiceProfile_userId_idx" ON "VoiceProfile"("userId")`,
    `CREATE INDEX IF NOT EXISTS "VoiceProfile_personName_idx" ON "VoiceProfile"("personName")`,
    `CREATE TABLE IF NOT EXISTS "SpeakerEmbedding" (
      "id"           TEXT NOT NULL PRIMARY KEY,
      "recordingId"  TEXT NOT NULL,
      "speakerLabel" TEXT NOT NULL,
      "embedding"    TEXT NOT NULL,
      "durationS"    DOUBLE PRECISION NOT NULL DEFAULT 0,
      "createdAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT "SpeakerEmbedding_recordingId_fkey" FOREIGN KEY ("recordingId")
        REFERENCES "Recording"("id") ON DELETE CASCADE ON UPDATE CASCADE
    )`,
    `CREATE INDEX IF NOT EXISTS "SpeakerEmbedding_recordingId_idx" ON "SpeakerEmbedding"("recordingId")`,
  ];
  for (const s of stmts) {
    await prisma.$executeRawUnsafe(s);
    console.log('ok:', s.slice(0, 60).replace(/\s+/g, ' '));
  }
  const check = await prisma.$queryRawUnsafe(
    `SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_name IN ('VoiceProfile','SpeakerEmbedding')`,
  );
  console.log('tables present:', JSON.stringify(check));
}

main().finally(() => prisma.$disconnect());
