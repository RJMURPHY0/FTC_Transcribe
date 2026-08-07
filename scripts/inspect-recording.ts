// Why does a recording contain far less speech than its wall-clock duration?
//
// A 43-minute meeting whose transcript holds ~2 minutes of speech is the
// signature of capture stopping partway through — the failure users describe
// as "my phone locked and it stopped recording". This reports, per chunk, how
// much audio actually arrived and how much of it was transcribed, so silent
// capture and a silent room can be told apart.
//
//   npx tsx scripts/inspect-recording.ts <recordingId>
import { readFileSync } from 'fs';
import path from 'path';

const envFile = readFileSync(path.join(process.cwd(), '.env.local'), 'utf8');
for (const line of envFile.split('\n')) {
  const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim().replace(/^"|"$/g, '');
}

interface StoredSegment { speaker: string; start: number; end: number; text: string }

async function main() {
  const id = process.argv[2];
  if (!id) { console.error('usage: tsx scripts/inspect-recording.ts <recordingId>'); process.exit(1); }
  const { prisma } = await import('../lib/db');

  const rec = await prisma.recording.findUnique({ where: { id } });
  const transcript = await prisma.transcript.findUnique({ where: { recordingId: id } });
  if (!rec) { console.log('no such recording'); return; }

  const segs: StoredSegment[] = transcript ? JSON.parse(transcript.segments) : [];
  const speech = segs.reduce((n, s) => n + (s.end - s.start), 0);
  const lastSeg = segs.length ? Math.max(...segs.map((s) => s.end)) : 0;

  console.log(`${rec.title}`);
  console.log(`  status=${rec.status} source=${rec.source} duration=${rec.duration}s created=${rec.createdAt.toISOString()}`);
  console.log(`  transcript: ${segs.length} segments, ${Math.round(speech)}s of speech `
    + `(${((speech / Math.max(rec.duration, 1)) * 100).toFixed(1)}% of duration)`);
  console.log(`  last segment ends at ${Math.round(lastSeg)}s of ${rec.duration}s`);

  const blobs = await prisma.chunkBlob.findMany({
    where: { recordingId: id }, orderBy: { offset: 'asc' },
    select: { offset: true, mimeType: true, createdAt: true, audioData: true },
  });
  console.log(`\n  chunks: ${blobs.length}`);
  let prevAt: number | null = null;
  for (const b of blobs) {
    const segsHere = segs.filter((s) => s.start >= b.offset && s.start < b.offset + 120);
    const spoke = segsHere.reduce((n, s) => n + (s.end - s.start), 0);
    const at = b.createdAt.getTime();
    // Wall-clock gap between chunk uploads. A gap far larger than the 2-minute
    // chunk period means the page was frozen or offline in between.
    const gap = prevAt === null ? 0 : (at - prevAt) / 1000;
    prevAt = at;
    console.log(
      `    offset=${String(Math.round(b.offset)).padStart(5)}s  `
      + `${(b.audioData.length / 1e6).toFixed(2)}MB  `
      + `uploadGap=${gap.toFixed(0)}s  `
      + `segments=${String(segsHere.length).padStart(3)}  speech=${Math.round(spoke)}s`,
    );
  }

  await prisma.$disconnect();
}

main().catch((e) => { console.error(e); process.exit(1); });
