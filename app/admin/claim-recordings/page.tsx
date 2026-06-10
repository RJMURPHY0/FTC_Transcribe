'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';

export default function ClaimRecordingsPage() {
  const router = useRouter();
  const [status, setStatus] = useState<'idle' | 'loading' | 'done' | 'error'>('idle');
  const [result, setResult] = useState<{ recordingsClaimed: number; foldersClaimed: number } | null>(null);
  const [errorMsg, setErrorMsg] = useState('');

  async function handleClaim() {
    setStatus('loading');
    try {
      const res = await fetch('/api/admin/claim-recordings', { method: 'POST' });
      const data = await res.json();
      if (!res.ok) { setErrorMsg(data.error ?? 'Failed'); setStatus('error'); return; }
      setResult(data);
      setStatus('done');
    } catch (e) {
      setErrorMsg(String(e));
      setStatus('error');
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-surface px-4">
      <div className="w-full max-w-sm rounded-2xl border border-surface-border bg-surface-card p-8 space-y-5">
        <div>
          <h1 className="text-lg font-semibold text-ftc-gray">Claim all recordings</h1>
          <p className="text-sm text-ftc-mid mt-1">
            Assigns every existing recording and folder to your account so only you can see them.
          </p>
        </div>

        {status === 'idle' && (
          <button
            onClick={handleClaim}
            className="w-full btn-brand py-2.5 rounded-xl text-sm font-semibold text-white"
          >
            Claim all recordings
          </button>
        )}

        {status === 'loading' && (
          <p className="text-sm text-ftc-mid text-center">Claiming…</p>
        )}

        {status === 'done' && result && (
          <div className="space-y-3">
            <div className="rounded-xl bg-green-500/10 border border-green-500/20 px-4 py-3 text-sm text-green-400">
              Done — {result.recordingsClaimed} recording{result.recordingsClaimed !== 1 ? 's' : ''} and {result.foldersClaimed} folder{result.foldersClaimed !== 1 ? 's' : ''} are now yours.
            </div>
            <button
              onClick={() => router.push('/')}
              className="w-full btn-brand py-2.5 rounded-xl text-sm font-semibold text-white"
            >
              Go to recordings
            </button>
          </div>
        )}

        {status === 'error' && (
          <p className="text-sm text-red-400 bg-red-400/10 rounded-xl px-4 py-2.5">{errorMsg}</p>
        )}
      </div>
    </div>
  );
}
