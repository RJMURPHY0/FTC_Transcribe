'use client';

import { useEffect, useRef, useState, useImperativeHandle, forwardRef } from 'react';

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
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${m}:${String(sec).padStart(2, '0')}`;
}

// Playback goes through a native <audio> element so sound starts as soon as
// the first bytes stream in. WaveSurfer only draws: fed precomputed peaks +
// duration it never downloads or decodes the audio itself (the old approach
// decoded the full file client-side before the play button even enabled).
const AudioPlayer = forwardRef<AudioPlayerHandle, Props>(function AudioPlayer(
  { recordingId, onTimeUpdate, bare = false, durationHint = 0, peaks },
  ref,
) {
  const containerRef   = useRef<HTMLDivElement>(null);
  const audioRef       = useRef<HTMLAudioElement | null>(null);
  const wsRef          = useRef<import('wavesurfer.js').default | null>(null);
  const pendingSeekRef = useRef<number | null>(null);
  const [ready,       setReady]       = useState(false);
  const [playing,     setPlaying]     = useState(false);
  const [buffering,   setBuffering]   = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration,    setDuration]    = useState(durationHint);
  const [loadError,   setLoadError]   = useState(false);

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

  useEffect(() => {
    let cancelled = false;

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
    const onTime    = () => { setCurrentTime(audio.currentTime); onTimeUpdate?.(audio.currentTime); };
    const onPlay    = () => setPlaying(true);
    const onPause   = () => setPlaying(false);
    const onWaiting = () => setBuffering(true);
    const onPlaying = () => setBuffering(false);
    const onEnded   = () => { setPlaying(false); setCurrentTime(0); };
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

    async function initWaveform() {
      if (!containerRef.current) return;
      const WaveSurfer = (await import('wavesurfer.js')).default;
      if (cancelled || !containerRef.current) return;
      const havePeaks = !!peaks && peaks.length > 0 && durationHint > 0;
      // Styled after the Whisper app's history player: 3px bars with ~2px
      // gaps centred on the midline, grey until played, brand orange behind
      // the playhead — progress reads as bars lighting up left to right.
      const ws = WaveSurfer.create({
        container:     containerRef.current,
        waveColor:     '#3a3a3a',
        progressColor: '#f39200',
        cursorColor:   'transparent',
        height:        56,
        barWidth:      3,
        barGap:        2,
        barRadius:     0,
        normalize:     true,
        media:         audio,
        // Without segment peaks (no transcript) WaveSurfer falls back to
        // fetching + decoding the audio to draw — playback still starts
        // instantly through the media element either way.
        ...(havePeaks ? { peaks: [peaks as number[]], duration: durationHint } : {}),
      });
      ws.on('error', () => { /* surfaced via the <audio> error handler */ });
      wsRef.current = ws;
    }
    void initWaveform();

    return () => {
      cancelled = true;
      wsRef.current?.destroy();
      wsRef.current = null;
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

  return (
    <div className={bare ? 'space-y-2' : 'rounded-2xl border border-surface-border bg-surface-card p-4 space-y-3'}>
      {loadError ? (
        <p className="text-sm text-ftc-mid text-center py-2">Audio unavailable.</p>
      ) : (
        <>
          {/* Waveform */}
          <div ref={containerRef} className="w-full" />

          {/* Controls + time */}
          <div className="flex items-center gap-3">
            {/* Stop */}
            <button
              onClick={stop}
              title="Stop"
              className="p-1.5 rounded-lg text-ftc-mid hover:text-ftc-gray transition-colors"
            >
              <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 24 24">
                <rect x="5" y="5" width="14" height="14" rx="1" />
              </svg>
            </button>

            {/* Play / Pause */}
            <button
              onClick={togglePlay}
              title={playing ? 'Pause' : 'Play'}
              className="flex items-center justify-center w-9 h-9 rounded-full bg-brand
                         hover:bg-brand-dark transition-colors flex-shrink-0"
            >
              {playing ? (
                <svg className="w-4 h-4 text-white" fill="currentColor" viewBox="0 0 24 24">
                  <rect x="6" y="4" width="4" height="16" rx="1" />
                  <rect x="14" y="4" width="4" height="16" rx="1" />
                </svg>
              ) : (
                <svg className="w-4 h-4 text-white" fill="currentColor" viewBox="0 0 24 24">
                  <path d="M8 5v14l11-7z" />
                </svg>
              )}
            </button>

            {/* Time */}
            <span className="tabular-nums text-xs text-ftc-mid ml-1">
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
