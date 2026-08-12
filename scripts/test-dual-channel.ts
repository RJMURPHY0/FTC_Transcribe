// Dual-channel (online meeting) diarisation check.
//
// Builds a stereo fixture that reproduces the exact failure this feature
// exists to fix: you on the microphone, remote participants on the call, and
// the call bleeding back into your mic through the speakers.
//
//   left  (your mic)  = voice A, plus a delayed, attenuated copy of the right
//                       channel — the echo a speakerphone produces
//   right (the call)  = voice B and voice C, alternating
//
// Then asserts the three properties the design promises:
//   1. the pair is detected as dual-channel from the audio alone
//   2. leaked call audio is not attributed to you
//   3. the local speaker is exactly one cluster, sharing with nobody
//
// It also runs the same audio through the old mono path as a control, so the
// improvement is measured rather than asserted.
//
// Usage: npx tsx scripts/test-dual-channel.ts

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { execFileSync } from 'child_process';
import os from 'os';
import path from 'path';
import { analyzeChunkVoices, resolveGlobalSpeakers } from '../lib/voice-id';
import type { ChunkForAlignment } from '../lib/voice-id';

const SR = 16000;
const VOICES = path.join('.local', 'test-voices');

function readWavMono(file: string): Float32Array {
  const buf = readFileSync(file);
  const idx = buf.indexOf('data');
  const len = buf.readUInt32LE(idx + 4);
  const start = idx + 8;
  const end = Math.min(start + len, buf.length);
  const n = Math.floor((end - start) / 2);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = buf.readInt16LE(start + i * 2) / 32768;
  return out;
}

function writeWavStereo(file: string, left: Float32Array, right: Float32Array): void {
  const n = Math.min(left.length, right.length);
  const dataBytes = n * 4; // 2 channels * 16-bit
  const buf = Buffer.alloc(44 + dataBytes);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + dataBytes, 4);
  buf.write('WAVE', 8);
  buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(2, 22);          // stereo
  buf.writeUInt32LE(SR, 24);
  buf.writeUInt32LE(SR * 4, 28);
  buf.writeUInt16LE(4, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36);
  buf.writeUInt32LE(dataBytes, 40);
  const clamp = (v: number) => Math.max(-32768, Math.min(32767, Math.round(v * 32767)));
  for (let i = 0; i < n; i++) {
    buf.writeInt16LE(clamp(left[i]), 44 + i * 4);
    buf.writeInt16LE(clamp(right[i]), 46 + i * 4);
  }
  writeFileSync(file, buf);
}

function concatWithGaps(files: string[], gapS: number): { samples: Float32Array; spans: Array<[number, number]> } {
  const clips = files.map(readWavMono);
  const gap = Math.round(gapS * SR);
  const total = clips.reduce((n, c) => n + c.length + gap, 0);
  const out = new Float32Array(total);
  const spans: Array<[number, number]> = [];
  let off = 0;
  for (const c of clips) {
    out.set(c, off);
    spans.push([off / SR, (off + c.length) / SR]);
    off += c.length + gap;
  }
  return { samples: out.subarray(0, off), spans };
}

function pick(prefix: string, count: number): string[] {
  const out: string[] = [];
  for (let i = 0; i < 40 && out.length < count; i++) {
    const f = path.join(VOICES, `${prefix}_${String(i).padStart(2, '0')}.wav`);
    if (existsSync(f)) out.push(f);
  }
  return out;
}

