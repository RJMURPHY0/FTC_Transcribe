'use client';

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { formatDue, dueStatus } from '@/lib/action-items';

// ─── Date helpers (local calendar, stored as ISO YYYY-MM-DD) ──────────────────

const pad = (n: number) => String(n).padStart(2, '0');
const toISO = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const fromISO = (iso: string) => {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(y, m - 1, d);
};
const addDays = (d: Date, n: number) => {
  const x = new Date(d);
  x.setDate(x.getDate() + n);
  return x;
};
const startOfMonth = (d: Date) => new Date(d.getFullYear(), d.getMonth(), 1);
const sameDay = (a: Date, b: Date) =>
  a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();

const WEEKDAYS = ['Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa', 'Su'];
const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

// Monday-based weekday index (0 = Monday … 6 = Sunday)
const monIndex = (d: Date) => (d.getDay() === 0 ? 6 : d.getDay() - 1);

// ─── Calendar popover ─────────────────────────────────────────────────────────

function CalendarPopover({
  anchor, iso, onPick, onClose,
}: {
  anchor:  HTMLElement;
  iso:     string | null;
  onPick:  (next: string | null) => void;
  onClose: () => void;
}) {
  const popRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);

  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const selected = iso ? fromISO(iso) : null;

  const [view, setView] = useState<Date>(() => startOfMonth(selected ?? today));

  // Quick presets — the "today / this week / next week / next month" chips
  const isoWk = today.getDay() === 0 ? 7 : today.getDay(); // Mon=1 … Sun=7
  const presets: { label: string; date: Date }[] = [
    { label: 'Today',      date: today },
    { label: 'Tomorrow',   date: addDays(today, 1) },
    { label: 'This week',  date: addDays(today, ((5 - isoWk) + 7) % 7) }, // upcoming Friday
    { label: 'Next week',  date: addDays(today, 8 - isoWk) },            // next Monday
    { label: 'Next month', date: new Date(today.getFullYear(), today.getMonth() + 1, today.getDate()) },
  ];

  // Position the popover relative to the trigger, flipping above when there is
  // no room below. Fixed positioning escapes the notes column's overflow clip.
  useLayoutEffect(() => {
    const pop = popRef.current;
    if (!pop) return;
    const r = anchor.getBoundingClientRect();
    const h = pop.offsetHeight;
    const w = pop.offsetWidth;
    const gap = 6;
    let top = r.bottom + gap;
    if (top + h > window.innerHeight - 8) top = Math.max(8, r.top - h - gap);
    let left = r.left;
    if (left + w > window.innerWidth - 8) left = Math.max(8, window.innerWidth - w - 8);
    setPos({ top, left });
  }, [anchor, view]);

  // Dismiss on outside click, Escape, scroll or resize
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (popRef.current && !popRef.current.contains(e.target as Node) && !anchor.contains(e.target as Node)) {
        onClose();
      }
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    window.addEventListener('scroll', onClose, true);
    window.addEventListener('resize', onClose);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('scroll', onClose, true);
      window.removeEventListener('resize', onClose);
    };
  }, [anchor, onClose]);

  // Build the month grid (leading blanks + day cells)
  const first = startOfMonth(view);
  const lead = monIndex(first);
  const daysInMonth = new Date(view.getFullYear(), view.getMonth() + 1, 0).getDate();
  const cells: (Date | null)[] = [];
  for (let i = 0; i < lead; i++) cells.push(null);
  for (let d = 1; d <= daysInMonth; d++) cells.push(new Date(view.getFullYear(), view.getMonth(), d));

  const pick = (d: Date) => { onPick(toISO(d)); onClose(); };

  return createPortal(
    <div
      ref={popRef}
      role="dialog"
      aria-label="Choose a due date"
      style={{ position: 'fixed', top: pos?.top ?? -9999, left: pos?.left ?? -9999, visibility: pos ? 'visible' : 'hidden' }}
      className="z-[80] w-[300px] rounded-2xl border border-surface-border bg-surface-card shadow-xl p-3
                 animate-in fade-in-0 zoom-in-95 duration-150"
    >
      {/* Quick presets */}
      <div className="flex flex-wrap gap-1.5 pb-3 mb-2 border-b border-surface-border">
        {presets.map(p => {
          const active = iso === toISO(p.date);
          return (
            <button
              key={p.label}
              type="button"
              onClick={() => pick(p.date)}
              className={`text-[11px] font-medium px-2.5 py-1 rounded-lg transition-colors ${
                active ? 'bg-brand text-white' : 'text-ftc-mid hover:text-ftc-gray bg-surface-raised'
              }`}
            >
              {p.label}
            </button>
          );
        })}
      </div>

      {/* Month header */}
      <div className="flex items-center justify-between mb-2">
        <button
          type="button"
          onClick={() => setView(new Date(view.getFullYear(), view.getMonth() - 1, 1))}
          aria-label="Previous month"
          className="p-1.5 rounded-lg text-ftc-mid hover:text-ftc-gray hover:bg-surface-raised transition-colors"
        >
          <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" d="M15 19l-7-7 7-7" />
          </svg>
        </button>
        <span className="text-sm font-semibold text-ftc-gray">
          {MONTHS[view.getMonth()]} {view.getFullYear()}
        </span>
        <button
          type="button"
          onClick={() => setView(new Date(view.getFullYear(), view.getMonth() + 1, 1))}
          aria-label="Next month"
          className="p-1.5 rounded-lg text-ftc-mid hover:text-ftc-gray hover:bg-surface-raised transition-colors"
        >
          <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
          </svg>
        </button>
      </div>

      {/* Weekday labels */}
      <div className="grid grid-cols-7 mb-1">
        {WEEKDAYS.map(w => (
          <span key={w} className="text-center text-[10px] font-medium text-surface-muted py-1">{w}</span>
        ))}
      </div>

      {/* Day grid */}
      <div className="grid grid-cols-7 gap-0.5">
        {cells.map((d, i) => {
          if (!d) return <span key={i} />;
          const isSel = selected != null && sameDay(d, selected);
          const isToday = sameDay(d, today);
          return (
            <button
              key={i}
              type="button"
              onClick={() => pick(d)}
              className={`h-8 w-full rounded-lg text-xs tabular-nums transition-colors
                ${isSel
                  ? 'bg-brand text-white font-semibold'
                  : isToday
                    ? 'text-brand font-semibold hover:bg-surface-raised'
                    : 'text-ftc-gray hover:bg-surface-raised'}`}
            >
              {d.getDate()}
            </button>
          );
        })}
      </div>

      {/* Footer: Clear / Today */}
      <div className="flex items-center justify-between pt-3 mt-2 border-t border-surface-border">
        <button
          type="button"
          onClick={() => { onPick(null); onClose(); }}
          className="text-xs text-ftc-mid hover:text-red-400 transition-colors"
        >
          Clear
        </button>
        <button
          type="button"
          onClick={() => pick(today)}
          className="text-xs font-medium text-brand hover:underline"
        >
          Today
        </button>
      </div>
    </div>,
    document.body,
  );
}

