// Resolver threshold tuning against ground truth.
//
// scripts/diar-bench.ts caches every sherpa analysis window on disk, and the
// resolver itself runs in milliseconds, so once a sweep has been done the whole
// threshold space can be explored for the price of a few CPU-seconds. Nothing
// here touches audio or the embedder.
//
// The failure this exists to fix is over-splitting: across the synthetic scenes
// the pipeline consistently reports one speaker MORE than there are people, and
// speaker count is what users actually notice.
//
//   npx tsx scripts/diar-tune.ts --workdir DIR [--scenes a,b] [--top 15]
//
// Thresholds are read at module load in lib/voice-id.ts, so each configuration
// re-imports it with a cache-busting query string rather than spawning a child.
import { readFileSync, existsSync, readdirSync } from 'fs';
import path from 'path';
import { computeDER, type Turn } from './diar-bench';

const SR = 16000;
const CHUNK_S = 120;

interface AsrSegment { start: number; end: number; text: string }

interface Scene {
  name: string;
  durationS: number;
  truth: Turn[];
  asr: AsrSegment[];
  windows: Array<{ offset: number; voiceData: unknown }>;
}

// Rebuild the exact chunk list the benchmark fed the resolver, from cache only.
function loadScenes(workDir: string, want?: string[]): Scene[] {
  const cacheDir = path.join(workDir, 'analysis-cache');
  if (!existsSync(cacheDir)) throw new Error(`no analysis cache in ${workDir} — run diar-bench.ts first`);
  const truthFiles = readdirSync(workDir).filter((f) => f.endsWith('.truth.json'));
  const scenes: Scene[] = [];

  for (const tf of truthFiles) {
    const name = tf.replace('.truth.json', '');
    if (want && !want.includes(name)) continue;
    const asrFile = path.join(workDir, `${name}.asr.json`);
    if (!existsSync(asrFile)) continue;
    const truth: Turn[] = JSON.parse(readFileSync(path.join(workDir, tf), 'utf8'));
    const asr: AsrSegment[] = JSON.parse(readFileSync(asrFile, 'utf8'));
    const durationS = Math.ceil(Math.max(...truth.map((t) => t.end)) + 1);

    // Production condition only: 120 s windows.
    const files = readdirSync(cacheDir)
      .filter((f) => f.startsWith(`${name}__${CHUNK_S}__`))
      .sort((a, b) => Number(a.split('__')[2].replace('.json', '')) - Number(b.split('__')[2].replace('.json', '')));
    if (!files.length) continue;
    const windows = files.map((f) => ({
      offset: Number(f.split('__')[2].replace('.json', '')),
      voiceData: JSON.parse(readFileSync(path.join(cacheDir, f), 'utf8')),
    }));
    scenes.push({ name, durationS, truth, asr, windows });
  }
  if (!scenes.length) throw new Error('no cached scenes found');
  return scenes;
}

type Config = Record<string, string>;

let importCounter = 0;
async function scoreConfig(scenes: Scene[], config: Config) {
  for (const [k, v] of Object.entries(config)) process.env[k] = v;
  // Fresh module instance so the module-level threshold constants are re-read.
  const mod = await import(`../lib/voice-id?tune=${importCounter++}`);
  const { resolveGlobalSpeakers } = mod as typeof import('../lib/voice-id');

  const rows = scenes.map((sc) => {
    const chunks = sc.windows.map((w) => {
      const winEnd = w.offset + CHUNK_S;
      return {
        offset: w.offset,
        segments: sc.asr
          .filter((a) => a.start >= w.offset && a.start < winEnd)
          .map((a) => ({ start: a.start - w.offset, end: a.end - w.offset, text: a.text })),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        voiceData: w.voiceData as any,
      };
    });
    const resolved = resolveGlobalSpeakers(chunks, []);
    if (!resolved) return { scene: sc.name, der: 1, spkErr: 99, conf: 1 };
    const hyp: Turn[] = [];
    for (const s of resolved.segments) {
      const last = hyp[hyp.length - 1];
      if (last && last.spk === s.speaker && Math.abs(last.end - s.start) < 0.01) last.end = s.end;
      else hyp.push({ start: s.start, end: s.end, spk: s.speaker });
    }
    const d = computeDER(sc.truth, hyp, sc.durationS);
    return {
      scene: sc.name, der: d.der, conf: d.confusion,
      spkErr: Math.abs(d.hypSpeakers - d.refSpeakers),
      hypSpk: d.hypSpeakers, refSpk: d.refSpeakers,
    };
  });

  const mean = (f: (r: typeof rows[number]) => number) => rows.reduce((a, r) => a + f(r), 0) / rows.length;
  return {
    meanDer: mean((r) => r.der),
    meanConf: mean((r) => r.conf),
    meanSpkErr: mean((r) => r.spkErr),
    perScene: rows.map((r) => `${r.scene}:${r.hypSpk ?? '?'}/${r.refSpk ?? '?'}`).join(' '),
  };
}

