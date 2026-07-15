import { prisma } from './db';

// Idempotent — ADD COLUMN IF NOT EXISTS is a no-op when columns already exist.
// Called before any query that depends on userId so the app self-heals on first boot.
let applied = false;

export async function ensureSchema() {
  // Schema is already migrated in every deployed environment, so these ~24
  // sequential DDL round-trips to the EU database were pure latency on every
  // page render / sign-in. Skip entirely unless explicitly opted in (set
  // RUN_SCHEMA_CHECK=1 when bootstrapping a fresh database).
  if (process.env.RUN_SCHEMA_CHECK !== '1') return;
  if (applied) return;
  try {
    await prisma.$executeRaw`ALTER TABLE "Recording" ADD COLUMN IF NOT EXISTS "userId" TEXT`;
    await prisma.$executeRaw`ALTER TABLE "Recording" ADD COLUMN IF NOT EXISTS "source" TEXT NOT NULL DEFAULT 'web'`;
    await prisma.$executeRaw`ALTER TABLE "Recording" ADD COLUMN IF NOT EXISTS "meetingType" TEXT NOT NULL DEFAULT 'general'`;
    await prisma.$executeRaw`ALTER TABLE "Folder"    ADD COLUMN IF NOT EXISTS "userId" TEXT`;
    await prisma.$executeRaw`CREATE INDEX IF NOT EXISTS "Recording_userId_idx" ON "Recording" ("userId")`;
    await prisma.$executeRaw`CREATE INDEX IF NOT EXISTS "Folder_userId_idx"    ON "Folder"    ("userId")`;
    await prisma.$executeRaw`ALTER TABLE "Summary" ADD COLUMN IF NOT EXISTS "actionItemsChecked" TEXT NOT NULL DEFAULT '[]'`;
    await prisma.$executeRaw`ALTER TABLE "Summary" ADD COLUMN IF NOT EXISTS "actionItemsDue" TEXT NOT NULL DEFAULT '[]'`;
    await prisma.$executeRaw`
      CREATE TABLE IF NOT EXISTS transcribe_permissions (
        user_id     TEXT        NOT NULL PRIMARY KEY,
        can_see_all BOOLEAN     NOT NULL DEFAULT FALSE,
        granted_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`;
    await prisma.$executeRaw`ALTER TABLE "Recording" ADD COLUMN IF NOT EXISTS "deletedAt" TIMESTAMP(3)`;
    await prisma.$executeRaw`CREATE INDEX IF NOT EXISTS "Recording_deletedAt_idx" ON "Recording" ("deletedAt")`;
    await prisma.$executeRaw`ALTER TABLE "Recording" ADD COLUMN IF NOT EXISTS "teamsNotifiedAt" TIMESTAMP(3)`;
    await prisma.$executeRaw`ALTER TABLE "Recording" ADD COLUMN IF NOT EXISTS "airtableBackedUpAt" TIMESTAMP(3)`;
    await prisma.$executeRaw`ALTER TABLE "ChunkBlob" ADD COLUMN IF NOT EXISTS "contentHash" TEXT NOT NULL DEFAULT ''`;
    await prisma.$executeRaw`
      CREATE UNIQUE INDEX IF NOT EXISTS "ChunkBlob_recording_hash_key"
      ON "ChunkBlob"("recordingId", "contentHash")
      WHERE "contentHash" <> ''`;
    await prisma.$executeRaw`ALTER TABLE "ChunkTranscript" ADD COLUMN IF NOT EXISTS "voiceData" TEXT NOT NULL DEFAULT ''`;
    await prisma.$executeRaw`
      CREATE TABLE IF NOT EXISTS "VoiceProfile" (
        "id"          TEXT NOT NULL PRIMARY KEY,
        "userId"      TEXT,
        "personName"  TEXT NOT NULL,
        "embedding"   TEXT NOT NULL,
        "durationS"   DOUBLE PRECISION NOT NULL DEFAULT 0,
        "source"      TEXT NOT NULL DEFAULT 'enrollment',
        "deviceLabel" TEXT NOT NULL DEFAULT '',
        "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
      )`;
    await prisma.$executeRaw`CREATE INDEX IF NOT EXISTS "VoiceProfile_userId_idx" ON "VoiceProfile"("userId")`;
    await prisma.$executeRaw`CREATE INDEX IF NOT EXISTS "VoiceProfile_personName_idx" ON "VoiceProfile"("personName")`;
    await prisma.$executeRaw`
      CREATE TABLE IF NOT EXISTS "SpeakerEmbedding" (
        "id"           TEXT NOT NULL PRIMARY KEY,
        "recordingId"  TEXT NOT NULL,
        "speakerLabel" TEXT NOT NULL,
        "embedding"    TEXT NOT NULL,
        "durationS"    DOUBLE PRECISION NOT NULL DEFAULT 0,
        "createdAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT "SpeakerEmbedding_recordingId_fkey" FOREIGN KEY ("recordingId")
          REFERENCES "Recording"("id") ON DELETE CASCADE ON UPDATE CASCADE
      )`;
    await prisma.$executeRaw`CREATE INDEX IF NOT EXISTS "SpeakerEmbedding_recordingId_idx" ON "SpeakerEmbedding"("recordingId")`;
    applied = true;
  } catch { /* already up to date or DB unavailable */ }
}
