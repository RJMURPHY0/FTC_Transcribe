-- Phase 7: Semantic search via pgvector
-- Run once in Supabase SQL Editor (or via Supabase MCP apply_migration)

-- 1. Enable the vector extension
CREATE EXTENSION IF NOT EXISTS vector;

-- 2. Transcript embedding chunks table
CREATE TABLE IF NOT EXISTS transcript_embeddings (
  id           TEXT        PRIMARY KEY DEFAULT gen_random_uuid()::text,
  recording_id TEXT        NOT NULL REFERENCES "Recording"(id) ON DELETE CASCADE,
  user_id      TEXT,
  chunk_text   TEXT        NOT NULL,
  embedding    vector(1536),            -- OpenAI text-embedding-3-small
  created_at   TIMESTAMPTZ DEFAULT now()
);

-- 3. IVFFlat index for cosine similarity search (tune lists= as data grows)
CREATE INDEX IF NOT EXISTS idx_transcript_embeddings_vec
  ON transcript_embeddings
  USING ivfflat (embedding vector_cosine_ops)
  WITH (lists = 100);

-- 4. Row-level security — users only see their own embeddings
ALTER TABLE transcript_embeddings ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users see own embeddings"
  ON transcript_embeddings
  FOR ALL
  USING (user_id IS NULL OR user_id = auth.uid()::text);
