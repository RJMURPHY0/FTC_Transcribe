'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

const DEFAULT: [number, number, number] = [1.5, 2, 1.6];
const MIN_FR = 0.25;

interface Props {
  userId: string | null;
  chat: React.ReactNode;
  notes: React.ReactNode;
  transcript: React.ReactNode;
}

// Resizable three-column shell. Column ratios persist to localStorage keyed by
// user id, so each signed-in user keeps their own layout on this device. On
// screens below the desktop breakpoint the grid stacks and handles hide (CSS).
export default function ResizableColumns({ userId, chat, notes, transcript }: Props) {
  const storageKey = `ftc.detailCols.${userId ?? 'anon'}`;
  const gridRef = useRef<HTMLDivElement>(null);
  const [cols, setCols] = useState<[number, number, number]>(DEFAULT);

  // Load saved ratios after mount (keeps SSR markup === first client render)
  useEffect(() => {
    try {
      const raw = localStorage.getItem(storageKey);
      if (!raw) return;
      const parsed = JSON.parse(raw) as unknown;
      if (
        Array.isArray(parsed) && parsed.length === 3 &&
        parsed.every(n => typeof n === 'number' && isFinite(n) && n >= MIN_FR)
      ) {
        setCols(parsed as [number, number, number]);
      }
    } catch { /* ignore malformed */ }
  }, [storageKey]);

  const drag = useRef<{ handle: 0 | 1; startX: number; start: [number, number, number]; contentWidth: number } | null>(null);

  const onMove = useCallback((e: PointerEvent) => {
    const d = drag.current;
    if (!d) return;
    const totalFr = d.start[0] + d.start[1] + d.start[2];
    const frPerPx = totalFr / d.contentWidth;
    let deltaFr = (e.clientX - d.startX) * frPerPx;

    const [a, b, c] = d.start;
    const next: [number, number, number] = [a, b, c];
    if (d.handle === 0) {
      // Clamp so neither the chat nor notes column drops below the minimum
      deltaFr = Math.max(-(a - MIN_FR), Math.min(b - MIN_FR, deltaFr));
      next[0] = a + deltaFr;
      next[1] = b - deltaFr;
    } else {
      deltaFr = Math.max(-(b - MIN_FR), Math.min(c - MIN_FR, deltaFr));
      next[1] = b + deltaFr;
      next[2] = c - deltaFr;
    }
    setCols(next);
  }, []);

  const onUp = useCallback(() => {
    const d = drag.current;
    drag.current = null;
    document.querySelectorAll('.detail-resize-handle.dragging').forEach(el => el.classList.remove('dragging'));
    document.body.style.removeProperty('user-select');
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', onUp);
    if (d) {
      setCols(prev => {
        try { localStorage.setItem(storageKey, JSON.stringify(prev)); } catch { /* quota */ }
        return prev;
      });
    }
  }, [onMove, storageKey]);

  const startDrag = (handle: 0 | 1) => (e: React.PointerEvent<HTMLDivElement>) => {
    if (!gridRef.current) return;
    // fr tracks share the container width minus the two 0.5rem handle tracks
    const handlePx = (e.currentTarget.offsetWidth || 8) * 2;
    drag.current = {
      handle,
      startX: e.clientX,
      start: cols,
      contentWidth: Math.max(1, gridRef.current.offsetWidth - handlePx),
    };
    e.currentTarget.classList.add('dragging');
    document.body.style.userSelect = 'none';
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  };

  const reset = () => {
    setCols(DEFAULT);
    try { localStorage.removeItem(storageKey); } catch { /* ignore */ }
  };

  useEffect(() => () => {
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', onUp);
  }, [onMove, onUp]);

  const template = `${cols[0]}fr 1rem ${cols[1]}fr 1rem ${cols[2]}fr`;

  return (
    <div
      ref={gridRef}
      className="detail-grid"
      style={{ ['--detail-cols' as string]: template }}
    >
      {chat}
      <div
        className="detail-resize-handle"
        onPointerDown={startDrag(0)}
        onDoubleClick={reset}
        title="Drag to resize · double-click to reset"
        role="separator"
        aria-orientation="vertical"
      />
      {notes}
      <div
        className="detail-resize-handle"
        onPointerDown={startDrag(1)}
        onDoubleClick={reset}
        title="Drag to resize · double-click to reset"
        role="separator"
        aria-orientation="vertical"
      />
      {transcript}
    </div>
  );
}
