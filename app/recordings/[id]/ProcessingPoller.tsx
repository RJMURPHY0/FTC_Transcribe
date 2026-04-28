'use client';

import { useEffect, useRef } from 'react';
import { useRouter } from 'next/navigation';

export default function ProcessingPoller({ id }: { id: string }) {
  const router = useRouter();
  const triggerRef = useRef(false);

  useEffect(() => {
    // Trigger finalize immediately on mount (recovers stuck recordings)
    if (!triggerRef.current) {
      triggerRef.current = true;
      fetch(`/api/recordings/${id}/finalize`, { method: 'POST', keepalive: true }).catch(() => {});
    }

    // Refresh page data every 10s so status updates are visible
    const refreshInterval = setInterval(() => {
      router.refresh();
    }, 10_000);

    // Re-trigger finalize every 50s — each invocation processes 6 more chunks
    const finalizeInterval = setInterval(() => {
      fetch(`/api/recordings/${id}/finalize`, { method: 'POST', keepalive: true }).catch(() => {});
    }, 50_000);

    return () => {
      clearInterval(refreshInterval);
      clearInterval(finalizeInterval);
    };
  }, [id, router]);

  return null;
}
