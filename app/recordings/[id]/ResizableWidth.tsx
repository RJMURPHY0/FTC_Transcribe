'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

const MIN_WIDTH = 340;

interface Props {
  userId?: string | null;
  storageId: string;      // distinguishes panels, e.g. 'transcript'
  className?: string;      // applied to the outer wrapper (grid child)
  children: React.ReactNode;
}

// Wraps a panel so its width can be dragged in from the right edge, letting the
// user narrow it for easier reading. The chosen width persists per user on this
// device. The handle sits in the right gutter (outside the panel), so it never
// overlaps the panel's own scrollbar. Below the desktop breakpoint the grid
// stacks and the handle hides (CSS), leaving the panel full-width.
export default function ResizableWidth({ userId, storageId, className, children }: Props) {
  const key = `ftc.width.${storageId}.${userId ?? 'anon'}`;
  const wrapRef = useRef<HTMLDivElement>(null);
  const drag = useRef<{ startX: number; startW: number } | null>(null);
  const [width, setWidth] = useState<number | null>(null); // null → fill the column

  useEffect(() => {
    try {
      const raw = localStorage.getItem(key);
      if (!raw) return;
      const w = Number(raw);
      if (isFinite(w) && w >= MIN_WIDTH) setWidth(w);
    } catch { /* ignore */ }
  }, [key]);

  const onMove = useCallback((e: PointerEvent) => {
    const d = drag.current;
    if (!d) return;
    const colW = wrapRef.current?.parentElement?.clientWidth ?? Infinity;
    const next = Math.max(MIN_WIDTH, Math.min(colW, d.startW + (e.clientX - d.startX)));
    setWidth(next);
  }, []);

  const onUp = useCallback(() => {
    drag.current = null;
    document.body.style.removeProperty('user-select');
    document.body.style.removeProperty('cursor');
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', onUp);
    setWidth((w) => {
      try { if (w != null) localStorage.setItem(key, String(Math.round(w))); } catch { /* quota */ }
      return w;
    });
  }, [onMove, key]);

  const start = (e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    drag.current = { startX: e.clientX, startW: wrapRef.current?.offsetWidth ?? MIN_WIDTH };
    document.body.style.userSelect = 'none';
    document.body.style.cursor = 'ew-resize';
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  };

  const reset = () => {
    setWidth(null);
    try { localStorage.removeItem(key); } catch { /* ignore */ }
  };

  useEffect(() => () => {
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', onUp);
  }, [onMove, onUp]);

  return (
    <div
      ref={wrapRef}
      className={`panel-width-wrap ${className ?? ''}`}
      style={width != null ? { width, maxWidth: '100%' } : undefined}
    >
      {children}
      <div
        onPointerDown={start}
        onDoubleClick={reset}
        title="Drag to resize · double-click to reset"
        role="separator"
        aria-orientation="vertical"
        className="panel-width-handle"
      >
        <span className="panel-width-grip" />
      </div>
    </div>
  );
}
