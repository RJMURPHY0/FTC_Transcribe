-- Fix: enable RLS on all public tables.
-- All access is via Prisma (direct DB connection) or service role key,
-- both of which bypass RLS — so no policies are needed.
-- This prevents anonymous/authenticated Supabase client access to raw tables.

alter table if exists "Folder"          enable row level security;
alter table if exists "Recording"       enable row level security;
alter table if exists "ChunkBlob"       enable row level security;
alter table if exists "FinalizeJob"     enable row level security;
alter table if exists "ChunkTranscript" enable row level security;
alter table if exists "Transcript"      enable row level security;
alter table if exists "Summary"         enable row level security;
alter table if exists "AutoFixAttempt"  enable row level security;
