-- Migration: add AutoFixAttempt table for the auto-fix deduplication log
-- Run this once against your production Postgres database.

CREATE TABLE IF NOT EXISTS "AutoFixAttempt" (
  "id"        TEXT        NOT NULL PRIMARY KEY,
  "errorHash" TEXT        NOT NULL,
  "errorMsg"  TEXT        NOT NULL,
  "source"    TEXT        NOT NULL DEFAULT '',
  "prUrl"     TEXT,
  "status"    TEXT        NOT NULL DEFAULT 'pending',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS "AutoFixAttempt_errorHash_createdAt_idx"
  ON "AutoFixAttempt"("errorHash", "createdAt");
