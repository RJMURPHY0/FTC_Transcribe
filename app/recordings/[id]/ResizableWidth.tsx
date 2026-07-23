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
  const drag = useRef<{ startX: number; startW: number; maxW: number } | null>(null);
  const [width, setWidth] = useState<number | null>(null); // null → fill the column

  // The wrap IS the grid child, so its own grid track — not the whole grid —
  // is the true width ceiling. Read the track from the grid's computed
  // template; the wrap's inline width can be narrower than the track.
  const trackWidth = useCallback((): number => {
    const wrap = wrapRef.current;
    const grid = wrap?.parentElement;
    if (!wrap || !grid) return Infinity;
    const tracks = getComputedStyle(grid).gridTemplateColumns.split(' ').map(parseFloat);
    const idx = Array.prototype.indexOf.call(grid.children, wrap);
    const track = tracks[idx];
    return isFinite(track) && track > 0 ? track : wrap.clientWidth;
  }, []);

  useEffect(() => {
    try {
      const raw = localStorage.getItem(key);
      if (!raw) return;
      const w = Number(raw);
      if (isFinite(w) && w >= MIN_WIDTH) setWidth(w);
    } catch { /* ignore */ }
  }, [key]);

  // A saved width from a wider window must not overflow the current track
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const onWindowResize = () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        setWidth((w) => {
          if (w == null) return w;
          const max = trackWidth();
          return isFinite(max) && w > max ? Math.max(MIN_WIDTH, max) : w;
        });
      }, 150);
    };
    window.addEventListener('resize', onWindowResize);
    return () => { clearTimeout(timer); window.removeEventListener('resize', onWindowResize); };
  }, [trackWidth]);

  const onMove = useCallback((e: PointerEvent) => {
    const d = drag.current;
    if (!d) return;
    const next = Math.max(MIN_WIDTH, Math.min(d.maxW, d.startW + (e.clientX - d.startX)));
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
    drag.current = { startX: e.clientX, startW: wrapRef.current?.offsetWidth ?? MIN_WIDTH, maxW: trackWidth() };
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
