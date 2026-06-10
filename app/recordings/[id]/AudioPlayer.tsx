'use client';

import { useEffect, useRef, useState, useImperativeHandle, forwardRef } from 'react';

export interface AudioPlayerHandle {
  seekTo: (seconds: number) => void;
}

interface Props {
  recordingId: string;
  onTimeUpdate?: (seconds: number) => void;
}

function formatTime(s: number): string {
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${m}:${String(sec).padStart(2, '0')}`;
}

const AudioPlayer = forwardRef<AudioPlayerHandle, Props>(function AudioPlayer(
  { recordingId, onTimeUpdate },
  ref,
) {
  const containerRef  = useRef<HTMLDivElement>(null);
  const wsRef         = useRef<import('wavesurfer.js').default | null>(null);
  const [ready,       setReady]       = useState(false);
  const [playing,     setPlaying]     = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration,    setDuration]    = useState(0);
  const [loadError,   setLoadError]   = useState(false);

  useImperativeHandle(ref, () => ({
    seekTo(seconds: number) {
      if (wsRef.current && duration > 0) {
        wsRef.current.seekTo(Math.min(seconds / duration, 1));
      }
    },
  }));

  useEffect(() => {
    let ws: import('wavesurfer.js').default;

    async function init() {
      if (!containerRef.current) return;
      const WaveSurfer = (await import('wavesurfer.js')).default;

      ws = WaveSurfer.create({
        container:     containerRef.current,
        waveColor:     '#555',
        progressColor: '#f39200',
        cursorColor:   '#f39200',
        height:        56,
        barWidth:      2,
        barGap:        2,
        barRadius:     2,
        normalize:     true,
        url:           `/api/recordings/${recordingId}/audio`,
      });

      ws.on('ready', dur => { setDuration(dur); setReady(true); });
      ws.on('audioprocess', t => {
        setCurrentTime(t);
        onTimeUpdate?.(t);
      });
      ws.on('seeking', t => {
        setCurrentTime(t);
        onTimeUpdate?.(t);
      });
      ws.on('play',   () => setPlaying(true));
      ws.on('pause',  () => setPlaying(false));
      ws.on('finish', () => { setPlaying(false); setCurrentTime(0); });
      ws.on('error',  () => setLoadError(true));

      wsRef.current = ws;
    }

    void init();
    return () => { ws?.destroy(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [recordingId]);

  const togglePlay = () => wsRef.current?.playPause();
  const stop = () => { wsRef.current?.stop(); setCurrentTime(0); };

  return (
    <div className="rounded-2xl border border-surface-border bg-surface-card p-4 space-y-3">
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
              disabled={!ready}
              title="Stop"
              className="p-1.5 rounded-lg text-ftc-mid hover:text-ftc-gray disabled:opacity-30 transition-colors"
            >
              <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 24 24">
                <rect x="5" y="5" width="14" height="14" rx="1" />
              </svg>
            </button>

            {/* Play / Pause */}
            <button
              onClick={togglePlay}
              disabled={!ready}
              title={playing ? 'Pause' : 'Play'}
              className="flex items-center justify-center w-9 h-9 rounded-full bg-brand
                         hover:bg-brand-dark disabled:opacity-30 transition-colors flex-shrink-0"
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

            {/* Loading indicator */}
            {!ready && !loadError && (
              <span className="ml-auto text-xs text-ftc-mid flex items-center gap-1.5">
                <span className="w-3 h-3 rounded-full border-2 border-ftc-mid/30 border-t-ftc-mid animate-spin" />
                Loading…
              </span>
            )}
          </div>
        </>
      )}
    </div>
  );
});

export default AudioPlayer;
