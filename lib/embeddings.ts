import OpenAI from 'openai';
import { prisma } from '@/lib/db';

const OPENAI_KEY = process.env.OPENAI_API_KEY;
const isReady = !!OPENAI_KEY && OPENAI_KEY !== 'your_openai_api_key_here';

const client = isReady ? new OpenAI({ apiKey: OPENAI_KEY }) : null;

const EMBED_MODEL = 'text-embedding-3-small';
const EMBED_DIM   = 1536;
const CHUNK_CHARS = 500;
const OVERLAP     = 100;

// Split text into overlapping windows
function chunkText(text: string): Array<{ text: string; startChar: number }> {
  const chunks: Array<{ text: string; startChar: number }> = [];
  let i = 0;
  while (i < text.length) {
    chunks.push({ text: text.slice(i, i + CHUNK_CHARS), startChar: i });
    i += CHUNK_CHARS - OVERLAP;
  }
  return chunks;
}

export async function embedText(text: string): Promise<number[] | null> {
  if (!client) return null;
  const res = await client.embeddings.create({ model: EMBED_MODEL, input: text.slice(0, 8000) });
  return res.data[0].embedding;
}

// Store embeddings for a completed transcript — called from finalize pipeline
export async function indexTranscript(
  recordingId: string,
  userId:      string | null,
  fullText:    string,
): Promise<void> {
  if (!client || !fullText.trim()) return;

  const chunks = chunkText(fullText);

  // Batch embed all chunks
  const res = await client.embeddings.create({
    model: EMBED_MODEL,
    input: chunks.map(c => c.text),
  }).catch(() => null);
  if (!res) return;

  // Upsert into transcript_embeddings via raw SQL (pgvector)
  for (let i = 0; i < chunks.length; i++) {
    const emb = res.data[i].embedding;
    const vec = `[${emb.join(',')}]`;
    await prisma.$executeRawUnsafe(
      `INSERT INTO transcript_embeddings (id, recording_id, user_id, chunk_text, embedding, created_at)
       VALUES (gen_random_uuid()::text, $1, $2, $3, $4::vector, now())
       ON CONFLICT DO NOTHING`,
      recordingId, userId, chunks[i].text, vec,
    ).catch(() => { /* pgvector table may not exist — skip silently */ });
  }
}

export interface SearchResult {
  recordingId: string;
  excerpt:     string;
  similarity:  number;
}

// Vector similarity search — falls back to empty if pgvector not available
export async function vectorSearch(
  query:  string,
  userId: string | null,
  limit = 10,
): Promise<SearchResult[]> {
  if (!client) return [];

  const qEmbed = await embedText(query);
  if (!qEmbed) return [];

  const vec = `[${qEmbed.join(',')}]`;

  try {
    const rows = await prisma.$queryRawUnsafe<Array<{
      recording_id: string;
      chunk_text:   string;
      similarity:   number;
    }>>(
      `SELECT recording_id, chunk_text,
              1 - (embedding <=> $1::vector) AS similarity
       FROM transcript_embeddings
       WHERE ($2::text IS NULL OR user_id = $2)
       ORDER BY embedding <=> $1::vector
       LIMIT $3`,
      vec, userId, limit,
    );

    // Deduplicate by recording — keep the best matching chunk per recording
    const seen = new Map<string, SearchResult>();
    for (const row of rows) {
      if (!seen.has(row.recording_id) || row.similarity > seen.get(row.recording_id)!.similarity) {
        seen.set(row.recording_id, {
          recordingId: row.recording_id,
          excerpt:     row.chunk_text,
          similarity:  row.similarity,
        });
      }
    }
    return [...seen.values()].sort((a, b) => b.similarity - a.similarity);
  } catch {
    return [];
  }
}
