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

    // Refresh page data every 3s so the transcript appears as soon as it's saved
    const refreshInterval = setInterval(() => {
      router.refresh();
    }, 3_000);

    // Re-trigger finalize every 8s — picks up the final chunk as soon as background
    // transcription finishes (typically 5–15s after recording stops)
    const finalizeInterval = setInterval(() => {
      fetch(`/api/recordings/${id}/finalize`, { method: 'POST', keepalive: true }).catch(() => {});
    }, 8_000);

    return () => {
      clearInterval(refreshInterval);
      clearInterval(finalizeInterval);
    };
  }, [id, router]);

  return null;
}
