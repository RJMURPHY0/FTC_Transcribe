'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';

export default function DeleteButton({ id }: { id: string }) {
  const [confirming, setConfirming] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const router = useRouter();

  const handleDelete = async () => {
    setDeleting(true);
    try {
      const res = await fetch(`/api/recordings/${id}`, { method: 'DELETE' });
      if (res.ok) { router.push('/'); router.refresh(); }
    } catch {
      setDeleting(false);
      setConfirming(false);
    }
  };

  if (confirming) {
    return (
      <div className="flex items-center gap-2 flex-shrink-0">
        <span className="text-xs text-ftc-mid hidden sm:block">Delete?</span>
        <button
          type="button"
          onClick={() => setConfirming(false)}
          className="text-xs px-2.5 py-1 rounded-lg text-ftc-mid bg-surface-raised hover:bg-surface-border transition-colors touch-manipulation"
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={handleDelete}
          disabled={deleting}
          className="text-xs px-2.5 py-1 rounded-lg text-white bg-red-600 hover:bg-red-500 disabled:opacity-50 transition-colors touch-manipulation"
        >
          {deleting ? '…' : 'Delete'}
        </button>
      </div>
    );
  }

  return (
    <button
      type="button"
      onClick={() => setConfirming(true)}
      className="flex-shrink-0 p-2 rounded-xl text-surface-muted hover:text-red-400 hover:bg-red-500/10 transition-colors touch-manipulation"
      aria-label="Delete recording"
      title="Delete recording"
    >
      <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" d="M14.74 9l-.346 9m-4.788 0L9.26 9m9.968-3.21c.342.052.682.107 1.022.166m-1.022-.165L18.16 19.673a2.25 2.25 0 01-2.244 2.077H8.084a2.25 2.25 0 01-2.244-2.077L4.772 5.79m14.456 0a48.108 48.108 0 00-3.478-.397m-12 .562c.34-.059.68-.114 1.022-.165m0 0a48.11 48.11 0 013.478-.397m7.5 0v-.916c0-1.18-.91-2.164-2.09-2.201a51.964 51.964 0 00-3.32 0c-1.18.037-2.09 1.022-2.09 2.201v.916m7.5 0a48.667 48.667 0 00-7.5 0" />
      </svg>
    </button>
  );
}
