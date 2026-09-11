// Re-run the AI analysis for a recording whose transcript is fine but whose
// summary is not.
//
//   npx tsx scripts/regenerate-summary.ts <recordingId> [--dry]
//
// Written for cmtvd0h600000oamavnp2d5x7 (10 Sept 2026): a 2-hour meeting
// transcribed perfectly (94 660 chars) but summarised into nothing. The
// analysis budget was a flat 1024 output tokens; this meeting needs 3 254, so
// the model stopped mid-string, the JSON never parsed, and the old catch-all
// pasted the raw ```json fragment into `overview` and left keyPoints,
// actionItems and decisions empty. The transcript was intact the whole time,
// so nothing needs re-transcribing — only the analysis re-run.
//
// Use it after any summary-side fix to repair the meetings that were already
// finalised under the broken behaviour, without touching their audio or
// transcripts.
import { readFileSync } from 'fs';
import path from 'path';

// `--env <file>` reads keys from somewhere other than .env.local — use it with
// a `vercel env pull` dump to re-run the analysis against exactly the models
// and keys production uses.
const envFileArg = process.argv.indexOf('--env');
const ENV_FILE = envFileArg > -1 ? process.argv[envFileArg + 1] : '.env.local';

function envFile(key: string): string | null {
  const txt = readFileSync(path.resolve(path.join(__dirname, '..'), ENV_FILE), 'utf8');
  const m = txt.match(new RegExp(`^${key}=(.*)$`, 'm'));
  return m ? m[1].trim().replace(/^["']|["']$/g, '') : null;
}

for (const key of [
  'DATABASE_URL',
  'ANTHROPIC_API_KEY',
  'OPENROUTER_API_KEY',
  'OPENROUTER_MODELS',
]) {
  // An explicitly exported value wins, so a single key can be overridden
  // without editing the file.
  if (process.env[key]) continue;
  const v = envFile(key);
  if (v) process.env[key] = v;
}

async function main() {
  const id = process.argv[2];
  const dry = process.argv.includes('--dry');
  if (!id) {
    console.error('usage: npx tsx scripts/regenerate-summary.ts <recordingId> [--dry]');
    process.exit(1);
  }

  // Imported after the env is populated: both modules read keys at module load.
  const { prisma } = await import('../lib/db');
  const { analyzeTranscript } = await import('../lib/ai');

  const rec = await prisma.recording.findUnique({
    where: { id },
    select: { id: true, title: true, duration: true, meetingType: true, createdAt: true, status: true },
  });
  if (!rec) {
    console.error(`No recording ${id}`);
    process.exit(1);
  }

  const transcript = await prisma.transcript.findUnique({
    where: { recordingId: id },
    select: { fullText: true },
  });
  if (!transcript?.fullText?.trim()) {
    console.error(`Recording ${id} has no transcript — this script only re-runs the analysis.`);
    process.exit(1);
  }

  const before = await prisma.summary.findUnique({ where: { recordingId: id } });
  const count = (json: string | null | undefined) => {
    try { return (JSON.parse(json ?? '[]') as unknown[]).length; } catch { return 0; }
  };

  console.log(`${rec.title ?? '(untitled)'}  [${rec.status}]`);
  console.log(`  duration ${Math.round((rec.duration ?? 0) / 60)} min · transcript ${transcript.fullText.length} chars · type ${rec.meetingType}`);
  console.log(`  before: overview ${before?.overview?.length ?? 0} chars · ${count(before?.keyPoints)} key points · ${count(before?.actionItems)} action items · ${count(before?.decisions)} decisions`);

  const analysis = await analyzeTranscript(
    transcript.fullText,
    (rec.meetingType as Parameters<typeof analyzeTranscript>[1]) ?? 'general',
    rec.createdAt,
  );

  console.log(`  after:  overview ${analysis.overview.length} chars · ${analysis.keyPoints.length} key points · ${analysis.actionItems.length} action items · ${analysis.decisions.length} decisions`);
  console.log(`\n  overview: ${analysis.overview}\n`);

  // Same guard finalize applies: never overwrite a real summary with a failed
  // or mock-mode one.
  if (
    !analysis.overview.trim() ||
    analysis.overview.startsWith('Demo summary') ||
    analysis.overview.startsWith('Analysis could not be completed')
  ) {
    console.error('Analysis failed or returned mock content — not writing. Check ANTHROPIC_API_KEY / OPENROUTER_API_KEY.');
    process.exit(1);
  }

  if (dry) {
    console.log('--dry — nothing written.');
    await prisma.$disconnect();
    return;
  }

  // `topics` is left alone: it is generated from segments, not the transcript,
  // and was unaffected by the analysis bug.
  await prisma.summary.update({
    where: { recordingId: id },
    data: {
      overview: analysis.overview,
      keyPoints: JSON.stringify(analysis.keyPoints),
      actionItems: JSON.stringify(analysis.actionItems),
      actionItemsDue: JSON.stringify(analysis.actionItemsDue),
      decisions: JSON.stringify(analysis.decisions),
      // Re-analysing invalidates the old tick state: the indices no longer
      // point at the same items.
      actionItemsChecked: '[]',
    },
  });

  console.log('Written.');
  await prisma.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
