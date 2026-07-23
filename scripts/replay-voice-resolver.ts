// Replay the global speaker resolver against a snapshot produced by
// scripts/snapshot-recording-voice.js — entirely offline, no DB, no audio.
//
// Usage:
//   npx tsx scripts/replay-voice-resolver.ts <snapshot.json> [--env K=V ...] [--json] [--stats] [--no-profiles]
//
// --stats prints embedding-similarity diagnostics (what the real-world
// same-voice / cross-voice cosine ranges actually are in this meeting).
import { readFileSync } from 'fs';

interface SnapshotChunk {
  offset: number;
  segments: Array<{ start: number; end: number; text: string; speaker?: number | string }>;
  voiceData: { turns: Array<{ start: number; end: number; speaker: number; embedding?: number[] }>; speakers: Array<{ speaker: number; embedding: number[]; durationS: number }> } | null;
}
interface Snapshot {
  recording: { id: string; title: string | null; duration: number };
  transcriptSegments: Array<{ start: number; end: number; text: string; speaker: string }>;
  chunks: SnapshotChunk[];
  profiles: Array<{ personName: string; embedding: number[]; source: string }>;
}

async function main() {
  const args = process.argv.slice(2);
  const file = args.find((a) => !a.startsWith('--'));
  if (!file) { console.error('usage: replay-voice-resolver.ts <snapshot.json> [--env K=V] [--stats] [--json] [--no-profiles]'); process.exit(1); }
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--env' && args[i + 1]) {
      const [k, v] = args[++i].split('=');
      process.env[k] = v;
    }
  }
  const wantStats = args.includes('--stats');
  const asJson = args.includes('--json');
  const useProfiles = !args.includes('--no-profiles');

  const snap: Snapshot = JSON.parse(readFileSync(file, 'utf8'));
  // Import AFTER env overrides — thresholds are read at module load.
  const { resolveGlobalSpeakers, matchProfilesDetailed, cosineSim } = await import('../lib/voice-id');

  const chunks = snap.chunks.map((c) => ({ offset: c.offset, segments: c.segments, voiceData: c.voiceData }));

  if (wantStats) {
    // Ground-truth-free diagnostics: within a chunk, turns sherpa gave the SAME
    // local speaker are near-certainly one voice → their pairwise sims estimate
    // the real same-voice range. Different local speakers within a chunk
    // estimate the cross-voice range (imperfect: sherpa can over-split).
    const same: number[] = [], diff: number[] = [];
    const durs: number[] = [];
    let turns = 0, embedded = 0;
    for (const c of snap.chunks) {
      if (!c.voiceData) continue;
      const et = c.voiceData.turns.filter((t) => t.embedding);
      turns += c.voiceData.turns.length;
      embedded += et.length;
      for (const t of c.voiceData.turns) durs.push(t.end - t.start);
      for (let i = 0; i < et.length; i++) {
        for (let j = i + 1; j < et.length; j++) {
          const s = cosineSim(et[i].embedding!, et[j].embedding!);
          (et[i].speaker === et[j].speaker ? same : diff).push(s);
        }
      }
    }
    const pct = (a: number[], p: number) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.floor(p * (s.length - 1))].toFixed(3) : 'n/a'; };
    console.log(`turns=${turns} embedded=${embedded}`);
    console.log(`turn duration p10/p50/p90: ${pct(durs, 0.1)}/${pct(durs, 0.5)}/${pct(durs, 0.9)}`);
    console.log(`within-chunk SAME-local-speaker sim  n=${same.length}  p10/p25/p50/p75/p90: ${pct(same, 0.1)}/${pct(same, 0.25)}/${pct(same, 0.5)}/${pct(same, 0.75)}/${pct(same, 0.9)}`);
    console.log(`within-chunk DIFF-local-speaker sim  n=${diff.length}  p10/p25/p50/p75/p90: ${pct(diff, 0.1)}/${pct(diff, 0.25)}/${pct(diff, 0.5)}/${pct(diff, 0.75)}/${pct(diff, 0.9)}`);
    // Per-chunk local speaker counts
    const counts = snap.chunks.filter((c) => c.voiceData).map((c) => new Set(c.voiceData!.turns.map((t) => t.speaker)).size);
    console.log(`per-chunk local speaker counts: ${counts.join(',')}`);
  }

  const profiles = useProfiles ? snap.profiles.map((p) => ({ personName: p.personName, embedding: p.embedding })) : [];
  const t0 = Date.now();
  const resolved = resolveGlobalSpeakers(chunks, profiles);
  const ms = Date.now() - t0;
  if (!resolved) { console.log('resolver returned null'); return; }

  // Same naming step production runs in resolveAndPersistVoiceSpeakers
  const matches = matchProfilesDetailed(resolved.speakerEmbeddings, profiles);
  const nameOf = (label: string) => matches[label] ? `${matches[label].name} (${matches[label].sim.toFixed(2)})` : label;

  const durBySpeaker = new Map<string, number>();
  for (const s of resolved.segments) {
    const key = nameOf(s.speaker);
    durBySpeaker.set(key, (durBySpeaker.get(key) ?? 0) + (s.end - s.start));
  }
  const ranked = [...durBySpeaker.entries()].sort((a, b) => b[1] - a[1]);
  const total = ranked.reduce((n, [, d]) => n + d, 0);
  const top = (n: number) => ranked.slice(0, n).reduce((s, [, d]) => s + d, 0) / Math.max(total, 1);

  const summary = {
    speakers: durBySpeaker.size,
    clusters: resolved.speakerEmbeddings.length,
    segments: resolved.segments.length,
    resolveMs: ms,
    top3Coverage: +(top(3)).toFixed(3),
    top5Coverage: +(top(5)).toFixed(3),
    ranked: ranked.slice(0, 12).map(([sp, d]) => `${sp}: ${Math.round(d)}s`),
  };
  if (asJson) console.log(JSON.stringify(summary));
  else {
    console.log(`speakers=${summary.speakers} clusters=${summary.clusters} segments=${summary.segments} resolveMs=${ms}`);
    console.log(`coverage top3=${summary.top3Coverage} top5=${summary.top5Coverage}`);
    console.log('top speakers by talk time:');
    for (const r of summary.ranked) console.log('  ' + r);
  }
}

main();
