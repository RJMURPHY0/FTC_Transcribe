// One-off: give existing meeting-derived VoiceProfile rows the span and
// diarizer label they were never asked to record.
//
//   node scripts/backfill-voice-sample-spans.js [--apply]
//
// Without --apply it reports what it would write and changes nothing.
//
// Why these rows have no span: until now the sample inspector re-derived the
// clip at read time by matching transcript segments whose speaker equalled the
// PERSON'S NAME. A transcript stores "Speaker 2" unless someone has been
// renamed, so that match found nothing, and every historic sample showed no
// play button and no timestamp. The label is recovered here from the
// recording's own speaker voiceprints. See recoverLabel below for how, and for
// why a sample from before the TitaNet switch needs a different route.
const { readFileSync } = require('fs');
const path = require('path');
const { PrismaClient } = require('@prisma/client');

function envLocal(key) {
  const txt = readFileSync(path.join(__dirname, '..', '.env.local'), 'utf8');
  const m = txt.match(new RegExp(`^${key}=(.*)$`, 'm'));
  if (!m) throw new Error(`${key} not in .env.local`);
  return m[1].trim().replace(/^["']|["']$/g, '');
}

const prisma = new PrismaClient({ datasources: { db: { url: envLocal('DATABASE_URL') } } });
const APPLY = process.argv.includes('--apply');

// Same rule as lib/voice-id.ts bestSpan: longest contiguous run, short gaps
// bridged, capped so a sample points at a listenable excerpt.
function bestSpan(turns, maxGapS = 2, maxLenS = 20) {
  if (!turns.length) return null;
  const sorted = [...turns].sort((a, b) => a.start - b.start);
  let best = null;
  let runStart = sorted[0].start;
  let runEnd = sorted[0].end;
  const consider = () => {
    const end = Math.min(runEnd, runStart + maxLenS);
    if (end <= runStart) return;
    if (!best || end - runStart > best.end - best.start) best = { start: runStart, end };
  };
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i].start - runEnd <= maxGapS) runEnd = Math.max(runEnd, sorted[i].end);
    else { consider(); runStart = sorted[i].start; runEnd = sorted[i].end; }
  }
  consider();
  return best ? { start: Math.round(best.start * 10) / 10, end: Math.round(best.end * 10) / 10 } : null;
}

/**
 * Which diarizer speaker this sample was learned from.
 *
 * Preferred: the sample's embedding IS one of the recording's speaker
 * voiceprints, byte for byte. That is exact and needs no judgement.
 *
 * Fallback: a sample learned before the TitaNet switch is a CAM++ vector while
 * the recording's voiceprints are TitaNet. The two spaces are not comparable
 * at all (cosine between the same person across them measures ~0), so vector
 * matching cannot work here even in principle. Total speech duration survives
 * the model change, so it is used instead, but only when one speaker is within
 * 5% AND no other speaker is close. Anything ambiguous is left alone rather
 * than guessed: this attributes biometric data to a person.
 */
function recoverLabel(row, speakerEmbeddings) {
  if (row.speakerLabel) return { label: row.speakerLabel, how: 'stored' };

  const exact = speakerEmbeddings.find(e => e.embedding === row.embedding);
  if (exact) return { label: exact.speakerLabel, how: 'exact-vector' };

  const sameSpace = speakerEmbeddings.filter(e => (e.modelVersion ?? 'campplus') === row.modelVersion);
  if (sameSpace.length) return { label: '', how: 'no-vector-match' };

  const scored = speakerEmbeddings
    .map(e => ({ label: e.speakerLabel, err: Math.abs(e.durationS - row.durationS) / Math.max(row.durationS, 1) }))
    .sort((a, b) => a.err - b.err);
  if (!scored.length || scored[0].err > 0.05) return { label: '', how: 'duration-no-fit' };
  if (scored[1] && scored[1].err < 0.15) return { label: '', how: 'duration-ambiguous' };
  return { label: scored[0].label, how: `duration-inferred ${(scored[0].err * 100).toFixed(1)}%` };
}

(async () => {
  const rows = await prisma.voiceProfile.findMany({
    where: { recordingId: { not: null }, clipStartS: null },
    select: {
      id: true, personName: true, recordingId: true, embedding: true,
      speakerLabel: true, durationS: true, modelVersion: true,
    },
  });
  console.log(`${rows.length} meeting-derived sample(s) with no span.\n`);
  if (!rows.length) { await prisma.$disconnect(); return; }

  const recIds = [...new Set(rows.map(r => r.recordingId))];
  const transcripts = await prisma.transcript.findMany({
    where: { recordingId: { in: recIds } },
    select: { recordingId: true, segments: true },
  });
  const segsOf = new Map();
  for (const t of transcripts) {
    try { segsOf.set(t.recordingId, JSON.parse(t.segments)); } catch { /* unparseable */ }
  }
  const embsOf = new Map();
  for (const id of recIds) {
    embsOf.set(id, await prisma.speakerEmbedding.findMany({
      where: { recordingId: id },
      select: { speakerLabel: true, embedding: true, durationS: true, modelVersion: true },
    }));
  }

  let written = 0, skipped = 0;
  for (const r of rows) {
    const { label, how } = recoverLabel(r, embsOf.get(r.recordingId) ?? []);

    const segs = segsOf.get(r.recordingId) ?? [];
    const own = segs.filter(s => {
      if (!(s.end > s.start)) return false;
      const sp = String(s.speaker);
      return sp === r.personName || (!!label && sp === label);
    });
    const span = bestSpan(own);

    if (!span) {
      console.log(`- skip ${r.id} (${r.personName}): no segments matched name or label ${label || '(none)'}`);
      skipped += 1;
      continue;
    }
    console.log(`- ${r.id} (${r.personName}) label=${label || '(none)'} [${how}] span ${span.start}s-${span.end}s from ${own.length} segments`);
    if (APPLY) {
      await prisma.voiceProfile.update({
        where: { id: r.id },
        data: { clipStartS: span.start, clipEndS: span.end, speakerLabel: label },
      });
    }
    written += 1;
  }

  console.log(`\n${APPLY ? 'Wrote' : 'Would write'} ${written}, skipped ${skipped}.`);
  if (!APPLY) console.log('Re-run with --apply to write.');
  await prisma.$disconnect();
})().catch(async (err) => {
  console.error(err.message);
  await prisma.$disconnect();
  process.exit(1);
});
