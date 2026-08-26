'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { formatEta } from '@/lib/estimate';

interface StatusPayload {
  status: string;
  hasTranscript: boolean;
  stage?: string;
  stageLabel?: string;
  progress?: number;
  chunksDone?: number;
  chunksTotal?: number;
  etaS?: number;
}

/**
 * Polls the recording's status and renders the progress bar for it.
 *
 * Two rules make the bar honest, and both exist because a bar that lies is
 * worse than a spinner:
 *
 *  - It never goes backwards. Server progress can dip when a phase reports its
 *    own start after chunk sub-progress had already run ahead.
 *  - The remaining time only ever counts down. It ticks locally between polls
 *    so it feels alive, and a fresh server estimate that is LONGER than what is
 *    on screen is adopted gradually rather than jumping up.
 */
export default function ProcessingPoller({ id }: { id: string }) {
  const router = useRouter();
  const triggerRef = useRef(false);
  const lastRef = useRef<string>('');
  const [state, setState] = useState<{ label: string; progress: number; etaS: number } | null>(null);
  const shownRef = useRef<{ progress: number; etaS: number }>({ progress: 0, etaS: 0 });

  const apply = useCallback((data: StatusPayload) => {
    const target = typeof data.progress === 'number' ? data.progress : 0;
    const progress = Math.max(shownRef.current.progress, target);

    const fresh = typeof data.etaS === 'number' ? data.etaS : 0;
    const prev = shownRef.current.etaS;
    // Adopt a shorter estimate immediately; ease into a longer one so the
    // number the user is watching never jumps upwards.
    const etaS = prev === 0 || fresh <= prev ? fresh : Math.round(prev + (fresh - prev) * 0.25);

    shownRef.current = { progress, etaS };
    setState({ label: data.stageLabel ?? 'Processing', progress, etaS });
  }, []);

  useEffect(() => {
    // Trigger finalize immediately on mount (recovers stuck recordings)
    if (!triggerRef.current) {
      triggerRef.current = true;
      fetch(`/api/recordings/${id}/finalize`, { method: 'POST', keepalive: true }).catch(() => {});
    }

    // Poll a tiny status endpoint every 3s. Only when the status or transcript
    // presence actually CHANGES do we do a full router.refresh() to pull the
    // heavy payload (transcript + summary). Previously this refreshed the whole
    // RSC tree every 3s regardless, re-downloading the entire transcript.
    const poll = async () => {
      try {
        const res = await fetch(`/api/recordings/${id}/status`, { cache: 'no-store' });
        if (!res.ok) return;
        const data = await res.json() as StatusPayload;
        apply(data);
        const sig = `${data.status}|${data.hasTranscript}`;
        if (lastRef.current && lastRef.current !== sig) {
          router.refresh();
        }
        lastRef.current = sig;
        // Once complete/failed, no more work will land — stop refreshing loop.
        if (data.status === 'completed' || data.status === 'failed') {
          clearInterval(refreshInterval);
          clearInterval(finalizeInterval);
          clearInterval(tickInterval);
        }
      } catch { /* ignore transient blips */ }
    };

    const refreshInterval = setInterval(poll, 3_000);
    void poll();

    // Count the estimate down between polls so it reads as a live clock rather
    // than a value that freezes for three seconds at a time.
    const tickInterval = setInterval(() => {
      setState((s) => {
        if (!s || s.etaS <= 5) return s;
        shownRef.current = { ...shownRef.current, etaS: s.etaS - 1 };
        return { ...s, etaS: s.etaS - 1 };
      });
    }, 1_000);

    // Re-trigger finalize every 30s. Finalize is lock-protected and idempotent.
    const finalizeInterval = setInterval(() => {
      fetch(`/api/recordings/${id}/finalize`, { method: 'POST', keepalive: true }).catch(() => {});
    }, 30_000);

    return () => {
      clearInterval(refreshInterval);
      clearInterval(finalizeInterval);
      clearInterval(tickInterval);
    };
  }, [id, router, apply]);

  if (!state) return null;

  const pct = Math.round(state.progress * 100);
  const eta = formatEta(state.etaS);

  return (
    <div className="rounded-2xl border border-amber-500/20 bg-amber-500/5 p-4 mb-4">
      <div className="flex items-center justify-between gap-3 text-sm text-amber-300">
        <span className="flex items-center gap-2 min-w-0">
          <span className="w-3.5 h-3.5 rounded-full border-2 border-amber-400/30 border-t-amber-400 animate-spin flex-shrink-0" />
          <span className="truncate">{state.label}</span>
        </span>
        <span className="flex-shrink-0 tabular-nums text-amber-400/70">
          {pct}%{eta ? ` · ${eta} left` : ''}
        </span>
      </div>
      <div
        className="mt-3 h-1.5 rounded-full bg-amber-500/15 overflow-hidden"
        role="progressbar"
        aria-valuenow={pct}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label={state.label}
      >
        <div
          className="h-full rounded-full bg-amber-400 transition-[width] duration-700 ease-out"
          style={{ width: `${Math.max(2, pct)}%` }}
        />
      </div>
    </div>
  );
}
