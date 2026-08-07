// Read-only audit of Recording ownership vs auth.users.
import { PrismaClient } from '@prisma/client';
import fs from 'node:fs';

const env = fs.readFileSync(new URL('../.env.local', import.meta.url), 'utf8');
for (const line of env.split(/\r?\n/)) {
  const m = line.match(/^([A-Z_0-9]+)=(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}

const prisma = new PrismaClient();

const rows = await prisma.$queryRawUnsafe(`
  select r.id, r.title, r."createdAt", r.source, r.status, r."deletedAt",
         coalesce(u.email, r."userId", '<NULL>') as owner,
         left(coalesce(s.overview,''), 220) as overview,
         left(coalesce(t."fullText",''), 400) as head
  from "Recording" r
  left join auth.users u on u.id::text = r."userId"
  left join "Summary" s on s."recordingId" = r.id
  left join "Transcript" t on t."recordingId" = r.id
  order by r."createdAt"
`);

for (const r of rows) {
  const d = r.createdAt.toISOString().slice(0, 16).replace('T', ' ');
  const del = r.deletedAt ? ' [DELETED]' : '';
  console.log(`\n${d}  ${r.owner}  src=${r.source} ${r.status}${del}`);
  console.log(`  title: ${r.title}`);
  if (r.overview) console.log(`  overview: ${r.overview.replace(/\s+/g, ' ')}`);
  else if (r.head) console.log(`  transcript: ${r.head.replace(/\s+/g, ' ')}`);
}

await prisma.$disconnect();
