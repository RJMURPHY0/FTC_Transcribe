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
  createdAt: string; // serialised as ISO string from server
  status: string;
  folderId: string | null;
  summary: RecordingSummary | null;
  _count: { chunks: number };
  eta: string | null;
}

interface Folder { id: string; name: string }

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

// ── Main component ────────────────────────────────────────────────────────────

export default function RecordingsList({
  recordings,
  folders,
}: {
  recordings: Recording[];
  folders: Folder[];
}) {
  const router = useRouter();
  // Ordered list of selected IDs — index + 1 = selection number badge
  const [selected, setSelected] = useState<string[]>([]);
  const [merging, setMerging] = useState(false);
  const [bulkFolderBusy, setBulkFolderBusy] = useState(false);

  const isSelecting = selected.length > 0;

  const toggle = (id: string, e: React.MouseEvent | React.ChangeEvent) => {
    e.preventDefault();
    (e as React.MouseEvent).stopPropagation?.();
    setSelected((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id],
    );
  };

  const clearSelection = () => setSelected([]);

  // ── Merge ──────────────────────────────────────────────────────────────────
  const handleMerge = async () => {
    if (selected.length < 2 || merging) return;
    setMerging(true);
    try {
      const res = await fetch('/api/recordings/merge', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ recordingIds: selected }),
      });
      if (!res.ok) {
        const { error } = await res.json().catch(() => ({ error: 'Merge failed.' }));
        alert(error ?? 'Merge failed.');
        return;
      }
      const { id } = await res.json();
      clearSelection();
      router.push(`/recordings/${id}`);
    } catch {
      alert('Network error — merge failed.');
    } finally {
      setMerging(false);
    }
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
    // Open each as a separate download; browsers queue them
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

  if (recordings.length === 0) {
    return null; // handled by parent
  }

  return (
    <>
      <ul className="space-y-3">
        {recordings.map((rec) => {
          const actions = safeJson<string[]>(rec.summary?.actionItems, []);
          const points  = safeJson<string[]>(rec.summary?.keyPoints,   []);
          const selIdx  = selected.indexOf(rec.id); // -1 if not selected
          const selNum  = selIdx + 1;               // 0 if not selected
          const isSelected = selIdx !== -1;

          return (
            <li key={rec.id} className="relative group">
              {/* Checkbox / selection badge — top-left */}
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
                  flex flex-col gap-3 rounded-2xl border bg-surface-card p-5 pr-20 transition-colors
                  active:scale-[0.99] touch-manipulation
                  ${isSelecting ? 'pl-12 cursor-pointer' : 'pl-5'}
                  ${isSelected
                    ? 'border-brand/50 bg-brand/5'
                    : 'border-surface-border hover:border-surface-muted'}
                `}
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="flex items-center gap-3 min-w-0">
                    <div className="w-9 h-9 rounded-xl bg-surface-raised flex-shrink-0 flex items-center justify-center">
                      <MicIcon className="w-5 h-5 text-brand" />
                    </div>
                    <div className="min-w-0">
                      <p className="font-semibold text-sm text-ftc-gray truncate">{rec.title}</p>
                      <p className="text-xs mt-0.5 text-ftc-mid">{formatDate(rec.createdAt)}</p>
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

              {/* Per-card actions — hidden during selection mode */}
              {!isSelecting && (
                <div className="absolute top-1/2 right-3 -translate-y-1/2 flex flex-col gap-1 items-center">
                  <AssignFolderButton
                    recordingId={rec.id}
                    currentFolderId={rec.folderId}
                    folders={folders}
                  />
                  <QuickDeleteButton id={rec.id} />
                </div>
              )}
            </li>
          );
        })}
      </ul>

      {/* ── Bottom action bar ── */}
      {isSelecting && (
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

          {/* Merge */}
          <button
            type="button"
            onClick={handleMerge}
            disabled={selected.length < 2 || merging}
            title={selected.length < 2 ? 'Select at least 2 to merge' : 'Merge into one recording'}
            className="flex items-center gap-1.5 px-3 py-2 rounded-xl text-sm font-medium bg-brand text-white hover:bg-brand/90 disabled:opacity-40 disabled:cursor-not-allowed transition-colors touch-manipulation"
          >
            {merging ? (
              <div className="w-4 h-4 rounded-full border-2 border-white border-t-transparent animate-spin" />
            ) : (
              <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" d="M13.5 16.875h3.375m0 0h3.375m-3.375 0V13.5m0 3.375v3.375M6 10.5h2.25a2.25 2.25 0 002.25-2.25V6a2.25 2.25 0 00-2.25-2.25H6A2.25 2.25 0 003.75 6v2.25A2.25 2.25 0 006 10.5zm0 9.75h2.25A2.25 2.25 0 0010.5 18v-2.25a2.25 2.25 0 00-2.25-2.25H6a2.25 2.25 0 00-2.25 2.25V18A2.25 2.25 0 006 20.25zm9.75-9.75H18a2.25 2.25 0 002.25-2.25V6A2.25 2.25 0 0018 3.75h-2.25A2.25 2.25 0 0013.5 6v2.25a2.25 2.25 0 002.25 2.25z" />
              </svg>
            )}
            Merge
          </button>

          {/* Download */}
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

          {/* Add to folder */}
          <BulkFolderPicker
            folders={folders}
            onAssign={handleBulkFolder}
          />

          {/* Dismiss */}
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
