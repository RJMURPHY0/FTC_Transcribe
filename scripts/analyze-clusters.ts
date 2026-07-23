// Temporal + acoustic structure of a replayed meeting: per-speaker activity
// timeline (deciles), speaker-adjacency handoffs, and centroid cross-sims.
// Distinguishes "one person split into two clusters" (rarely adjacent,
// moderate cross-sim, alternate with the same partner) from "two people"
// and "played-back audio" (contiguous block, distinct sims).
//
// Usage: npx tsx scripts/analyze-clusters.ts <snapshot.json> [--env K=V]...
import { readFileSync } from 'fs';

async function main() {
  const args = process.argv.slice(2);
  const file = args.find((a) => !a.startsWith('--'))!;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--env' && args[i + 1]) { const [k, v] = args[++i].split('='); process.env[k] = v; }
  }
  const snap = JSON.parse(readFileSync(file, 'utf8'));
  const { resolveGlobalSpeakers, matchProfilesDetailed, cosineSim } = await import('../lib/voice-id');

  const chunks = snap.chunks.map((c: any) => ({ offset: c.offset, segments: c.segments, voiceData: c.voiceData }));
  const profiles = snap.profiles.map((p: any) => ({ personName: p.personName, embedding: p.embedding, source: p.source }));
  const resolved = resolveGlobalSpeakers(chunks, profiles)!;
  const matches = matchProfilesDetailed(resolved.speakerEmbeddings, profiles);
  const nameOf = (l: string) => matches[l] ? `${matches[l].name}~${l}` : l;

  const total = Math.max(...resolved.segments.map((s) => s.end));
  const speakers = new Map<string, { dur: number; deciles: number[]; first: number; last: number }>();
  for (const s of resolved.segments) {
    const k = nameOf(s.speaker);
    if (!speakers.has(k)) speakers.set(k, { dur: 0, deciles: new Array(10).fill(0), first: s.start, last: s.end });
    const sp = speakers.get(k)!;
    sp.dur += s.end - s.start;
    sp.first = Math.min(sp.first, s.start);
    sp.last = Math.max(sp.last, s.end);
    const d = Math.min(9, Math.floor((s.start / total) * 10));
    sp.deciles[d] += s.end - s.start;
  }
  console.log(`total ${Math.round(total)}s — activity per decile of the meeting (seconds):`);
  for (const [k, sp] of [...speakers.entries()].sort((a, b) => b[1].dur - a[1].dur)) {
    console.log(`  ${k.padEnd(22)} ${String(Math.round(sp.dur)).padStart(5)}s  [${sp.deciles.map((d) => String(Math.round(d)).padStart(4)).join(' ')}]  ${Math.round(sp.first)}s→${Math.round(sp.last)}s`);
  }

  // Adjacency: who follows whom (segment handoffs)
  const adj = new Map<string, number>();
  const ordered = [...resolved.segments].sort((a, b) => a.start - b.start);
  for (let i = 1; i < ordered.length; i++) {
    const a = nameOf(ordered[i - 1].speaker), b = nameOf(ordered[i].speaker);
    if (a === b) continue;
    const k = `${a} → ${b}`;
    adj.set(k, (adj.get(k) ?? 0) + 1);
  }
  console.log('\nhandoffs (top 12):');
  for (const [k, n] of [...adj.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12)) console.log(`  ${k}: ${n}`);

  // Mid-sentence flip proxy: A→B→A sandwiches where B is short. Real speaker
  // interjections exist, so this is an upper bound — but a high count means
  // sentences are being chopped between speakers.
  {
    const seq = [...resolved.segments].sort((a, b) => a.start - b.start);
    let changes = 0, sandwiches = 0, shortSandwiches = 0;
    for (let i = 1; i < seq.length; i++) {
      if (seq[i].speaker !== seq[i - 1].speaker) changes++;
      if (i < seq.length - 1
        && seq[i - 1].speaker === seq[i + 1].speaker
        && seq[i].speaker !== seq[i - 1].speaker) {
        sandwiches++;
        if (seq[i].end - seq[i].start < 2.5) shortSandwiches++;
      }
    }
    // Text-aware chop: the previous segment ends mid-clause AND the new
    // speaker's text starts lowercase — a sentence split across speakers.
    let chops = 0;
    const chopSamples: string[] = [];
    for (let i = 1; i < seq.length; i++) {
      if (seq[i].speaker === seq[i - 1].speaker) continue;
      const prevEndsClean = /[.?!…]\s*$/.test(seq[i - 1].text.trim());
      const startsLower = /^[a-z]/.test(seq[i].text.trim());
      if (!prevEndsClean && startsLower && seq[i].end - seq[i].start < 4) {
        chops++;
        if (chopSamples.length < 6) {
          chopSamples.push(`${Math.round(seq[i].start)}s [${seq[i - 1].speaker}→${seq[i].speaker}] …${seq[i - 1].text.slice(-45)} ‖ ${seq[i].text.slice(0, 45)}`);
        }
      }
    }
    console.log(`\nspeaker changes=${changes}  A-B-A sandwiches=${sandwiches}  short(<2.5s) sandwiches=${shortSandwiches}  likely mid-sentence chops=${chops}`);
    for (const s of chopSamples) console.log('  ' + s);
  }

  console.log('\ncluster centroid cross-sims:');
  const se = resolved.speakerEmbeddings;
  for (let i = 0; i < se.length; i++) {
    for (let j = i + 1; j < se.length; j++) {
      console.log(`  ${nameOf(se[i].label)} × ${nameOf(se[j].label)}: ${cosineSim(se[i].embedding, se[j].embedding).toFixed(3)}`);
    }
  }

  // Labelled sequence over a window — lets the transcript's conversational
  // structure (who alternates with whom) be checked against cluster labels.
  const winArg = args.find((a) => a.startsWith('--window='));
  if (winArg) {
    const [from, to] = winArg.slice(9).split('-').map(Number);
    console.log(`\nsegments ${from}-${to}s:`);
    for (const s of resolved.segments.filter((x) => x.end >= from && x.start <= to)) {
      console.log(`  ${String(Math.round(s.start)).padStart(5)}s ${nameOf(s.speaker).padEnd(20)} ${s.text.slice(0, 90)}`);
    }
  }
}

main();
