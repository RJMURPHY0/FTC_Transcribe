'use client';

import { useEffect, useState } from 'react';
import { createClient } from '@/lib/supabase/client';

export default function ClaimPage() {
  const [status, setStatus] = useState<'idle' | 'running' | 'done' | 'error'>('idle');
  const [message, setMessage] = useState('');
  const [userId, setUserId] = useState('');

  useEffect(() => {
    (async () => {
      setStatus('running');
      const supabase = createClient();
      const { data: { session } } = await supabase.auth.getSession();
      if (!session?.user) {
        setStatus('error');
        setMessage('Not logged in — go back and sign in first.');
        return;
      }
      setUserId(session.user.id);

      const res = await fetch('/api/admin/claim-recordings', {
        method: 'POST',
        headers: { Authorization: `Bearer ${session.access_token}` },
      }).catch(() => null);

      if (!res) { setStatus('error'); setMessage('Network error — try again.'); return; }

      const data = await res.json().catch(() => null);
      if (!res.ok) {
        setStatus('error');
        setMessage(`Server error ${res.status}: ${JSON.stringify(data)}`);
        return;
      }

      setStatus('done');
      setMessage(`Claimed ${data.recordingsClaimed} recordings and ${data.foldersClaimed} folders.`);
    })();
  }, []);

  return (
    <div className="min-h-screen flex items-center justify-center bg-surface px-4">
      <div className="w-full max-w-md rounded-2xl border border-surface-border bg-surface-card p-8 space-y-5 text-center">
        <h1 className="text-xl font-bold text-ftc-gray">Claim Recordings</h1>

        {status === 'running' && <p className="text-ftc-mid">Running…</p>}

        {status === 'done' && (
          <div className="space-y-3">
            <p className="text-green-400 font-semibold text-lg">✓ {message}</p>
            <p className="text-xs text-ftc-mid break-all">Your user ID: <span className="text-ftc-gray font-mono">{userId}</span></p>
            <a href="/" className="block w-full btn-brand py-2.5 rounded-xl text-sm font-semibold text-white">
              Go to recordings
            </a>
          </div>
        )}

        {status === 'error' && (
          <div className="space-y-3">
            <p className="text-red-400 font-semibold">✗ {message}</p>
            <p className="text-xs text-ftc-mid break-all">User ID: <span className="text-ftc-gray font-mono">{userId || 'unknown'}</span></p>
          </div>
        )}
      </div>
    </div>
  );
}