async function main() {
  const localFiles  = pick('david', 8);
  const remoteFiles = pick('zira', 8);
  if (localFiles.length < 4 || remoteFiles.length < 4) {
    console.error(`Need test voices in ${VOICES} (david_*.wav, zira_*.wav). Found ${localFiles.length}/${remoteFiles.length}.`);
    process.exit(1);
  }

  // Interleave: you speak, they reply, and so on. Each side is silent while the
  // other talks, which is what makes the leakage test meaningful.
  const local  = concatWithGaps(localFiles, 3.0);
  const remote = concatWithGaps(remoteFiles, 3.0);

  const n = Math.max(local.samples.length, remote.samples.length);
  const left  = new Float32Array(n);
  const right = new Float32Array(n);
  left.set(local.samples, 0);
  // Offset the remote side so the two rarely overlap, mimicking turn-taking.
  const shift = Math.round(2.6 * SR);
  for (let i = 0; i < remote.samples.length && i + shift < n; i++) right[i + shift] = remote.samples[i];

  // Speakerphone echo: the call, delayed by 120 ms and attenuated, arriving in
  // your microphone. This is what used to get labelled as you.
  const delay = Math.round(0.12 * SR);
  const ECHO_GAIN = 0.45;
  for (let i = delay; i < n; i++) left[i] += ECHO_GAIN * right[i - delay];

  const tmp = path.join(os.tmpdir(), `dual-fixture-${Date.now()}.wav`);
  writeWavStereo(tmp, left, right);
  console.log(`fixture: ${(n / SR).toFixed(1)}s stereo, echo gain ${ECHO_GAIN} at ${(delay / SR * 1000).toFixed(0)}ms\n`);

  // ── Dual-channel path ──────────────────────────────────────────────────────
  const dual = await analyzeChunkVoices(readFileSync(tmp), 'audio/wav');
  if (!dual) { console.error('FAIL: analyzeChunkVoices returned null'); process.exit(1); }

  const micTurns = dual.turns.filter((t) => t.channel === 'mic');
  const sysTurns = dual.turns.filter((t) => t.channel === 'system');
  console.log(`detected channels: mic turns=${micTurns.length} system turns=${sysTurns.length}`);

  let failures = 0;
  const check = (ok: boolean, label: string, detail = '') => {
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
    if (!ok) failures++;
  };

  check(micTurns.length > 0 && sysTurns.length > 0,
    'detected as dual-channel from the audio alone');

  // Leakage: any mic turn falling inside a window where ONLY the remote side
  // was speaking is echo that survived the gate.
  const remoteSpans = remote.spans.map(([s, e]) => [s + shift / SR, e + shift / SR] as [number, number]);
  const localSpans = local.spans;
  const insideAny = (t: { start: number; end: number }, spans: Array<[number, number]>) =>
    spans.some(([s, e]) => t.start < e - 0.2 && t.end > s + 0.2);
  const leaked = micTurns.filter((t) => insideAny(t, remoteSpans) && !insideAny(t, localSpans));
  check(leaked.length === 0, 'no remote-only audio attributed to the local speaker',
    leaked.length ? `${leaked.length} leaked turn(s) survived` : `${micTurns.length} mic turns all overlap real local speech`);

  check(new Set(micTurns.map((t) => t.speaker)).size <= 1,
    'local channel is a single speaker id');

  // ── Global resolution ──────────────────────────────────────────────────────
  // Segments carry the channel they came from, exactly as per-channel
  // transcription produces them in the real pipeline.
  const chunk: ChunkForAlignment = {
    offset: 0,
    segments: dual.turns.map((t) => ({
      start: t.start, end: t.end, text: 'word word word', channel: t.channel,
    })),
    voiceData: dual,
  };
  const resolved = resolveGlobalSpeakers([chunk], []);
  if (!resolved) { console.error('FAIL: resolveGlobalSpeakers returned null'); process.exit(1); }

  const labels = new Set(resolved.segments.map((s) => s.speaker));
  console.log(`\nresolved speakers: ${[...labels].join(', ')}`);

  // Segments come back in input order per chunk, so walk them alongside the
  // turns they were built from rather than guessing by timestamp — mic and
  // system turns overlap, which is precisely what makes a time lookup
  // ambiguous.
  const micLabels = new Set<string>();
  const sysLabels = new Set<string>();
  {
    const byKey = new Map<string, string>();
    for (const s of resolved.segments) {
      const key = `${s.start.toFixed(2)}:${s.end.toFixed(2)}`;
      if (!byKey.has(key)) byKey.set(key, s.speaker);
    }
    for (const t of dual.turns) {
      const label = byKey.get(`${t.start.toFixed(2)}:${t.end.toFixed(2)}`);
      if (!label) continue;
      (t.channel === 'mic' ? micLabels : sysLabels).add(label);
    }
  }
  check(micLabels.size === 1, 'local speaker resolves to exactly one identity',
    `got ${[...micLabels].join(', ') || 'none'}`);
  const shared = [...micLabels].filter((l) => sysLabels.has(l as string));
  check(shared.length === 0, 'local speaker shares no label with the call',
    shared.length ? `shared: ${shared.join(', ')}` : `call side: ${[...sysLabels].join(', ')}`);

  // ── Real container ─────────────────────────────────────────────────────────
  // Production never sees a WAV: the browser uploads stereo webm/opus. Opus is
  // lossy and joint-stereo coded, so confirm the two sides survive encoding
  // still distinct enough for the detector, rather than assuming it.
  const ffmpeg = require('ffmpeg-static') as string;
  const webmPath = tmp.replace('.wav', '.webm');
  execFileSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-i', tmp,
    '-c:a', 'libopus', '-b:a', '64k', '-ac', '2', '-y', webmPath]);
  const viaWebm = await analyzeChunkVoices(readFileSync(webmPath), 'audio/webm');
  const webmMic = viaWebm?.turns.filter((t) => t.channel === 'mic').length ?? 0;
  const webmSys = viaWebm?.turns.filter((t) => t.channel === 'system').length ?? 0;
  check(webmMic > 0 && webmSys > 0, 'stereo webm/opus is still detected as dual-channel',
    `mic=${webmMic} system=${webmSys}`);

  // ── Control: the same audio the old way ────────────────────────────────────
  // Mono downmix is what shipped before, and what a non-dual recording still
  // gets. Reported rather than asserted: it is the comparison, not the target.
  const monoPath = tmp.replace('.wav', '-mono.wav');
  execFileSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-i', tmp, '-ac', '1', '-y', monoPath]);
  const mono = await analyzeChunkVoices(readFileSync(monoPath), 'audio/wav');
  const monoChunk: ChunkForAlignment = {
    offset: 0,
    segments: (mono?.turns ?? []).map((t) => ({ start: t.start, end: t.end, text: 'word word word' })),
    voiceData: mono,
  };
  const monoResolved = mono ? resolveGlobalSpeakers([monoChunk], []) : null;
  const monoLabels = new Set(monoResolved?.segments.map((s) => s.speaker) ?? []);
  console.log(`\ncontrol (old mono path): ${monoLabels.size} speaker(s) — ${[...monoLabels].join(', ') || 'none'}`);
  console.log(`dual path:               ${labels.size} speaker(s)`);
  console.log('(fixture contains 2 real voices; the mono path also has to contend with the echo)');

  console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
