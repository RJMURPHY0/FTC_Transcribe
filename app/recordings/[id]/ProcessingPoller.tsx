'use client';

import { useEffect, useRef } from 'react';
import { useRouter } from 'next/navigation';

export default function ProcessingPoller({ id }: { id: string }) {
  const router = useRouter();
  const triggerRef = useRef(false);
  const lastRef = useRef<string>('');

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
        const data = await res.json() as { status: string; hasTranscript: boolean };
        const sig = `${data.status}|${data.hasTranscript}`;
        if (lastRef.current && lastRef.current !== sig) {
          router.refresh();
        }
        lastRef.current = sig;
        // Once complete/failed, no more work will land — stop refreshing loop.
        if (data.status === 'completed' || data.status === 'failed') {
          clearInterval(refreshInterval);
          clearInterval(finalizeInterval);
        }
      } catch { /* ignore transient blips */ }
    };

    const refreshInterval = setInterval(poll, 3_000);

    // Re-trigger finalize every 30s. Finalize is lock-protected and idempotent.
    const finalizeInterval = setInterval(() => {
      fetch(`/api/recordings/${id}/finalize`, { method: 'POST', keepalive: true }).catch(() => {});
    }, 30_000);

    return () => {
      clearInterval(refreshInterval);
      clearInterval(finalizeInterval);
    };
  }, [id, router]);

  return null;
}
