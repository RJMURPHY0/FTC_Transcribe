'use client';

import { useEffect, useMemo, useRef, useState, useImperativeHandle, forwardRef, useCallback } from 'react';

export interface AudioPlayerHandle {
  seekTo: (seconds: number) => void;
  play: () => void;
}

interface Props {
  recordingId: string;
  onTimeUpdate?: (seconds: number) => void;
  /** Drop the card chrome — used inside the bottom playback bar. */
  bare?: boolean;
  /** Known duration (seconds) from the DB/transcript — shown before the audio reports one. */
  durationHint?: number;
  /** Precomputed pseudo-waveform peaks (0..1). With these the waveform renders instantly. */
  peaks?: number[];
}

function formatTime(s: number): string {
  if (!isFinite(s) || s < 0) s = 0;
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = Math.floor(s % 60);
  return h > 0
    ? `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`
    : `${m}:${String(sec).padStart(2, '0')}`;
}

// Deterministic placeholder peaks for recordings with no transcript-derived
// waveform — stable per recording, organic-looking, no audio decode.
function seededPeaks(seed: string, count: number): number[] {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) { h ^= seed.charCodeAt(i); h = Math.imul(h, 16777619); }
  const rand = () => {
    h = Math.imul(h ^ (h >>> 15), h | 1);
    h ^= h + Math.imul(h ^ (h >>> 7), h | 61);
    return ((h ^ (h >>> 14)) >>> 0) / 4294967296;
  };
  const raw = Array.from({ length: count }, () => 0.2 + 0.8 * rand());
  // Neighbour-average smoothing so it reads as speech, not static
  return raw.map((v, i) => {
    const a = raw[Math.max(0, i - 1)], b = raw[Math.min(count - 1, i + 1)];
    return Math.max(0.08, (a + v * 2 + b) / 4);
  });
}

// Max-pool source peaks into the bar count the current width can fit.
function resample(src: number[], count: number): number[] {
  if (src.length === count) return src;
  const out = new Array<number>(count);
  for (let i = 0; i < count; i++) {
    const from = Math.floor((i / count) * src.length);
    const to = Math.max(from + 1, Math.ceil(((i + 1) / count) * src.length));
    let max = 0;
    for (let j = from; j < to; j++) max = Math.max(max, src[j] ?? 0);
    out[i] = Math.max(0.08, max);
  }
  return out;
}

const SEEK_THROTTLE_MS = 150;

function renderStrip(bars: number[], colored: boolean) {
  return (
    <div className="flex items-center h-full" style={{ gap: 2 }} aria-hidden>
      {bars.map((v, i) => (
        <span
          key={i}
          className={`wf-bar flex-1 min-w-0 rounded-full ${
            colored
              ? 'bg-gradient-to-t from-brand to-[#ffb340]'
              : 'bg-[#3a3a3a] group-hover/wf:bg-[#484848] transition-colors duration-200'
          }`}
          style={{
            height: `${Math.round(v * 100)}%`,
            animationDelay: `${Math.min(i * 4, 500)}ms`,
          }}
        />
      ))}
    </div>
  );
}

