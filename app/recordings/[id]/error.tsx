'use client';

import Link from 'next/link';
import { useEffect } from 'react';

export default function RecordingError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error('[recording-page]', error);
    fetch('/api/report-error', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message: error.message || 'Recording page error',
        context: { digest: error.digest, name: error.name },
      }),
    }).catch(() => {});
  }, [error]);

  return (
    <div className="min-h-screen flex flex-col bg-surface">
      <header className="sticky top-0 z-20 border-b border-surface-border bg-surface/80 backdrop-blur-md">
        <div className="max-w-6xl mx-auto px-4 py-3 flex items-center gap-3">
          <Link
            href="/"
            className="flex items-center gap-1.5 text-sm font-medium text-ftc-mid hover:text-ftc-gray transition-colors p-2 -ml-2 rounded-xl touch-manipulation"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" d="M15 19l-7-7 7-7" />
            </svg>
            Back
          </Link>
        </div>
      </header>

      <main className="max-w-6xl mx-auto w-full px-4 py-6 flex-1 flex items-center justify-center">
        <div className="text-center space-y-5 max-w-sm">
          <div className="w-12 h-12 rounded-full bg-red-500/10 border border-red-500/20 flex items-center justify-center mx-auto">
            <svg className="w-5 h-5 text-red-400" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
              <circle cx="12" cy="12" r="10" />
              <line x1="12" y1="8" x2="12" y2="12" />
              <line x1="12" y1="16" x2="12.01" y2="16" />
            </svg>
          </div>

          <div>
            <h2 className="text-base font-semibold text-ftc-gray">Something went wrong</h2>
            <p className="text-sm text-ftc-mid mt-1">
              This recording could not be loaded. Try again or go back to your recordings.
            </p>
            {error.digest && (
              <p className="text-xs text-surface-muted mt-2 font-mono">Ref: {error.digest}</p>
            )}
          </div>

          <div className="flex items-center justify-center gap-3 flex-wrap">
            <button
              onClick={reset}
              className="text-sm px-4 py-2 rounded-xl bg-brand text-white font-medium hover:bg-brand-dark transition-colors"
            >
              Try again
            </button>
            <Link
              href="/"
              className="text-sm px-4 py-2 rounded-xl border border-surface-border text-ftc-mid hover:text-ftc-gray hover:border-surface-muted transition-colors"
            >
              Back to recordings
            </Link>
          </div>
        </div>
      </main>
    </div>
  );
}
