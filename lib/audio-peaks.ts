// Pseudo-waveform peaks derived from transcript segments: each bar encodes
// speech density (words/sec) in its time bucket. Lets the player draw a
// waveform instantly with zero audio download or decode — decoding an
// 87-minute WebM in the browser is what made playback take forever.
// Dependency-free (safe to import from server components).

export interface PeakSegment {
  start: number;
  end: number;
  text: string;
}

export function peaksFromSegments(
  segments: PeakSegment[],
  durationSecs: number,
  bars = 192,
): number[] {
  if (!(durationSecs > 0) || segments.length === 0) return [];

  const peaks = new Array<number>(bars).fill(0);
  for (const seg of segments) {
    if (!(seg.end > seg.start)) continue;
    const words = seg.text ? seg.text.trim().split(/\s+/).length : 0;
    const rate = words / Math.max(seg.end - seg.start, 0.25);
    const from = Math.max(0, Math.floor((seg.start / durationSecs) * bars));
    const to = Math.min(bars - 1, Math.ceil((seg.end / durationSecs) * bars));
    for (let i = from; i <= to; i++) peaks[i] = Math.max(peaks[i], rate);
  }

  const max = Math.max(...peaks, 1e-6);
  // Whisper-app look: silence stays a flat 12% baseline (3px of a 25px bar),
  // speech rises with a gamma-0.7 curve so quiet speech still reads as speech
  // while silence gaps stay visibly flat.
  return peaks.map(p => (p <= 0 ? 0.12 : 0.12 + 0.88 * Math.pow(Math.min(p / max, 1), 0.7)));
}
