// Diarization/voice-ID accuracy harness — NO DB, NO ASR APIs, pure local CPU.
//
// Builds synthetic meetings from TTS utterance WAVs with exact ground truth,
// runs the real pipeline (analyzeChunkVoices per 120s chunk → resolveGlobalSpeakers
// → matchProfilesDetailed) and scores:
//   - attribution: time-weighted % of speech assigned to the right person
//   - flips: spurious speaker changes inside a single ground-truth utterance
//   - naming: enrolled voices resolved to the right names
//
// Usage:
//   npx tsx scripts/test-diarization-accuracy.ts <voices-dir> [--env K=V]... [--only S1,S2]
// Generate <voices-dir> first with scripts/gen-test-voices.ps1.
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { execFileSync } from 'child_process';
import path from 'path';

const argv = process.argv.slice(2);
const VOICES = argv[0];
if (!VOICES) { console.error('usage: tsx test-diarization-accuracy.ts <voices-dir> [--env K=V] [--only S1,S3]'); process.exit(1); }
let only: string[] | null = null;
let noiseSigma = 0; // s16 units; ~300 ≈ 21 dB SNR vs TTS speech
for (let i = 1; i < argv.length; i++) {
  if (argv[i] === '--env' && argv[i + 1]) {
    const [k, v] = argv[++i].split('=');
    process.env[k] = v;
  } else if (argv[i] === '--only' && argv[i + 1]) {
    only = argv[++i].split(',');
  } else if (argv[i] === '--noise' && argv[i + 1]) {
    noiseSigma = parseFloat(argv[++i]);
  }
}

