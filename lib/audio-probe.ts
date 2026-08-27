// How long is this audio, really?
//
// Byte size cannot answer that. A WebM/Opus chunk carries its container header
// on every upload, so the pause-button tail that killed recording cmtbd1od3 on
// 27 Aug 2026 was 25,400 bytes of almost pure header holding under 0.1s of
// sound — comfortably past the old `length < 1000` guard, and then rejected by
// the ASR provider with a permanent 400 that was retried ten times and failed
// the whole 31-minute meeting.
//
// ffmpeg already ships in this project (ffmpeg-static, used by lib/voice-id's
// decodePcm) and it knows the real answer, so ask it. The probe decodes nothing
// and writes nothing: it reads the container and reports duration, which for a
// chunk this size costs single-digit milliseconds.
import { spawn } from 'child_process';
import { writeFile, unlink } from 'fs/promises';
import os from 'os';
import path from 'path';

/**
 * Shortest chunk worth sending to a transcription provider.
 *
 * Groq and OpenAI both hard-reject below 0.1s. The margin above that is
 * deliberate: audio this short cannot carry a word, so transcribing it buys
 * nothing even where the provider would accept it.
 */
export const MIN_CHUNK_AUDIO_S = parseFloat(process.env.MIN_CHUNK_AUDIO_S ?? '0.35');

function ffmpegPath(): string | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const p = require('ffmpeg-static') as string | null;
    return p ?? null;
  } catch {
    return null;
  }
}

export function extForMime(mimeType: string): string {
  return mimeType.includes('mp4') ? '.mp4'
    : mimeType.includes('ogg') ? '.ogg'
    : mimeType.includes('wav') ? '.wav'
    : mimeType.includes('mpeg') ? '.mp3'
    : mimeType.includes('m4a') ? '.m4a'
    : '.webm';
}

/**
 * Duration of `audio` in seconds, or null when it cannot be determined.
 *
 * Null is not zero, and callers must not treat it as such: an unavailable
 * ffmpeg or an unparseable container is a reason to let the chunk through to
 * the provider and find out, never a reason to silently drop audio.
 */
export async function audioDurationSeconds(audio: Buffer, mimeType: string): Promise<number | null> {
  const ffmpeg = ffmpegPath();
  if (!ffmpeg) return null;

  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const inPath = path.join(os.tmpdir(), `probe-${stamp}${extForMime(mimeType)}`);
  try {
    await writeFile(inPath, audio);
    // Decode to nothing and read the reported end time. `-f null` is the
    // cheapest way to get a duration that is correct even when the container
    // header lies about it, which streamed WebM routinely does: MediaRecorder
    // writes an unknown-duration header and never goes back to fix it.
    const out = await new Promise<string>((resolve, reject) => {
      const p = spawn(ffmpeg, ['-hide_banner', '-nostdin', '-i', inPath, '-f', 'null', '-']);
      let err = '';
      p.stderr.on('data', (d) => { err += d.toString(); });
      p.on('error', reject);
      p.on('close', () => resolve(err));
      // A probe that hangs must not hold a serverless invocation open.
      setTimeout(() => { try { p.kill('SIGKILL'); } catch { /* already gone */ } }, 10_000);
    });

    // ffmpeg's progress line ends with the last timestamp it decoded, e.g.
    // "time=00:00:00.06". Take the last one: earlier lines are partial.
    const matches = [...out.matchAll(/time=(\d+):(\d\d):(\d\d(?:\.\d+)?)/g)];
    if (!matches.length) return null;
    const [, h, m, s] = matches[matches.length - 1];
    const seconds = Number(h) * 3600 + Number(m) * 60 + Number(s);
    return Number.isFinite(seconds) ? seconds : null;
  } catch {
    return null;
  } finally {
    unlink(inPath).catch(() => {});
  }
}

/**
 * True when this chunk is too short to be worth transcribing.
 *
 * Fails open: if the duration cannot be measured the chunk is NOT considered
 * unusable, because dropping audio we failed to understand is a worse outcome
 * than sending a provider something it may reject.
 */
export async function isUnusablyShort(audio: Buffer, mimeType: string): Promise<boolean> {
  const seconds = await audioDurationSeconds(audio, mimeType);
  return seconds !== null && seconds < MIN_CHUNK_AUDIO_S;
}
