// Re-run acoustic speaker resolution for an existing recording using the
// CURRENT resolver + enrolled profiles (no audio needed — replays stored
// per-turn voiceprints). Fixes historic recordings after resolver improvements.
//
// Usage: npx tsx scripts/reanalyze-speakers.ts <recordingId>
import { readFileSync } from 'fs';
import path from 'path';

const envFile = readFileSync(path.join(process.cwd(), '.env.local'), 'utf8');
for (const line of envFile.split('\n')) {
  const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim().replace(/^"|"$/g, '');
}

async function main() {
  const id = process.argv[2];
  if (!id) { console.error('usage: tsx scripts/reanalyze-speakers.ts <recordingId>'); process.exit(1); }
  const { reanalyzeSpeakers } = await import('../lib/finalize-recording');
  const { prisma } = await import('../lib/db');

  const result = await reanalyzeSpeakers(id);
  console.log('reanalyze:', JSON.stringify(result));

  const t = await prisma.transcript.findUnique({ where: { recordingId: id }, select: { segments: true } });
  if (t) {
    const segs = JSON.parse(t.segments) as Array<{ speaker: string; start: number; end: number }>;
    const durBy = new Map<string, number>();
    for (const s of segs) durBy.set(s.speaker, (durBy.get(s.speaker) ?? 0) + (s.end - s.start));
    console.log(`speakers now: ${durBy.size}`);
    for (const [sp, d] of [...durBy.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10)) {
      console.log(`  ${sp}: ${Math.round(d)}s`);
    }
  }
  const embCount = await prisma.speakerEmbedding.count({ where: { recordingId: id } });
  console.log(`speakerEmbedding rows: ${embCount}`);
  await prisma.$disconnect();
}

main();