// Deterministic PRNG so noise runs are reproducible
function mulberry32(seed: number) {
  return () => {
    seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function addNoise(pcm: Buffer, sigma: number): Buffer {
  if (!sigma) return pcm;
  const rnd = mulberry32(1234567);
  const out = Buffer.from(pcm);
  for (let i = 0; i + 1 < out.length; i += 2) {
    // Box-Muller gaussian
    const g = Math.sqrt(-2 * Math.log(rnd() || 1e-9)) * Math.cos(2 * Math.PI * rnd());
    const v = Math.max(-32768, Math.min(32767, out.readInt16LE(i) + Math.round(g * sigma)));
    out.writeInt16LE(v, i);
  }
  return out;
}

const SR = 16000;

function wavSamples(file: string): Buffer {
  const buf = readFileSync(path.join(VOICES, file));
  const dataIdx = buf.indexOf('data');
  return buf.subarray(dataIdx + 8);
}

function makeWav(data: Buffer): Buffer {
  const header = Buffer.alloc(44);
  header.write('RIFF', 0); header.writeUInt32LE(36 + data.length, 4);
  header.write('WAVE', 8); header.write('fmt ', 12);
  header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22);
  header.writeUInt32LE(SR, 24); header.writeUInt32LE(SR * 2, 28);
  header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34);
  header.write('data', 36); header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

// Pitch-shifted David = the "similar voice" tier. Same prosody engine, ~1.6
// semitones up — harder than most real same-sex colleague pairs.
function ensurePitchVariants(): void {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const ffmpeg = require('ffmpeg-static') as string;
  const factor = 1.10;
  for (let i = 0; i < 14; i++) {
    const src = path.join(VOICES, `david_${String(i).padStart(2, '0')}.wav`);
    const dst = path.join(VOICES, `davidhi_${String(i).padStart(2, '0')}.wav`);
    if (existsSync(dst) || !existsSync(src)) continue;
    execFileSync(ffmpeg, [
      '-hide_banner', '-loglevel', 'error', '-i', src,
      '-af', `asetrate=${SR * factor},aresample=${SR},atempo=${(1 / factor).toFixed(6)}`,
      '-ac', '1', '-ar', String(SR), '-y', dst,
    ]);
  }
  for (let i = 0; i < 3; i++) {
    const src = path.join(VOICES, `david_enroll_${i}.wav`);
    const dst = path.join(VOICES, `davidhi_enroll_${i}.wav`);
    if (existsSync(dst) || !existsSync(src)) continue;
    execFileSync(ffmpeg, [
      '-hide_banner', '-loglevel', 'error', '-i', src,
      '-af', `asetrate=${SR * factor},aresample=${SR},atempo=${(1 / factor).toFixed(6)}`,
      '-ac', '1', '-ar', String(SR), '-y', dst,
    ]);
  }
}

interface GtSpan { speaker: string; start: number; end: number }

// Concatenate utterances (with silence gaps) into one PCM buffer + ground truth
function buildTimeline(script: Array<{ v: string; clip: number; gap: number }>): { pcm: Buffer; gt: GtSpan[] } {
  const pieces: Buffer[] = [];
  const gt: GtSpan[] = [];
  let t = 0;
  // small lead-in silence
  pieces.push(Buffer.alloc(Math.round(0.5 * SR) * 2)); t += 0.5;
  for (const item of script) {
    const clip = wavSamples(`${item.v}_${String(item.clip).padStart(2, '0')}.wav`);
    const dur = clip.length / 2 / SR;
    pieces.push(clip);
    gt.push({ speaker: item.v, start: t, end: t + dur });
    t += dur;
    pieces.push(Buffer.alloc(Math.round(item.gap * SR) * 2));
    t += item.gap;
  }
  return { pcm: Buffer.concat(pieces), gt };
}

// Simulated Whisper segments: ~4s pieces per utterance; every 3rd tight
// boundary produces one segment that BRIDGES the speaker change (the hard case)
function fakeSegments(gt: GtSpan[]): Array<{ start: number; end: number; text: string; gtSpeaker: string }> {
  const segs: Array<{ start: number; end: number; text: string; gtSpeaker: string }> = [];
  for (const span of gt) {
    const dur = span.end - span.start;
    const n = Math.max(1, Math.round(dur / 4));
    for (let i = 0; i < n; i++) {
      const s = span.start + (dur * i) / n;
      const e = span.start + (dur * (i + 1)) / n;
      segs.push({ start: s, end: e, text: `[${span.speaker}]`, gtSpeaker: span.speaker });
    }
  }
  // bridge every 3rd tight speaker-change boundary
  let boundary = 0;
  for (let i = 1; i < gt.length; i++) {
    if (gt[i].speaker === gt[i - 1].speaker) continue;
    boundary++;
    if (boundary % 3 !== 0) continue;
    if (gt[i].start - gt[i - 1].end > 1.2) continue;
    const bridgeStart = Math.max(gt[i - 1].start, gt[i - 1].end - 1.5);
    const bridgeEnd = Math.min(gt[i].end, gt[i].start + 1.5);
    // remove pieces fully inside the bridge, then add the bridge
    for (let k = segs.length - 1; k >= 0; k--) {
      if (segs[k].start >= bridgeStart - 0.01 && segs[k].end <= bridgeEnd + 0.01) segs.splice(k, 1);
    }
    const gtDominant = (gt[i - 1].end - bridgeStart) >= (bridgeEnd - gt[i].start) ? gt[i - 1].speaker : gt[i].speaker;
    // Real ASR bridge segments carry many words — splitting needs them
    segs.push({ start: bridgeStart, end: bridgeEnd, text: 'tail of one turn and then the reply that follows it', gtSpeaker: gtDominant });
  }
  return segs.sort((a, b) => a.start - b.start);
}

interface Scenario {
  name: string;
  script: Array<{ v: string; clip: number; gap: number }>;
  speakers: string[];
  enrolled: string[]; // which speakers have voice profiles for this scenario
}

function scenarios(): Scenario[] {
  const alt = (a: string, b: string, clips: number[], gaps: number[]) =>
    clips.map((c, i) => ({ v: i % 2 === 0 ? a : b, clip: c, gap: gaps[i % gaps.length] }));
  return [
    { name: 'S1-alternating', speakers: ['david', 'zira'], enrolled: ['david', 'zira'],
      script: alt('david', 'zira', [2, 4, 6, 8, 10, 11, 13, 3, 5, 7], [0.6, 0.9, 0.4]) },
    { name: 'S2-monologue', speakers: ['david', 'zira'], enrolled: ['david', 'zira'],
      script: [
        { v: 'david', clip: 2, gap: 0.3 }, { v: 'david', clip: 4, gap: 0.4 },
        { v: 'david', clip: 6, gap: 0.3 }, { v: 'david', clip: 8, gap: 0.4 },
        { v: 'david', clip: 10, gap: 0.3 }, { v: 'david', clip: 13, gap: 0.8 },
        { v: 'zira', clip: 0, gap: 0.6 }, { v: 'david', clip: 11, gap: 0.5 },
      ] },
    { name: 'S3-rapid', speakers: ['david', 'zira'], enrolled: ['david', 'zira'],
      script: alt('david', 'zira', [0, 1, 3, 5, 9, 12, 0, 1, 3, 5, 9, 12], [0.35, 0.5]) },
    // Blind separation of two very similar voices, neither enrolled beyond david
    { name: 'S4-similar', speakers: ['david', 'davidhi'], enrolled: ['david', 'zira'],
      script: alt('david', 'davidhi', [2, 4, 6, 8, 10, 11, 13, 3], [0.6, 0.8]) },
    // The user's real case: BOTH similar voices enrolled
    { name: 'S4b-sim-enrolled', speakers: ['david', 'davidhi'], enrolled: ['david', 'davidhi'],
      script: alt('david', 'davidhi', [2, 4, 6, 8, 10, 11, 13, 3], [0.6, 0.8]) },
    { name: 'S5-three', speakers: ['david', 'zira', 'davidhi'], enrolled: ['david', 'zira'],
      script: [
        { v: 'david', clip: 2, gap: 0.5 }, { v: 'zira', clip: 4, gap: 0.7 },
        { v: 'davidhi', clip: 6, gap: 0.5 }, { v: 'david', clip: 8, gap: 0.6 },
        { v: 'zira', clip: 10, gap: 0.5 }, { v: 'davidhi', clip: 11, gap: 0.7 },
        { v: 'zira', clip: 13, gap: 0.5 }, { v: 'david', clip: 5, gap: 0.5 },
      ] },
    // Long meeting that crosses several 120s chunk boundaries — exercises the
    // GLOBAL cross-chunk resolver (merging one speaker across chunks), which the
    // short single-chunk scenarios above barely touch.
    { name: 'S6-multichunk', speakers: ['david', 'zira'], enrolled: ['david', 'zira'],
      script: alt('david', 'zira',
        Array.from({ length: 52 }, (_, i) => [2, 4, 6, 8, 10, 11, 13, 3, 5, 7][i % 10]),
        [0.5, 0.7, 0.4]) },
  ];
}

const PERSON: Record<string, string> = { david: 'David Miller', zira: 'Zira Adams', davidhi: 'Dave Higgins' };

// Per-scenario regression floors so the harness can gate CI. Calibrated from the
// verified 2026-07-17 baseline with headroom: distinct/enrolled voices must stay
// near-perfect; the two "similar unenrolled voices merge" cases (S4/S5) have
// lower floors because that merge is a known CAM++ limit, not a regression —
// the floor still catches the ENROLLED speakers losing their attribution/name.
const EXPECT: Record<string, { minAcc: number; names: boolean; maxFlips: number }> = {
  'S1-alternating':   { minAcc: 97, names: true, maxFlips: 0 },
  'S2-monologue':     { minAcc: 97, names: true, maxFlips: 0 },
  'S3-rapid':         { minAcc: 95, names: true, maxFlips: 0 },
  'S4-similar':       { minAcc: 50, names: true, maxFlips: 2 },
  'S4b-sim-enrolled': { minAcc: 97, names: true, maxFlips: 0 },
  'S5-three':         { minAcc: 60, names: true, maxFlips: 2 },
  'S6-multichunk':    { minAcc: 95, names: true, maxFlips: 1 },
};

async function main() {
  ensurePitchVariants();
  const { analyzeChunkVoices, resolveGlobalSpeakers, matchProfilesDetailed, embedAudioSample } = await import('@/lib/voice-id');

  // Enrollment pool from held-out clips; scenarios pick who is enrolled
  const profilePool = new Map<string, Array<{ personName: string; embedding: number[] }>>();
  for (const who of ['david', 'zira', 'davidhi']) {
    const rows: Array<{ personName: string; embedding: number[] }> = [];
    for (let i = 0; i < 3; i++) {
      const wav = makeWav(wavSamples(`${who}_enroll_${i}.wav`));
      const r = await embedAudioSample(wav, 'audio/wav');
      if (!r) throw new Error(`enrollment failed: ${who}_${i}`);
      rows.push({ personName: PERSON[who], embedding: r.embedding });
    }
    profilePool.set(who, rows);
  }
  console.log(`enrollment pool ready (${[...profilePool.keys()].join(', ')})`);

  const results: Array<Record<string, string | number>> = [];
  let anyFail = false;

  for (const sc of scenarios()) {
    if (only && !only.some((o) => sc.name.startsWith(o))) continue;
    const profiles = sc.enrolled.flatMap((w) => profilePool.get(w) ?? []);
    const { pcm: cleanPcm, gt } = buildTimeline(sc.script);
    const pcm = addNoise(cleanPcm, noiseSigma);
    const totalS = pcm.length / 2 / SR;

    // Split into 120s chunks like the recorder does
    const CHUNK_S = 120;
    const chunks: Array<{ offset: number; segments: Array<{ start: number; end: number; text: string }>; voiceData: import('@/lib/voice-id').ChunkVoiceData | null }> = [];
    const allFake = fakeSegments(gt);
    const t0 = Date.now();
    for (let off = 0; off < totalS; off += CHUNK_S) {
      const s = Math.round(off * SR) * 2;
      const e = Math.min(Math.round((off + CHUNK_S) * SR) * 2, pcm.length);
      const wav = makeWav(pcm.subarray(s, e));
      const vd = await analyzeChunkVoices(wav, 'audio/wav');
      // mirror the DB round-trip
      const voiceData = vd ? JSON.parse(JSON.stringify(vd)) : null;
      const segs = allFake
        .filter((sg) => sg.start >= off && sg.start < off + CHUNK_S)
        .map((sg) => ({ start: sg.start - off, end: sg.end - off, text: sg.text }));
      chunks.push({ offset: off, segments: segs, voiceData });
    }
    const analyzeMs = Date.now() - t0;

    const resolved = resolveGlobalSpeakers(chunks, profiles);
    if (!resolved) { console.log(`${sc.name}: RESOLVE FAILED`); continue; }
    const matches = matchProfilesDetailed(resolved.speakerEmbeddings, profiles);
    const nameOf = (label: string) => matches[label]?.name ?? label;

    // Identity mapping for scoring: enrolled names map directly; leftover
    // output labels map to the GT speaker they overlap most (greedy majority).
    // GT per output segment = dominant time overlap (segments may be split).
    const gtFor = (s: { start: number; end: number }): string => {
      let best = '?', bw = 0.05;
      for (const g of gt) {
        const ov = Math.min(g.end, s.end) - Math.max(g.start, s.start);
        if (ov > bw) { bw = ov; best = g.speaker; }
      }
      return best;
    };
    const overlapByPair = new Map<string, number>();
    const outSegs = resolved.segments.map((s) => ({
      ...s,
      finalName: nameOf(s.speaker),
      gtSpeaker: gtFor(s),
    }));
    for (const s of outSegs) {
      if (s.gtSpeaker === '?') continue;
      const key = `${s.finalName}→${s.gtSpeaker}`;
      overlapByPair.set(key, (overlapByPair.get(key) ?? 0) + (s.end - s.start));
    }
    const labelToGt = new Map<string, string>();
    for (const who of sc.speakers) if (PERSON[who]) labelToGt.set(PERSON[who], who);
    const leftoverLabels = [...new Set(outSegs.map((s) => s.finalName))].filter((l) => !labelToGt.has(l));
    for (const l of leftoverLabels) {
      let best = '', bestW = -1;
      for (const [pair, w] of overlapByPair) {
        const [name, gtS] = pair.split('→');
        if (name !== l) continue;
        if (w > bestW) { bestW = w; best = gtS; }
      }
      if (best) labelToGt.set(l, best);
    }

    // Attribution (time-weighted) + flips inside single GT utterances
    let correctT = 0, totalT = 0;
    for (const s of outSegs) {
      if (s.gtSpeaker === '?') continue;
      const dur = s.end - s.start;
      totalT += dur;
      if (labelToGt.get(s.finalName) === s.gtSpeaker) correctT += dur;
    }
    let flips = 0;
    for (const span of gt) {
      const inside = outSegs.filter((s) => s.start >= span.start - 0.01 && s.end <= span.end + 0.01);
      for (let i = 1; i < inside.length; i++) {
        if (inside[i].finalName !== inside[i - 1].finalName) flips++;
      }
    }

    const enrolledPresent = sc.speakers.filter((w) => sc.enrolled.includes(w));
    const namesOk = enrolledPresent.every((w) =>
      outSegs.some((s) => s.finalName === PERSON[w] && labelToGt.get(PERSON[w]) === w));

    const detected = new Set(outSegs.map((s) => s.finalName)).size;
    const acc = totalT ? (100 * correctT) / totalT : 0;

    // Gate against the per-scenario regression floor.
    const exp = EXPECT[sc.name];
    const passed = !exp || (acc >= exp.minAcc && flips <= exp.maxFlips && (!exp.names || namesOk));
    if (!passed) anyFail = true;

    results.push({
      scenario: sc.name,
      acc: `${acc.toFixed(1)}%`,
      flips,
      speakers: `${detected}/${sc.speakers.length}`,
      names: namesOk ? 'OK' : 'WRONG',
      analyze: `${(analyzeMs / 1000).toFixed(0)}s`,
      result: passed ? 'PASS' : 'FAIL',
    });
    // dump per-segment detail for failed scenarios to a side file, not stdout
    if (acc < 97 || flips > 0 || !namesOk) {
      const detail = outSegs.map((s) =>
        `${s.start.toFixed(1)}-${s.end.toFixed(1)} gt=${s.gtSpeaker} got=${s.finalName} (${s.speaker})`).join('\n');
      const f = path.join(VOICES, `detail-${sc.name}.txt`);
      writeFileSync(f, detail);
      results[results.length - 1].detail = f;
    }
  }

  console.log('\nscenario          acc     flips  speakers  names  analyze  result');
  for (const r of results) {
    console.log(
      String(r.scenario).padEnd(17),
      String(r.acc).padStart(6),
      String(r.flips).padStart(6),
      String(r.speakers).padStart(9),
      String(r.names).padStart(6),
      String(r.analyze).padStart(8),
      String(r.result ?? '').padStart(6),
      r.detail ? ` detail: ${r.detail}` : '',
    );
  }

  if (anyFail) {
    console.error('\n❌ REGRESSION: one or more scenarios fell below their accuracy floor.');
    process.exit(1);
  }
  console.log('\n✅ All scenarios within accuracy floors.');
}

main().catch((err) => { console.error(err); process.exit(1); });
