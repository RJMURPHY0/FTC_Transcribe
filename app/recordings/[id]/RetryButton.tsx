'use client';

import { useState, useEffect, useRef } from 'react';
import { useRouter } from 'next/navigation';

export default function RetryButton({ id }: { id: string }) {
  const [retrying, setRetrying] = useState(false);
  const [error,    setError]    = useState('');
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const router  = useRouter();

  // Stop polling on unmount
  useEffect(() => {
    return () => { if (pollRef.current) clearInterval(pollRef.current); };
  }, []);

  const startPolling = () => {
    // Poll every 5 s for up to 5 minutes
    let attempts = 0;
    const MAX_ATTEMPTS = 60;

    pollRef.current = setInterval(async () => {
      attempts++;
      try {
        const res  = await fetch(`/api/recordings/${id}`);
        const data = await res.json() as { status?: string };
        if (data.status === 'completed' || data.status === 'failed') {
          if (pollRef.current) clearInterval(pollRef.current);
          setRetrying(false);
          router.refresh();
        }
      } catch {
        // Network hiccup — keep polling
      }
      if (attempts >= MAX_ATTEMPTS) {
        if (pollRef.current) clearInterval(pollRef.current);
        setRetrying(false);
        setError('Timed out waiting for result — refresh the page to check.');
      }
    }, 5000);
  };

  const retry = async () => {
    setRetrying(true);
    setError('');
    try {
      const res = await fetch(`/api/recordings/${id}/finalize`, { method: 'POST' });
      if (res.ok) {
        // Finalize was kicked off — poll for completion
        startPolling();
      } else {
        const data = await res.json().catch(() => ({})) as { error?: string };
        setError(data.error ?? 'Retry failed — please try again.');
        setRetrying(false);
      }
    } catch {
      setError('Network error — please try again.');
      setRetrying(false);
    }
  };

  return (
    <div className="flex flex-col items-start gap-1.5">
      <button
        type="button"
        onClick={retry}
        disabled={retrying}
        className="flex items-center gap-2 text-sm px-4 py-2 rounded-xl bg-brand text-white
                   font-medium hover:bg-brand-dark transition-colors disabled:opacity-50 touch-manipulation"
      >
        {retrying ? (
          <>
            <div className="w-3.5 h-3.5 rounded-full border-2 border-white/30 border-t-white animate-spin" />
            Retrying…
          </>
        ) : (
          <>
            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth={2.5} viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round"
                d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
            </svg>
            Retry Analysis
          </>
        )}
      </button>
      {retrying && (
        <p className="text-xs text-ftc-mid">Processing… this page will update automatically.</p>
      )}
      {error && <p className="text-xs text-red-400">{error}</p>}
    </div>
  );
}