// ─── Inline due-date control (pill trigger + calendar popover) ────────────────

export default function DueDatePicker({
  iso, done, onChange,
}: {
  iso:      string | null;
  done:     boolean;
  onChange: (next: string | null) => void;
}) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);

  const label = formatDue(iso);
  const status = dueStatus(iso);
  const colour =
    done                  ? 'text-ftc-mid' :
    status === 'overdue'  ? 'text-red-400' :
    status === 'today'    ? 'text-amber-400' :
    label                 ? 'text-ftc-gray' :
                            'text-ftc-mid';

  const close = useCallback(() => setOpen(false), []);

  return (
    <div className="flex items-center gap-1.5 mt-1">
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen(o => !o)}
        aria-haspopup="dialog"
        aria-expanded={open}
        className={`relative inline-flex items-center gap-1.5 text-xs ${colour} ${done ? 'line-through' : ''}
                    cursor-pointer hover:text-brand transition-colors`}
      >
        <svg className="w-3 h-3 flex-shrink-0" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" />
        </svg>
        {label ? `Due ${label}` : 'No date set'}
        {status === 'overdue' && !done && <span className="font-medium">· overdue</span>}
      </button>

      {iso && (
        <button
          type="button"
          onClick={() => onChange(null)}
          title="Clear date"
          className="text-surface-muted hover:text-red-400 transition-colors"
        >
          <svg className="w-3 h-3" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>
      )}

      {open && triggerRef.current && (
        <CalendarPopover anchor={triggerRef.current} iso={iso} onPick={onChange} onClose={close} />
      )}
    </div>
  );
}
