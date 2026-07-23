// Backfills Recording.duration (from transcript segment end times) and
// Transcript.language (OpenRouter deepseek-chat detection) for rows created
// before the pipeline stored either. Adds the language column if missing.
// Run: node scripts/backfill-recording-meta.mjs
import { PrismaClient } from '@prisma/client';
import { readFileSync } from 'fs';
import { resolve } from 'path';

// Load DATABASE_URL (and friends) from .env.local without clobbering real env
try {
  const env = readFileSync(resolve('.env.local'), 'utf8');
  for (const line of env.split('\n')) {
    const [k, ...rest] = line.split('=');
    if (k && rest.length && !process.env[k.trim()]) {
      process.env[k.trim()] = rest.join('=').trim();
    }
  }
} catch { /* rely on process env */ }

const OR_KEY = process.env.OPENROUTER_API_KEY;
// deepseek-chat paid endpoint (policy: no train-on-prompt free tiers for business data)
const OR_MODEL = 'deepseek/deepseek-chat';
const OR_IN_RATE = 0.27 / 1e6;  // $/token, approx July 2026 list price
const OR_OUT_RATE = 1.10 / 1e6;

const prisma = new PrismaClient();

async function detectLanguage(sample) {
  const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${OR_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: OR_MODEL,
      messages: [{
        role: 'user',
        content: `Reply with only the English name of the language this text is written in (one word, e.g. "English"):\n\n${sample}`,
      }],
      max_tokens: 8,
      temperature: 0,
    }),
  });
  if (!res.ok) throw new Error(`OpenRouter ${res.status}: ${await res.text()}`);
  const json = await res.json();
  const answer = (json.choices?.[0]?.message?.content ?? '').trim();
  const usage = json.usage ?? {};
  const cost = (usage.prompt_tokens ?? 0) * OR_IN_RATE + (usage.completion_tokens ?? 0) * OR_OUT_RATE;
  return { answer, cost };
}

try {
  await prisma.$executeRawUnsafe(
    `ALTER TABLE "Transcript" ADD COLUMN IF NOT EXISTS "language" TEXT NOT NULL DEFAULT ''`,
  );
  console.log('language column ensured.');

  const rows = await prisma.$queryRawUnsafe(`
    SELECT r.id, r.duration, t.id AS "transcriptId", t.segments, t."language",
           LEFT(t."fullText", 400) AS sample, LENGTH(t."fullText") AS len
    FROM "Recording" r
    JOIN "Transcript" t ON t."recordingId" = r.id
    WHERE r."deletedAt" IS NULL
  `);
  console.log(`${rows.length} recordings with transcripts.`);

  let durationsSet = 0;
  for (const row of rows) {
    if (row.duration > 0) continue;
    let maxEnd = 0;
    try {
      const segs = JSON.parse(row.segments);
      if (Array.isArray(segs)) {
        for (const s of segs) maxEnd = Math.max(maxEnd, Number(s.end) || 0);
      }
    } catch { /* unparseable segments — skip */ }
    const secs = Math.round(maxEnd);
    if (secs > 0) {
      await prisma.$executeRawUnsafe(
        `UPDATE "Recording" SET duration = $1 WHERE id = $2`, secs, row.id,
      );
      durationsSet++;
    }
  }
  console.log(`durations set: ${durationsSet}`);

  let languagesSet = 0;
  let totalCost = 0;
  if (!OR_KEY) {
    console.log('OPENROUTER_API_KEY not set — skipping language backfill.');
  } else {
    const need = rows.filter(r => !r.language && r.len > 40);
    for (const row of need) {
      try {
        const { answer, cost } = await detectLanguage(row.sample);
        totalCost += cost;
        if (/^[A-Za-z][A-Za-z ]{1,19}$/.test(answer)) {
          await prisma.$executeRawUnsafe(
            `UPDATE "Transcript" SET "language" = $1 WHERE id = $2`,
            answer.toLowerCase(), row.transcriptId,
          );
          languagesSet++;
        } else {
          console.log(`  skipped ${row.id}: odd answer "${answer}"`);
        }
      } catch (err) {
        console.log(`  failed ${row.id}: ${err.message}`);
      }
    }
    console.log(`languages set: ${languagesSet}/${need.length}`);
    console.log(`OpenRouter cost (est. from token usage): $${totalCost.toFixed(4)}`);
  }
} finally {
  await prisma.$disconnect();
}
