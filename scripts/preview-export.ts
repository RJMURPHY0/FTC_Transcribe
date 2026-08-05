// Render the .docx and .pdf export of a real recording straight to disk, with
// no dev server and no auth — the fastest way to eyeball a house-style change.
//
//   npx tsx scripts/preview-export.ts               # most recent summarised meeting
//   npx tsx scripts/preview-export.ts <recordingId>
//
// Writes to ./tmp-export/. Requires DATABASE_URL (loaded from .env.local).

import { readFileSync } from 'fs';
import { mkdir, writeFile } from 'fs/promises';
import { join } from 'path';

// Same .env.local loader the other scripts in here use — no dotenv dependency.
const envFile = readFileSync(join(process.cwd(), '.env.local'), 'utf8');
for (const line of envFile.split('\n')) {
  const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim().replace(/^"|"$/g, '');
}

async function main() {
  const { prisma } = await import('../lib/db');
  const { meetingDocFrom, exportFilename, readDocLogo } = await import('../lib/export-doc');
  const { buildMeetingDocx } = await import('../lib/export-docx');
  const { renderMeetingPdf } = await import('../lib/export-pdf');

  const id = process.argv[2];
  const recording = id
    ? await prisma.recording.findUnique({ where: { id }, include: { summary: true } })
    : await prisma.recording.findFirst({
        where: { deletedAt: null, summary: { isNot: null } },
        orderBy: { createdAt: 'desc' },
        include: { summary: true },
      });

  if (!recording) throw new Error('No summarised recording found.');

  const doc = meetingDocFrom(recording);
  const logo = await readDocLogo();
  console.log(`Recording : ${recording.id}`);
  console.log(`Title     : ${doc.title}`);
  console.log(
    `Sections  : topics ${doc.topics.length} · summary ${doc.overview ? 1 : 0} · ` +
    `actions ${doc.actionItems.length} (${doc.actionChecked.size} done) · ` +
    `points ${doc.keyPoints.length} · decisions ${doc.decisions.length}`,
  );

  const dir = join(process.cwd(), 'tmp-export');
  await mkdir(dir, { recursive: true });
  const stem = exportFilename(doc.title);

  await writeFile(join(dir, `${stem}.docx`), await buildMeetingDocx(doc, logo));
  await writeFile(join(dir, `${stem}.pdf`), await renderMeetingPdf(doc, logo));
  console.log(`Written   : tmp-export/${stem}.docx + .pdf`);

  await prisma.$disconnect();
}

main().catch((err) => { console.error(err); process.exit(1); });