// Playback goes through a native <audio> element so sound starts as soon as
// the first bytes stream in. The waveform is drawn from precomputed peaks —
// the audio is never downloaded or decoded just to paint bars. Progress is a
// clip-path over a duplicate bar strip, driven by requestAnimationFrame, so
// the playhead glides instead of stepping on 250ms timeupdate ticks.
const AudioPlayer = forwardRef<AudioPlayerHandle, Props>(function AudioPlayer(
  { recordingId, onTimeUpdate, bare = false, durationHint = 0, peaks },
  ref,
) {
  const wrapRef        = useRef<HTMLDivElement>(null);
  const progressRef    = useRef<HTMLDivElement>(null);
  const playheadRef    = useRef<HTMLDivElement>(null);
  const hoverLineRef   = useRef<HTMLDivElement>(null);
  const tooltipRef     = useRef<HTMLDivElement>(null);
  const audioRef       = useRef<HTMLAudioElement | null>(null);
  const pendingSeekRef = useRef<number | null>(null);
  const scrubbingRef   = useRef(false);
  const scrubFracRef   = useRef(0);
  const lastSeekAtRef  = useRef(0);
  const lastShownSecRef = useRef(-1);
  const durationRef    = useRef(durationHint);

  const [ready,       setReady]       = useState(false);
  const [playing,     setPlaying]     = useState(false);
  const [buffering,   setBuffering]   = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration,    setDuration]    = useState(durationHint);
  const [loadError,   setLoadError]   = useState(false);
  const [scrubbing,   setScrubbing]   = useState(false);
  const [hovering,    setHovering]    = useState(false);
  const [barCount,    setBarCount]    = useState(0);

  durationRef.current = duration;

  useImperativeHandle(ref, () => ({
    seekTo(seconds: number) {
      const audio = audioRef.current;
      if (audio && ready) {
        audio.currentTime = seconds;
      } else {
        pendingSeekRef.current = seconds; // applied on loadedmetadata
      }
    },
    play() {
      void audioRef.current?.play().catch(() => {});
    },
  }));

  // ── Audio element + events ──
  useEffect(() => {
    // metadata only: headers/duration load up front (cheap), bytes stream on play
    const audio = new Audio();
    audio.preload = 'metadata';
    audio.src = `/api/recordings/${recordingId}/audio`;
    audioRef.current = audio;

    const onLoadedMetadata = () => {
      setReady(true);
      if (isFinite(audio.duration) && audio.duration > 0) setDuration(audio.duration);
      if (pendingSeekRef.current !== null) {
        audio.currentTime = pendingSeekRef.current;
        pendingSeekRef.current = null;
      }
    };
    // MediaRecorder WebM often reports Infinity until buffered — keep the hint until finite
    const onDurationChange = () => {
      if (isFinite(audio.duration) && audio.duration > 0) setDuration(audio.duration);
    };
    const onTime = () => {
      if (scrubbingRef.current) return; // scrub position owns the display
      setCurrentTime(audio.currentTime);
      onTimeUpdate?.(audio.currentTime);
    };
    const onPlay    = () => setPlaying(true);
    const onPause   = () => setPlaying(false);
    const onWaiting = () => setBuffering(true);
    const onPlaying = () => setBuffering(false);
    const onEnded   = () => { setPlaying(false); setCurrentTime(0); audio.currentTime = 0; };
    const onError   = () => setLoadError(true);

    audio.addEventListener('loadedmetadata', onLoadedMetadata);
    audio.addEventListener('durationchange', onDurationChange);
    audio.addEventListener('timeupdate', onTime);
    audio.addEventListener('seeking', onTime);
    audio.addEventListener('play', onPlay);
    audio.addEventListener('pause', onPause);
    audio.addEventListener('waiting', onWaiting);
    audio.addEventListener('playing', onPlaying);
    audio.addEventListener('ended', onEnded);
    audio.addEventListener('error', onError);

    return () => {
      audio.pause();
      audio.removeEventListener('loadedmetadata', onLoadedMetadata);
      audio.removeEventListener('durationchange', onDurationChange);
      audio.removeEventListener('timeupdate', onTime);
      audio.removeEventListener('seeking', onTime);
      audio.removeEventListener('play', onPlay);
      audio.removeEventListener('pause', onPause);
      audio.removeEventListener('waiting', onWaiting);
      audio.removeEventListener('playing', onPlaying);
      audio.removeEventListener('ended', onEnded);
      audio.removeEventListener('error', onError);
      audio.removeAttribute('src');
      audio.load();
      audioRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [recordingId]);

  // ── Bar count follows the container width ──
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const compute = () => {
      const w = el.clientWidth;
      if (w > 0) setBarCount(Math.max(48, Math.min(192, Math.floor(w / 5))));
    };
    compute();
    const ro = new ResizeObserver(compute);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const bars = useMemo(() => {
    if (!barCount) return [];
    const src = peaks && peaks.length > 0 ? peaks : seededPeaks(recordingId, 192);
    return resample(src, barCount);
  }, [peaks, barCount, recordingId]);

  // Stable strip elements: time re-renders reuse them, so React skips
  // re-diffing hundreds of bar spans while the clock ticks.
  const baseStrip   = useMemo(() => renderStrip(bars, false), [bars]);
  const playedStrip = useMemo(() => renderStrip(bars, true),  [bars]);

  // ── Visual sync (no React state — direct style writes at frame rate) ──
  const paintFrac = useCallback((frac: number) => {
    const pct = Math.max(0, Math.min(1, frac)) * 100;
    if (progressRef.current) progressRef.current.style.clipPath = `inset(0 ${100 - pct}% 0 0)`;
    if (playheadRef.current) playheadRef.current.style.left = `${pct}%`;
  }, []);

  useEffect(() => {
    let raf = 0;
    const loop = () => {
      const audio = audioRef.current;
      const dur = durationRef.current;
      const frac = scrubbingRef.current
        ? scrubFracRef.current
        : audio && dur > 0 ? audio.currentTime / dur : 0;
      paintFrac(frac);
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [paintFrac]);

  // ── Scrub / hover ──
  const fracFromEvent = (e: { clientX: number }) => {
    const rect = wrapRef.current!.getBoundingClientRect();
    return Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
  };

  const moveTooltip = (frac: number) => {
    const dur = durationRef.current;
    const tip = tooltipRef.current;
    if (tip) {
      tip.style.left = `${frac * 100}%`;
      tip.textContent = formatTime(frac * dur);
    }
    if (hoverLineRef.current) hoverLineRef.current.style.left = `${frac * 100}%`;
  };

  const applyScrub = (frac: number, finalSeek: boolean) => {
    const audio = audioRef.current;
    const dur = durationRef.current;
    if (!audio || dur <= 0) return;
    scrubFracRef.current = frac;
    moveTooltip(frac);
    const t = frac * dur;
    // Seconds count up live while sliding — re-render only when the shown
    // second changes; the tooltip/playhead track the pointer at frame rate.
    const sec = Math.floor(t);
    if (sec !== lastShownSecRef.current || finalSeek) {
      lastShownSecRef.current = sec;
      setCurrentTime(t);
      onTimeUpdate?.(t);
    }
    const now = performance.now();
    if (finalSeek || now - lastSeekAtRef.current > SEEK_THROTTLE_MS) {
      lastSeekAtRef.current = now;
      audio.currentTime = t;
    }
  };

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (durationRef.current <= 0 || loadError) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    scrubbingRef.current = true;
    setScrubbing(true);
    applyScrub(fracFromEvent(e), false);
  };
  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (scrubbingRef.current) {
      applyScrub(fracFromEvent(e), false);
    } else if (e.pointerType === 'mouse' && durationRef.current > 0) {
      setHovering(true);
      moveTooltip(fracFromEvent(e));
    }
  };
  const endScrub = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!scrubbingRef.current) return;
    applyScrub(fracFromEvent(e), true);
    scrubbingRef.current = false;
    setScrubbing(false);
  };
  const onPointerLeave = () => setHovering(false);

  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const audio = audioRef.current;
    const dur = durationRef.current;
    if (!audio || dur <= 0) return;
    const step = e.shiftKey ? 30 : 5;
    let t: number | null = null;
    if (e.key === 'ArrowLeft')  t = audio.currentTime - step;
    if (e.key === 'ArrowRight') t = audio.currentTime + step;
    if (e.key === 'Home')       t = 0;
    if (e.key === 'End')        t = dur - 0.5;
    if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); togglePlay(); return; }
    if (t !== null) {
      e.preventDefault();
      audio.currentTime = Math.max(0, Math.min(dur, t));
    }
  };

  const togglePlay = () => {
    const audio = audioRef.current;
    if (!audio) return;
    if (audio.paused) void audio.play().catch(() => setLoadError(true));
    else audio.pause();
  };
  const stop = () => {
    const audio = audioRef.current;
    if (!audio) return;
    audio.pause();
    audio.currentTime = 0;
    setCurrentTime(0);
  };
  const skip = (secs: number) => {
    const audio = audioRef.current;
    const dur = durationRef.current;
    if (!audio || dur <= 0) return;
    audio.currentTime = Math.max(0, Math.min(dur, audio.currentTime + secs));
  };

  const tipVisible = scrubbing || hovering;

  return (
    <div className={bare ? 'space-y-2' : 'rounded-2xl border border-surface-border bg-surface-card p-4 space-y-3'}>
      <style>{`
        @keyframes wf-in { from { transform: scaleY(0.1); opacity: 0.2; } to { transform: scaleY(1); opacity: 1; } }
        .wf-bar { transform-origin: center; animation: wf-in 0.45s cubic-bezier(0.22, 1, 0.36, 1) both; }
        @keyframes wf-pulse { 0%, 100% { box-shadow: 0 0 6px 1px rgba(243, 146, 0, 0.55); } 50% { box-shadow: 0 0 12px 3px rgba(243, 146, 0, 0.85); } }
        @media (prefers-reduced-motion: reduce) { .wf-bar { animation: none; } }
      `}</style>
      {loadError ? (
        <p className="text-sm text-ftc-mid text-center py-2">Audio unavailable.</p>
      ) : (
        <>
          {/* Waveform scrubber */}
          <div
            ref={wrapRef}
            role="slider"
            aria-label="Seek position"
            aria-valuemin={0}
            aria-valuemax={Math.round(duration)}
            aria-valuenow={Math.round(currentTime)}
            aria-valuetext={`${formatTime(currentTime)} of ${formatTime(duration)}`}
            tabIndex={0}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={endScrub}
            onPointerCancel={endScrub}
            onPointerLeave={onPointerLeave}
            onKeyDown={onKeyDown}
            className={`group/wf relative w-full h-14 select-none outline-none rounded-lg
                        focus-visible:ring-2 focus-visible:ring-brand/60
                        ${duration > 0 ? (scrubbing ? 'cursor-grabbing' : 'cursor-pointer') : 'cursor-default'}`}
            style={{ touchAction: 'pan-y' }}
          >
            {/* Base (unplayed) bars */}
            <div className="absolute inset-0">{baseStrip}</div>

            {/* Played bars — clipped to progress, painted by rAF */}
            <div ref={progressRef} className="absolute inset-0" style={{ clipPath: 'inset(0 100% 0 0)' }}>
              {playedStrip}
            </div>

            {/* Playhead */}
            <div
              ref={playheadRef}
              className="absolute top-0 bottom-0 w-px -ml-px bg-brand pointer-events-none"
              style={{ left: '0%' }}
              aria-hidden
            >
              <span
                className="absolute -top-[3px] left-1/2 -translate-x-1/2 w-[7px] h-[7px] rounded-full bg-brand"
                style={playing ? { animation: 'wf-pulse 1.6s ease-in-out infinite' } : { boxShadow: '0 0 6px 1px rgba(243,146,0,0.55)' }}
              />
            </div>

            {/* Hover hairline (mouse only, hidden while scrubbing) */}
            <div
              ref={hoverLineRef}
              className={`absolute top-0 bottom-0 w-px bg-white/25 pointer-events-none transition-opacity duration-100
                          ${hovering && !scrubbing ? 'opacity-100' : 'opacity-0'}`}
              aria-hidden
            />

            {/* Time tooltip following the pointer */}
            <div
              ref={tooltipRef}
              className={`absolute -top-8 -translate-x-1/2 px-2 py-0.5 rounded-md bg-black/85 border border-surface-border
                          text-[11px] font-medium tabular-nums text-white whitespace-nowrap pointer-events-none
                          transition-opacity duration-100 ${tipVisible ? 'opacity-100' : 'opacity-0'}`}
              aria-hidden
            >
              0:00
            </div>
          </div>

          {/* Controls + time */}
          <div className="flex items-center gap-2">
            {/* Stop */}
            <button
              onClick={stop}
              title="Stop"
              className="p-1.5 rounded-lg text-ftc-mid hover:text-ftc-gray active:scale-90 transition-all"
            >
              <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 24 24">
                <rect x="5" y="5" width="14" height="14" rx="1" />
              </svg>
            </button>

            {/* Back 10s */}
            <button
              onClick={() => skip(-10)}
              title="Back 10 seconds"
              className="p-1.5 rounded-lg text-ftc-mid hover:text-ftc-gray active:scale-90 transition-all"
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={1.8} viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" d="M9 15L3 9l6-6" />
                <path strokeLinecap="round" d="M3 9h9a8 8 0 018 8v0" />
              </svg>
            </button>

            {/* Play / Pause */}
            <button
              onClick={togglePlay}
              title={playing ? 'Pause' : 'Play'}
              className={`relative flex items-center justify-center w-9 h-9 rounded-full bg-brand
                          hover:bg-brand-dark active:scale-95 transition-all flex-shrink-0
                          ${playing ? 'shadow-[0_0_14px_rgba(243,146,0,0.45)]' : ''}`}
            >
              {playing ? (
                <svg className="w-4 h-4 text-white" fill="currentColor" viewBox="0 0 24 24">
                  <rect x="6" y="4" width="4" height="16" rx="1" />
                  <rect x="14" y="4" width="4" height="16" rx="1" />
                </svg>
              ) : (
                <svg className="w-4 h-4 text-white translate-x-[1px]" fill="currentColor" viewBox="0 0 24 24">
                  <path d="M8 5v14l11-7z" />
                </svg>
              )}
            </button>

            {/* Forward 10s */}
            <button
              onClick={() => skip(10)}
              title="Forward 10 seconds"
              className="p-1.5 rounded-lg text-ftc-mid hover:text-ftc-gray active:scale-90 transition-all"
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={1.8} viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" d="M15 15l6-6-6-6" />
                <path strokeLinecap="round" d="M21 9h-9a8 8 0 00-8 8v0" />
              </svg>
            </button>

            {/* Time */}
            <span className="tabular-nums text-xs text-ftc-gray ml-1">
              {formatTime(currentTime)}
              {duration > 0 && <span className="text-surface-muted"> / {formatTime(duration)}</span>}
            </span>

            {/* Buffering indicator — only while the stream is catching up */}
            {buffering && playing && (
              <span className="ml-auto text-xs text-ftc-mid flex items-center gap-1.5">
                <span className="w-3 h-3 rounded-full border-2 border-ftc-mid/30 border-t-ftc-mid animate-spin" />
                Buffering…
              </span>
            )}
          </div>
        </>
      )}
    </div>
  );
});

export default AudioPlayer;
