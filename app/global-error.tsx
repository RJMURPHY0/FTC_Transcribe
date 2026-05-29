'use client';

import { useEffect } from 'react';

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error('[global-error]', error);
    fetch('/api/report-error', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message: error.message || 'Unhandled global error',
        context: { digest: error.digest, name: error.name },
      }),
    }).catch(() => {});
  }, [error]);

  return (
    <html lang="en">
      <body style={{ background: '#030712', color: '#9ca3af', fontFamily: 'sans-serif', display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: '100vh', margin: 0 }}>
        <div style={{ textAlign: 'center', padding: '2rem' }}>
          <p style={{ fontSize: '1rem', fontWeight: 600, color: '#e5e7eb', marginBottom: '0.5rem' }}>
            Something went wrong
          </p>
          <p style={{ fontSize: '0.875rem', marginBottom: '1.5rem' }}>
            An unexpected error occurred.
            {error.digest ? ` (Ref: ${error.digest})` : ''}
          </p>
          <div style={{ display: 'flex', gap: '0.75rem', justifyContent: 'center', flexWrap: 'wrap' }}>
            <button
              onClick={reset}
              style={{ padding: '0.5rem 1rem', borderRadius: '0.75rem', background: '#f39200', color: '#fff', border: 'none', cursor: 'pointer', fontSize: '0.875rem', fontWeight: 500 }}
            >
              Try again
            </button>
            <a
              href="/"
              style={{ padding: '0.5rem 1rem', borderRadius: '0.75rem', border: '1px solid #374151', color: '#9ca3af', textDecoration: 'none', fontSize: '0.875rem' }}
            >
              Back to home
            </a>
          </div>
        </div>
      </body>
    </html>
  );
}
