// Audit voice-profile provenance: for each sample, source, origin recording,
// what the voice said, and cosine vs (a) the person's ENROLLMENT centroid,
// (b) each speaker centroid of a suspect recording. Read-only.
//
// Usage: node scripts/inspect-profiles.js [suspectRecordingId]
const { readFileSync } = require('fs');
const path = require('path');
const { PrismaClient } = require('@prisma/client');

function envLocal(key) {
  const txt = readFileSync(path.join(__dirname, '..', '.env.local'), 'utf8');
  const m = txt.match(new RegExp(`^${key}=(.*)$`, 'm'));
  return m ? m[1].trim().replace(/^"|"$/g, '') : null;
}
const prisma = new PrismaClient({ datasources: { db: { url: envLocal('DATABASE_URL') } } });

function cos(a, b) {
  let d = 0, na = 0, nb = 0;
  for (let i = 0; i < Math.min(a.length, b.length); i++) { d += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return na && nb ? d / (Math.sqrt(na) * Math.sqrt(nb)) : 0;
}
function centroid(vecs) {
  if (!vecs.length) return null;
  const out = new Array(vecs[0].length).fill(0);
  for (const v of vecs) for (let i = 0; i < v.length; i++) out[i] += v[i];
  return out.map(x => x / vecs.length);
}

async function main() {
  const suspectId = process.argv[2];
  const profiles = await prisma.voiceProfile.findMany({
    orderBy: [{ personName: 'asc' }, { createdAt: 'asc' }],
    select: { id: true, personName: true, source: true, durationS: true, createdAt: true, recordingId: true, excerpt: true, embedding: true },
  });
  const byPerson = new Map();
  for (const p of profiles) {
    if (!byPerson.has(p.personName)) byPerson.set(p.personName, []);
    byPerson.get(p.personName).push({ ...p, emb: JSON.parse(p.embedding) });
  }

  let suspectCentroids = [];
  if (suspectId) {
    const rows = await prisma.speakerEmbedding.findMany({
      where: { recordingId: suspectId },
      select: { speakerLabel: true, embedding: true, durationS: true },
    });
    suspectCentroids = rows.map(r => ({ label: r.speakerLabel, emb: JSON.parse(r.embedding), durationS: r.durationS }));
    console.log(`suspect recording ${suspectId}: ${suspectCentroids.length} speaker centroids (${suspectCentroids.map(s => `${s.label} ${Math.round(s.durationS)}s`).join(', ')})\n`);
  }

  for (const [name, samples] of byPerson) {
    const enrolled = samples.filter(s => s.source === 'enrollment' || s.source === 'relabel');
    const enrolCent = centroid(enrolled.map(s => s.emb));
    console.log(`── ${name} (${samples.length} samples, ${enrolled.length} enrolment/relabel) ──`);
    for (const s of samples) {
      const vsEnrol = enrolCent ? cos(s.emb, enrolCent).toFixed(2) : ' n/a';
      const vsSuspect = suspectCentroids.length
        ? suspectCentroids.map(c => `${c.label}:${cos(s.emb, c.emb).toFixed(2)}`).join(' ')
        : '';
      console.log(`  [${s.source.padEnd(10)}] ${s.createdAt.toISOString().slice(0, 16)}  ${String(Math.round(s.durationS)).padStart(4)}s  vsEnrol=${vsEnrol}  ${vsSuspect}`);
      console.log(`     id=${s.id}  rec=${s.recordingId ?? '-'}`);
      if (s.excerpt) console.log(`     "${s.excerpt.slice(0, 110)}"`);
    }
    console.log();
  }
}

main().finally(() => prisma.$disconnect());
