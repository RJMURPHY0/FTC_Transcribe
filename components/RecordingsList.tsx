'use client';

import { useState, useRef, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import AssignFolderButton from './AssignFolderButton';
import QuickDeleteButton from './QuickDeleteButton';

interface RecordingSummary {
  overview: string | null;
  keyPoints: string | null;
  actionItems: string | null;
}

interface Recording {
  id: string;
  title: string;
  createdAt: string;
  status: string;
  source: string;
  folderId: string | null;
  summary: RecordingSummary | null;
  _count: { chunks: number };
  eta: string | null;
  duration: number;
}

function formatDuration(seconds: number): string {
  if (!seconds) return '';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s > 0 ? `${s}s` : ''}`.trim();
  return `${s}s`;
}

interface Folder { id: string; name: string }

interface UndoState {
  mergedId: string;
  originalIds: string[];
  countdown: number; // seconds remaining
}

const UNDO_SECONDS = 6;

const COUNTDOWN_WIDTH: Record<number, string> = {
  6: 'w-full',
  5: 'w-5/6',
  4: 'w-4/6',
  3: 'w-3/6',
  2: 'w-2/6',
  1: 'w-1/6',
  0: 'w-0',
};

function MicIcon({ className }: { className?: string }) {
  return (
    <svg className={className} fill="currentColor" viewBox="0 0 24 24">
      <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z" />
      <path d="M19 10v2a7 7 0 0 1-14 0v-2H3v2a9 9 0 0 0 8 8.94V22H9v2h6v-2h-2v-1.06A9 9 0 0 0 21 12v-2h-2z" />
    </svg>
  );
}

function safeJson<T>(value: string | null | undefined, fallback: T): T {
  if (!value) return fallback;
  try { return JSON.parse(value) as T; } catch { return fallback; }
}

function formatDate(isoString: string) {
  return new Intl.DateTimeFormat('en-GB', {
    day: 'numeric', month: 'short', year: 'numeric',
    hour: '2-digit', minute: '2-digit',
  }).format(new Date(isoString));
}

// ── Bulk folder picker ───────────────────────────────────────────────────────

function BulkFolderPicker({
  folders,
  onAssign,
}: {
  folders: Folder[];
  onAssign: (folderId: string | null) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex items-center gap-1.5 px-3 py-2 rounded-xl text-sm font-medium text-ftc-gray bg-surface-raised hover:bg-surface-border transition-colors touch-manipulation"
      >
        <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" d="M2.25 12.75V12A2.25 2.25 0 014.5 9.75h15A2.25 2.25 0 0121.75 12v.75m-8.69-6.44l-2.12-2.12a1.5 1.5 0 00-1.061-.44H4.5A2.25 2.25 0 002.25 6v8.25" />
        </svg>
        Add to folder
        <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
        </svg>
      </button>

      {open && (
        <div className="absolute bottom-full mb-2 left-0 z-50 w-52 rounded-xl border border-surface-border bg-surface-card shadow-xl overflow-hidden">
          {folders.length === 0 ? (
            <p className="px-3 py-2.5 text-xs text-ftc-mid">No folders yet</p>
          ) : (
            <>
              {folders.map((f) => (
                <button
                  key={f.id}
                  type="button"
                  onClick={() => { onAssign(f.id); setOpen(false); }}
                  className="w-full text-left px-3 py-2.5 text-xs text-ftc-gray hover:bg-surface-raised transition-colors flex items-center gap-2"
                >
                  <svg className="w-3.5 h-3.5 text-brand flex-shrink-0" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M2.25 12.75V12A2.25 2.25 0 014.5 9.75h15A2.25 2.25 0 0121.75 12v.75m-8.69-6.44l-2.12-2.12a1.5 1.5 0 00-1.061-.44H4.5A2.25 2.25 0 002.25 6v8.25" />
                  </svg>
                  {f.name}
                </button>
              ))}
              <div className="border-t border-surface-border">
                <button
                  type="button"
                  onClick={() => { onAssign(null); setOpen(false); }}
                  className="w-full text-left px-3 py-2.5 text-xs text-ftc-mid hover:bg-surface-raised transition-colors"
                >
                  Remove from folder
                </button>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}

// ── Merge split-button ───────────────────────────────────────────────────────

function MergeButton({
  disabled,
  busy,
  onMergeKeep,
  onMergeDelete,
}: {
  disabled: boolean;
  busy: boolean;
  onMergeKeep: () => void;
  onMergeDelete: () => void;
}) {
  const [dropOpen, setDropOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!dropOpen) return;
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setDropOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [dropOpen]);

  return (
    <div ref={ref} className="relative flex">
      {/* Main action */}
      <button
        type="button"
        onClick={onMergeKeep}
        disabled={disabled || busy}
        title={disabled ? 'Select at least 2 to merge' : 'Merge into one recording (keep originals)'}
        className="flex items-center gap-1.5 pl-3 pr-2 py-2 rounded-l-xl text-sm font-medium bg-brand text-white hover:bg-brand/90 disabled:opacity-40 disabled:cursor-not-allowed transition-colors touch-manipulation"
      >
        {busy ? (
          <div className="w-4 h-4 rounded-full border-2 border-white border-t-transparent animate-spin" />
        ) : (
          <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" d="M13.5 16.875h3.375m0 0h3.375m-3.375 0V13.5m0 3.375v3.375M6 10.5h2.25a2.25 2.25 0 002.25-2.25V6a2.25 2.25 0 00-2.25-2.25H6A2.25 2.25 0 003.75 6v2.25A2.25 2.25 0 006 10.5zm0 9.75h2.25A2.25 2.25 0 0010.5 18v-2.25a2.25 2.25 0 00-2.25-2.25H6a2.25 2.25 0 00-2.25 2.25V18A2.25 2.25 0 006 20.25zm9.75-9.75H18a2.25 2.25 0 002.25-2.25V6A2.25 2.25 0 0018 3.75h-2.25A2.25 2.25 0 0013.5 6v2.25a2.25 2.25 0 002.25 2.25z" />
          </svg>
        )}
        Merge
      </button>

      {/* Chevron dropdown trigger */}
      <button
        type="button"
        onClick={() => setDropOpen((o) => !o)}
        disabled={disabled || busy}
        className="flex items-center px-1.5 py-2 rounded-r-xl text-sm bg-brand/80 text-white hover:bg-brand/70 border-l border-white/20 disabled:opacity-40 disabled:cursor-not-allowed transition-colors touch-manipulation"
        aria-label="More merge options"
      >
        <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth={2.5} viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
        </svg>
      </button>

      {/* Dropdown */}
      {dropOpen && (
        <div className="absolute bottom-full mb-2 left-0 z-50 w-52 rounded-xl border border-surface-border bg-surface-card shadow-xl overflow-hidden">
          <button
            type="button"
            onClick={() => { setDropOpen(false); onMergeKeep(); }}
            className="w-full text-left px-3 py-2.5 text-xs text-ftc-gray hover:bg-surface-raised transition-colors flex items-center gap-2"
          >
            <svg className="w-3.5 h-3.5 text-brand flex-shrink-0" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" d="M13.5 16.875h3.375m0 0h3.375m-3.375 0V13.5m0 3.375v3.375M6 10.5h2.25a2.25 2.25 0 002.25-2.25V6a2.25 2.25 0 00-2.25-2.25H6A2.25 2.25 0 003.75 6v2.25A2.25 2.25 0 006 10.5zm0 9.75h2.25A2.25 2.25 0 0010.5 18v-2.25a2.25 2.25 0 00-2.25-2.25H6a2.25 2.25 0 00-2.25 2.25V18A2.25 2.25 0 006 20.25zm9.75-9.75H18a2.25 2.25 0 002.25-2.25V6A2.25 2.25 0 0018 3.75h-2.25A2.25 2.25 0 0013.5 6v2.25a2.25 2.25 0 002.25 2.25z" />
            </svg>
            <div>
              <p className="font-medium">Merge &amp; Keep originals</p>
              <p className="text-surface-muted mt-0.5">Creates a new combined meeting</p>
            </div>
          </button>
          <div className="border-t border-surface-border">
            <button
              type="button"
              onClick={() => { setDropOpen(false); onMergeDelete(); }}
              className="w-full text-left px-3 py-2.5 text-xs text-ftc-gray hover:bg-surface-raised transition-colors flex items-center gap-2"
            >
              <svg className="w-3.5 h-3.5 text-red-400 flex-shrink-0" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" d="M14.74 9l-.346 9m-4.788 0L9.26 9m9.968-3.21c.342.052.682.107 1.022.166m-1.022-.165L18.16 19.673a2.25 2.25 0 01-2.244 2.077H8.084a2.25 2.25 0 01-2.244-2.077L4.772 5.79m14.456 0a48.108 48.108 0 00-3.478-.397m-12 .562c.34-.059.68-.114 1.022-.165m0 0a48.11 48.11 0 013.478-.397m7.5 0v-.916c0-1.18-.91-2.164-2.09-2.201a51.964 51.964 0 00-3.32 0c-1.18.037-2.09 1.022-2.09 2.201v.916m7.5 0a48.667 48.667 0 00-7.5 0" />
              </svg>
              <div>
                <p className="font-medium">Merge &amp; Delete originals</p>
                <p className="text-surface-muted mt-0.5">Replaces them with merged meeting</p>
              </div>
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Main component ────────────────────────────────────────────────────────────

export default function RecordingsList({
  recordings,
  folders,
}: {
  recordings: Recording[];
  folders: Folder[];
}) {
  const router = useRouter();
  const [selected, setSelected] = useState<string[]>([]);
  const [hiddenIds, setHiddenIds] = useState<string[]>([]);
  const [merging, setMerging] = useState(false);
  const [bulkFolderBusy, setBulkFolderBusy] = useState(false);
  const [undoState, setUndoState] = useState<UndoState | null>(null);
  const undoTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const isSelecting = selected.length > 0;

  // Countdown tick for undo toast
  useEffect(() => {
    if (!undoState) return;
    undoTimerRef.current = setInterval(() => {
      setUndoState((prev) => {
        if (!prev) return null;
        if (prev.countdown <= 1) return null; // triggers deletion via the null-transition below
        return { ...prev, countdown: prev.countdown - 1 };
      });
    }, 1000);
    return () => {
      if (undoTimerRef.current) clearInterval(undoTimerRef.current);
    };
  }, [undoState?.mergedId]); // restart only when a new merge happens

  // When undo state hits null (timer expired), fire deletions and navigate
  const prevUndoRef = useRef<UndoState | null>(null);
  useEffect(() => {
    const prev = prevUndoRef.current;
    prevUndoRef.current = undoState;
    if (prev && !undoState) {
      // Timer expired — delete originals then navigate
      const { mergedId, originalIds } = prev;
      Promise.all(
        originalIds.map((id) => fetch(`/api/recordings/${id}`, { method: 'DELETE' })),
      ).finally(() => {
        router.push(`/recordings/${mergedId}`);
      });
    }
  }, [undoState, router]);

  const toggle = (id: string, e: React.MouseEvent | React.ChangeEvent) => {
    e.preventDefault();
    (e as React.MouseEvent).stopPropagation?.();
    setSelected((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id],
    );
  };

  const clearSelection = () => setSelected([]);

  // ── Shared merge call ──────────────────────────────────────────────────────
  const callMergeApi = async (): Promise<string | null> => {
    const res = await fetch('/api/recordings/merge', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ recordingIds: selected }),
    });
    if (!res.ok) {
      const { error } = await res.json().catch(() => ({ error: 'Merge failed.' }));
      alert(error ?? 'Merge failed.');
      return null;
    }
    const { id } = await res.json();
    return id;
  };

  // ── Merge & Keep ───────────────────────────────────────────────────────────
  const handleMergeKeep = async () => {
    if (selected.length < 2 || merging) return;
    setMerging(true);
    try {
      const id = await callMergeApi();
      if (!id) return;
      clearSelection();
      router.push(`/recordings/${id}`);
    } catch {
      alert('Network error — merge failed.');
    } finally {
      setMerging(false);
    }
  };

  // ── Merge & Delete (with undo) ─────────────────────────────────────────────
  const handleMergeDelete = async () => {
    if (selected.length < 2 || merging) return;
    setMerging(true);
    try {
      const id = await callMergeApi();
      if (!id) return;
      const originalIds = [...selected];
      clearSelection();
      // Start undo countdown — actual deletion fires when countdown hits 0
      setUndoState({ mergedId: id, originalIds, countdown: UNDO_SECONDS });
    } catch {
      alert('Network error — merge failed.');
    } finally {
      setMerging(false);
    }
  };

  // ── Undo merge+delete ──────────────────────────────────────────────────────
  const handleUndo = async () => {
    if (!undoState) return;
    if (undoTimerRef.current) clearInterval(undoTimerRef.current);
    const { mergedId } = undoState;
    // Clear undo state BEFORE the null-transition effect fires deletion
    prevUndoRef.current = null;
    setUndoState(null);
    // Hard-delete the just-created merged recording to restore the original state
    await fetch(`/api/recordings/${mergedId}?hard=1`, { method: 'DELETE' });
    router.refresh();
  };

  // ── Download ───────────────────────────────────────────────────────────────
  const handleDownload = () => {
    const completedIds = selected.filter((id) => {
      const rec = recordings.find((r) => r.id === id);
      return rec?.status === 'completed' && rec.summary;
    });
    if (completedIds.length === 0) {
      alert('No completed recordings selected — Word export requires a finished summary.');
      return;
    }
    for (const id of completedIds) {
      const a = document.createElement('a');
      a.href = `/api/recordings/${id}/export/word`;
      a.download = '';
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
    }
  };

  // ── Bulk add to folder ─────────────────────────────────────────────────────
  const handleBulkFolder = async (folderId: string | null) => {
    if (bulkFolderBusy) return;
    setBulkFolderBusy(true);
    try {
      await Promise.all(
        selected.map((id) =>
          fetch(`/api/recordings/${id}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ folderId }),
          }),
        ),
      );
      clearSelection();
      router.refresh();
    } finally {
      setBulkFolderBusy(false);
    }
  };

  const visible = recordings.filter((r) => !hiddenIds.includes(r.id));

  if (visible.length === 0) {
    return null;
  }

  return (
    <>
      <ul className="space-y-3">
        {visible.map((rec) => {
          const actions = safeJson<string[]>(rec.summary?.actionItems, []);
          const points  = safeJson<string[]>(rec.summary?.keyPoints,   []);
          const selIdx  = selected.indexOf(rec.id);
          const selNum  = selIdx + 1;
          const isSelected = selIdx !== -1;

          return (
            <li key={rec.id} className="relative group">
              {/* Checkbox / selection badge */}
              <button
                type="button"
                aria-label={isSelected ? `Deselect (position ${selNum})` : 'Select'}
                onClick={(e) => toggle(rec.id, e)}
                className={`
                  absolute top-1/2 left-3 -translate-y-1/2 z-10
                  w-6 h-6 rounded-full flex items-center justify-center
                  transition-all duration-150 touch-manipulation
                  ${isSelecting
                    ? 'opacity-100'
                    : 'opacity-0 group-hover:opacity-100 focus:opacity-100'}
                  ${isSelected
                    ? 'bg-brand text-white shadow-sm'
                    : 'border-2 border-surface-muted bg-surface-card hover:border-brand'}
                `}
              >
                {isSelected ? (
                  <span className="text-[11px] font-bold leading-none">{selNum}</span>
                ) : (
                  <svg className="w-3 h-3 text-surface-muted" fill="none" stroke="currentColor" strokeWidth={2.5} viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M4.5 12.75l6 6 9-13.5" />
                  </svg>
                )}
              </button>

              <Link
                href={`/recordings/${rec.id}`}
                onClick={isSelecting ? (e) => { e.preventDefault(); toggle(rec.id, e); } : undefined}
                className={`
                  flex flex-col gap-3 rounded-2xl border bg-surface-card p-5 pr-20 transition-all duration-150
                  active:scale-[0.99] touch-manipulation
                  ${isSelecting ? 'pl-12 cursor-pointer' : 'pl-5 group-hover:pl-12'}
                  ${isSelected
                    ? 'border-brand/50 bg-brand/5'
                    : 'border-surface-border hover:border-surface-muted'}
                `}
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="flex items-center gap-3 min-w-0">
                    <div className={`w-9 h-9 rounded-xl flex-shrink-0 flex items-center justify-center ${rec.source === 'teams' ? 'bg-[#4b53bc]/15' : 'bg-surface-raised'}`}>
                      {rec.source === 'teams' ? (
                        <svg className="w-5 h-5 text-[#6264A7]" fill="currentColor" viewBox="0 0 24 24">
                          <path d="M12.5 2C11.1 2 10 3.1 10 4.5S11.1 7 12.5 7 15 5.9 15 4.5 13.9 2 12.5 2zm5 3c-.8 0-1.5.7-1.5 1.5S16.7 8 17.5 8 19 7.3 19 6.5 18.3 5 17.5 5zM3 9v10h2v-4h1.5c.3 1.2 1.3 2 2.5 2s2.2-.8 2.5-2H13v4h2V9H3zm8 4H5v-2h6v2z"/>
                        </svg>
                      ) : (
                        <MicIcon className="w-5 h-5 text-brand" />
                      )}
                    </div>
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <p className="font-semibold text-sm text-ftc-gray truncate">{rec.title}</p>
                        {rec.source === 'teams' && (
                          <span className="flex-shrink-0 text-[10px] font-semibold px-1.5 py-0.5 rounded-md bg-[#4b53bc]/15 text-[#6264A7]">Teams</span>
                        )}
                      </div>
                      <p className="text-xs mt-0.5 text-ftc-mid flex items-center gap-1.5">
                        {formatDate(rec.createdAt)}
                        {rec.duration > 0 && (
                          <>
                            <span className="text-surface-muted">·</span>
                            <span>{formatDuration(rec.duration)}</span>
                          </>
                        )}
                      </p>
                    </div>
                  </div>
                  <div className="flex flex-col items-end gap-1 flex-shrink-0">
                    <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${
                      rec.status === 'completed' ? 'bg-emerald-500/10 text-emerald-400'
                      : rec.status === 'failed'  ? 'bg-red-500/10 text-red-400'
                      : 'bg-blue-500/10 text-blue-400'
                    }`}>
                      {rec.status === 'processing' ? 'analysing'
                        : (rec.status === 'uploading' || rec.status === 'queued') ? 'queued'
                        : rec.status}
                    </span>
                    {rec.eta && <span className="text-[10px] text-ftc-mid">{rec.eta}</span>}
                  </div>
                </div>

                {rec.summary?.overview && (
                  <p className="text-sm leading-relaxed line-clamp-2 text-ftc-mid">
                    {rec.summary.overview}
                  </p>
                )}

                {(actions.length > 0 || points.length > 0) && (
                  <div className="flex items-center gap-4 text-xs text-surface-muted">
                    {actions.length > 0 && (
                      <span className="flex items-center gap-1">
                        <svg className="w-3.5 h-3.5 text-emerald-500" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
                        </svg>
                        {actions.length} action{actions.length !== 1 ? 's' : ''}
                      </span>
                    )}
                    {points.length > 0 && (
                      <span className="flex items-center gap-1">
                        <svg className="w-3.5 h-3.5 text-brand" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" d="M13 10V3L4 14h7v7l9-11h-7z" />
                        </svg>
                        {points.length} key point{points.length !== 1 ? 's' : ''}
                      </span>
                    )}
                  </div>
                )}
              </Link>

              {!isSelecting && (
                <div className="absolute top-1/2 right-3 -translate-y-1/2 flex flex-col gap-1 items-center">
                  <AssignFolderButton
                    recordingId={rec.id}
                    currentFolderId={rec.folderId}
                    folders={folders}
                  />
                  <QuickDeleteButton id={rec.id} onDeleted={() => setHiddenIds((prev) => [...prev, rec.id])} />
                </div>
              )}
            </li>
          );
        })}
      </ul>

      {/* ── Undo toast (Merge & Delete) ── */}
      {undoState && (
        <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-50 flex items-center gap-3 px-4 py-3 rounded-2xl border border-surface-border bg-surface-card shadow-2xl shadow-black/40 backdrop-blur-md min-w-[320px]">
          <div className="flex-1 min-w-0">
            <p className="text-sm font-medium text-ftc-gray">
              Merged {undoState.originalIds.length} recordings
            </p>
            <div className="flex items-center gap-2 mt-1.5">
              {/* Progress bar */}
              <div className="flex-1 h-1 rounded-full bg-surface-raised overflow-hidden">
                <div
                  className={`h-full bg-brand rounded-full transition-all duration-1000 ease-linear ${COUNTDOWN_WIDTH[undoState.countdown] ?? 'w-0'}`}
                />
              </div>
              <span className="text-xs text-ftc-mid flex-shrink-0">
                Deleting originals in {undoState.countdown}s
              </span>
            </div>
          </div>
          <button
            type="button"
            onClick={handleUndo}
            className="flex-shrink-0 px-3 py-1.5 rounded-lg text-sm font-semibold text-brand border border-brand/30 hover:bg-brand/10 transition-colors touch-manipulation"
          >
            Undo
          </button>
        </div>
      )}

      {/* ── Bottom selection action bar ── */}
      {isSelecting && !undoState && (
        <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-50 flex items-center gap-2 px-4 py-3 rounded-2xl border border-surface-border bg-surface-card shadow-2xl shadow-black/40 backdrop-blur-md">
          {/* Selection count + order pills */}
          <div className="flex items-center gap-1.5 pr-3 border-r border-surface-border">
            <div className="flex items-center gap-0.5">
              {selected.map((id, i) => (
                <span
                  key={id}
                  className="w-5 h-5 rounded-full bg-brand text-white text-[10px] font-bold flex items-center justify-center"
                >
                  {i + 1}
                </span>
              ))}
            </div>
            <span className="text-xs text-ftc-mid ml-1">
              {selected.length} selected
            </span>
          </div>

          <MergeButton
            disabled={selected.length < 2}
            busy={merging}
            onMergeKeep={handleMergeKeep}
            onMergeDelete={handleMergeDelete}
          />

          <button
            type="button"
            onClick={handleDownload}
            className="flex items-center gap-1.5 px-3 py-2 rounded-xl text-sm font-medium text-ftc-gray bg-surface-raised hover:bg-surface-border transition-colors touch-manipulation"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" d="M3 16.5v2.25A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75V16.5M16.5 12L12 16.5m0 0L7.5 12m4.5 4.5V3" />
            </svg>
            Download
          </button>

          <BulkFolderPicker folders={folders} onAssign={handleBulkFolder} />

          <button
            type="button"
            onClick={clearSelection}
            aria-label="Clear selection"
            className="ml-1 p-2 rounded-xl text-ftc-mid hover:text-ftc-gray hover:bg-surface-raised transition-colors touch-manipulation"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={2.5} viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>
      )}
    </>
  );
}
