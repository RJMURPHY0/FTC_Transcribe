-- Run this in the Supabase SQL editor for project ijeeghdxokfvlfarojlm
-- (the shared FTC Contacts / FTC Transcribe production database)

-- 1. Per-user scoping on recordings and folders
ALTER TABLE "Folder"    ADD COLUMN IF NOT EXISTS "userId" TEXT;
ALTER TABLE "Recording" ADD COLUMN IF NOT EXISTS "userId" TEXT;

CREATE INDEX IF NOT EXISTS "Folder_userId_idx"    ON "Folder"    ("userId");
CREATE INDEX IF NOT EXISTS "Recording_userId_idx" ON "Recording" ("userId");

-- 2. Transcribe permissions: super admin can grant "see all recordings" to a user
CREATE TABLE IF NOT EXISTS transcribe_permissions (
  user_id     TEXT        NOT NULL PRIMARY KEY,
  can_see_all BOOLEAN     NOT NULL DEFAULT FALSE,
  granted_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE transcribe_permissions ENABLE ROW LEVEL SECURITY;

-- Any authenticated user can read their own row (FTC Transcribe reads this to scope queries)
DROP POLICY IF EXISTS read_own ON transcribe_permissions;
CREATE POLICY read_own ON transcribe_permissions
  FOR SELECT USING (user_id = auth.uid()::text);

-- Super admins can read/write all rows (FTC Contacts super admin writes via service role API route)
-- Note: the API route (api/super-admin/transcribe-permissions.ts) uses SUPABASE_SERVICE_ROLE_KEY
-- which bypasses RLS, so no additional write policy is required here.
