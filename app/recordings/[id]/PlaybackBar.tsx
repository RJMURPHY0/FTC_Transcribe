'use client';

import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import AudioPlayer, { type AudioPlayerHandle } from './AudioPlayer';

export interface PlaybackMeta {
  createdAt: string;    // ISO
  durationSecs: number; // 0 = unknown
  words: number;
  language: string;     // '' = unknown (pre-language recordings)
  peaks: number[];      // pseudo-waveform; empty = let WaveSurfer decode
}

export interface PlaybackBarHandle {
  /** Expand the bar and jump to a time. */
  openAndSeek: (seconds: number) => void;
}

interface Props {
  recordingId: string;
  meta: PlaybackMeta;
  onTimeUpdate?: (seconds: number) => void;
}

function formatClock(secs: number): string {
  if (!secs) return '—';
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  const s = Math.floor(secs % 60);
  return h > 0
    ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
    : `${m}:${String(s).padStart(2, '0')}`;
}

function formatCreated(iso: string): string {
  return new Intl.DateTimeFormat('en-GB', {
    day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit',
  }).format(new Date(iso));
}

function MetaCell({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col min-w-0">
      <span className="text-[10px] font-semibold uppercase tracking-wider text-surface-muted">{label}</span>
      <span className="text-xs text-ftc-gray truncate">{value}</span>
    </div>
  );
}

// Fixed bottom playback bar for the full meeting recording. The audio element
// mounts (metadata only) as soon as the page renders, so expanding the bar
// plays instantly instead of waiting on a download.
const PlaybackBar = forwardRef<PlaybackBarHandle, Props>(function PlaybackBar(
  { recordingId, meta, onTimeUpdate },
  ref,
) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const playerRef = useRef<AudioPlayerHandle>(null);
  const barRef = useRef<HTMLDivElement>(null);

  // Publish the bar's live height so fixed bottom-right UI (the global chat
  // bubble) can sit above it instead of covering the player controls.
  useEffect(() => {
    const bar = barRef.current;
    if (!bar) return;
    const root = document.documentElement;
    const publish = () => root.style.setProperty('--playback-bar-h', `${bar.offsetHeight}px`);
    publish();
    const ro = new ResizeObserver(publish);
    ro.observe(bar);
    return () => {
      ro.disconnect();
      root.style.removeProperty('--playback-bar-h');
    };
  }, []);

  const openAndPlay = () => {
    setOpen(true);
    playerRef.current?.play();
  };

  useImperativeHandle(ref, () => ({
    openAndSeek(seconds: number) {
      playerRef.current?.seekTo(seconds);
      if (!open) {
        setOpen(true);
        playerRef.current?.play();
      }
    },
  }));

  const handleDelete = async () => {
    if (deleting) return;
    setDeleting(true);
    try {
      await fetch(`/api/recordings/${recordingId}`, { method: 'DELETE' });
      router.push('/');
      router.refresh();
    } catch {
      setDeleting(false);
      setConfirmDelete(false);
    }
  };

  const language = meta.language
    ? meta.language.charAt(0).toUpperCase() + meta.language.slice(1).toLowerCase()
    : '';

  return (
    <div ref={barRef} className="fixed bottom-0 inset-x-0 z-30 border-t border-surface-border bg-surface/95 backdrop-blur-md">
      <div className="max-w-[1800px] mx-auto px-4 py-2.5">
        {/* Player stays mounted while collapsed so opening it is instant */}
        <div className={open ? 'flex items-start gap-3' : 'hidden'}>
          <div className="flex-1 min-w-0">
            <AudioPlayer
              ref={playerRef}
              recordingId={recordingId}
              onTimeUpdate={onTimeUpdate}
              bare
              durationHint={meta.durationSecs}
              peaks={meta.peaks}
            />

            {/* Actions + metadata — mirrors the Whisper app's clip panel */}
            <div className="mt-2 pt-2 border-t border-surface-border flex flex-wrap items-center gap-x-5 gap-y-2">
              <div className="flex items-center gap-2">
                <a
                  href={`/api/recordings/${recordingId}/audio?download=1`}
                  className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-medium text-ftc-gray bg-surface-raised hover:bg-surface-border transition-colors touch-manipulation"
                >
                  <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M3 16.5v2.25A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75V16.5M16.5 12L12 16.5m0 0L7.5 12m4.5 4.5V3" />
                  </svg>
                  Download
                </a>

                {confirmDelete ? (
                  <span className="flex items-center gap-1.5">
                    <span className="text-xs text-ftc-mid">Are you sure?</span>
                    <button
                      type="button"
                      onClick={handleDelete}
                      disabled={deleting}
                      className="px-2.5 py-1.5 rounded-lg text-xs font-semibold text-white bg-red-500 hover:bg-red-600 disabled:opacity-50 transition-colors touch-manipulation"
                    >
                      {deleting ? 'Deleting…' : 'Delete'}
                    </button>
                    <button
                      type="button"
                      onClick={() => setConfirmDelete(false)}
                      disabled={deleting}
                      className="px-2.5 py-1.5 rounded-lg text-xs font-medium text-ftc-mid hover:text-ftc-gray hover:bg-surface-raised transition-colors touch-manipulation"
                    >
                      Cancel
                    </button>
                  </span>
                ) : (
                  <button
                    type="button"
                    onClick={() => setConfirmDelete(true)}
                    className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-medium text-red-400 bg-red-500/10 hover:bg-red-500/20 transition-colors touch-manipulation"
                  >
                    <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" d="M14.74 9l-.346 9m-4.788 0L9.26 9m9.968-3.21c.342.052.682.107 1.022.166m-1.022-.165L18.16 19.673a2.25 2.25 0 01-2.244 2.077H8.084a2.25 2.25 0 01-2.244-2.077L4.772 5.79m14.456 0a48.108 48.108 0 00-3.478-.397m-12 .562c.34-.059.68-.114 1.022-.165m0 0a48.11 48.11 0 013.478-.397m7.5 0v-.916c0-1.18-.91-2.164-2.09-2.201a51.964 51.964 0 00-3.32 0c-1.18.037-2.09 1.022-2.09 2.201v.916m7.5 0a48.667 48.667 0 00-7.5 0" />
                    </svg>
                    Delete
                  </button>
                )}
              </div>

              <div className="flex items-center gap-5 ml-auto">
                <MetaCell label="Created" value={formatCreated(meta.createdAt)} />
                <MetaCell label="Duration" value={formatClock(meta.durationSecs)} />
                {meta.words > 0 && (
                  <MetaCell label="Words" value={meta.words.toLocaleString('en-GB')} />
                )}
                {language && <MetaCell label="Language" value={language} />}
              </div>
            </div>
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

        {!open && (
          <button
            type="button"
            onClick={openAndPlay}
            className="w-full flex items-center gap-3 text-sm text-ftc-gray touch-manipulation group"
          >
            <span className="flex items-center justify-center w-9 h-9 rounded-full bg-brand group-hover:bg-brand-dark transition-colors flex-shrink-0">
              <svg className="w-4 h-4 text-white" fill="currentColor" viewBox="0 0 24 24">
                <path d="M8 5v14l11-7z" />
              </svg>
            </span>
            <span className="font-medium">Play meeting recording</span>
            {meta.durationSecs > 0 && (
              <span className="tabular-nums text-xs text-ftc-mid">{formatClock(meta.durationSecs)}</span>
            )}
            <span className="text-xs text-ftc-mid hidden sm:inline">— click any part of the transcript to jump there</span>
          </button>
        )}
      </div>
    </div>
  );
});

export default PlaybackBar;
