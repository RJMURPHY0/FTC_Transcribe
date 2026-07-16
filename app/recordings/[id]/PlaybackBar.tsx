'use client';

import { forwardRef, useImperativeHandle, useRef, useState } from 'react';
import AudioPlayer, { type AudioPlayerHandle } from './AudioPlayer';

export interface PlaybackBarHandle {
  /** Expand the bar (mounting the waveform if needed) and jump to a time. */
  openAndSeek: (seconds: number) => void;
}

interface Props {
  recordingId: string;
  onTimeUpdate?: (seconds: number) => void;
}

// Fixed bottom playback bar for the full meeting recording. Collapsed it's a
// slim strip with a play button; expanding mounts the waveform player (the
// audio itself only downloads on first open, so pages stay fast).
const PlaybackBar = forwardRef<PlaybackBarHandle, Props>(function PlaybackBar(
  { recordingId, onTimeUpdate },
  ref,
) {
  const [open, setOpen] = useState(false);
  const playerRef = useRef<AudioPlayerHandle>(null);
  const pendingSeekRef = useRef<number | null>(null);

  useImperativeHandle(ref, () => ({
    openAndSeek(seconds: number) {
      if (open) {
        playerRef.current?.seekTo(seconds);
      } else {
        pendingSeekRef.current = seconds; // AudioPlayer applies it once ready
        setOpen(true);
      }
    },
  }));

  return (
    <div className="fixed bottom-0 inset-x-0 z-30 border-t border-surface-border bg-surface/95 backdrop-blur-md">
      <div className="max-w-[1800px] mx-auto px-4 py-2.5">
        {open ? (
          <div className="flex items-start gap-3">
            <div className="flex-1 min-w-0">
              <AudioPlayer
                ref={playerRef}
                recordingId={recordingId}
                onTimeUpdate={onTimeUpdate}
                bare
                autoPlay
                initialSeek={pendingSeekRef.current}
              />
            </div>
            <button
              type="button"
              onClick={() => setOpen(false)}
              title="Hide player"
              aria-label="Hide player"
              className="p-1.5 mt-1 rounded-lg text-ftc-mid hover:text-ftc-gray transition-colors flex-shrink-0"
            >
              <svg className="w-4 h-4" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
                <path d="M3 6l5 5 5-5" />
              </svg>
            </button>
          </div>
        ) : (
          <button
            type="button"
            onClick={() => setOpen(true)}
            className="w-full flex items-center gap-3 text-sm text-ftc-gray touch-manipulation group"
          >
            <span className="flex items-center justify-center w-9 h-9 rounded-full bg-brand group-hover:bg-brand-dark transition-colors flex-shrink-0">
              <svg className="w-4 h-4 text-white" fill="currentColor" viewBox="0 0 24 24">
                <path d="M8 5v14l11-7z" />
              </svg>
            </span>
            <span className="font-medium">Play meeting recording</span>
            <span className="text-xs text-ftc-mid hidden sm:inline">— click any part of the transcript to jump there</span>
          </button>
        )}
      </div>
    </div>
  );
});

export default PlaybackBar;