async function main() {
  const args = process.argv.slice(2);
  const getOpt = (n: string) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : undefined; };
  const workDir = getOpt('workdir');
  if (!workDir) { console.error('usage: tsx scripts/diar-tune.ts --workdir DIR [--scenes a,b] [--top 15]'); process.exit(1); }
  const top = Number(getOpt('top') ?? '15');
  const scenes = loadScenes(workDir, getOpt('scenes')?.split(','));
  console.log(`scenes: ${scenes.map((s) => `${s.name}(${s.windows.length}w)`).join(', ')}\n`);

  // Baseline = whatever the shipped defaults currently are.
  const baseline = await scoreConfig(scenes, {});
  console.log(`baseline  DER ${(baseline.meanDer * 100).toFixed(2)}%  conf ${(baseline.meanConf * 100).toFixed(2)}%  spkErr ${baseline.meanSpkErr.toFixed(2)}  ${baseline.perScene}\n`);

  // The three knobs that decide how many speakers survive. Over-splitting is
  // the observed failure, so the grid leans toward MORE merging than shipped.
  const grid: Config[] = [];
  // The grid must bracket the optimum on both sides. An earlier run bottomed
  // out at 0.60, which was its lowest value — an edge result is not an optimum.
  for (const turnCluster of ['0.45', '0.50', '0.55', '0.58', '0.60', '0.62', '0.65', '0.70']) {
    for (const centroidMerge of ['0.70', '0.75', '0.80', '0.85']) {
      for (const minSpeaker of ['20', '30', '45']) {
        grid.push({
          VOICE_TURN_CLUSTER_THRESHOLD: turnCluster,
          VOICE_CENTROID_MERGE_THRESHOLD: centroidMerge,
          VOICE_MIN_SPEAKER_S: minSpeaker,
        });
      }
    }
  }

  const results: Array<{ cfg: Config; r: Awaited<ReturnType<typeof scoreConfig>> }> = [];
  for (let i = 0; i < grid.length; i++) {
    const r = await scoreConfig(scenes, grid[i]);
    results.push({ cfg: grid[i], r });
    process.stdout.write(`\r  ${i + 1}/${grid.length}`);
  }
  console.log('\n');

  // Rank by speaker-count error first: a meeting split into seven speakers is
  // unusable even if its frame-level DER looks respectable.
  results.sort((a, b) =>
    (a.r.meanSpkErr - b.r.meanSpkErr) || (a.r.meanDer - b.r.meanDer));

  console.log('best configurations (ranked by speaker-count error, then DER):');
  for (const { cfg, r } of results.slice(0, top)) {
    const desc = `turn=${cfg.VOICE_TURN_CLUSTER_THRESHOLD} merge=${cfg.VOICE_CENTROID_MERGE_THRESHOLD} minSpk=${cfg.VOICE_MIN_SPEAKER_S}`;
    console.log(`  ${desc.padEnd(46)} DER ${(r.meanDer * 100).toFixed(2)}%  conf ${(r.meanConf * 100).toFixed(2)}%  spkErr ${r.meanSpkErr.toFixed(2)}  ${r.perScene}`);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
