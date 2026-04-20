'use client';

import { useState, useRef, useEffect } from 'react';
import { useRouter } from 'next/navigation';

interface Folder { id: string; name: string }

export default function AssignFolderButton({
  recordingId,
  currentFolderId,
  folders,
}: {
  recordingId: string;
  currentFolderId: string | null;
  folders: Folder[];
}) {
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const router = useRouter();

  // Close on outside click
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  const assign = async (e: React.MouseEvent, folderId: string | null) => {
    e.preventDefault();
    e.stopPropagation();
    setSaving(true);
    setOpen(false);
    try {
      await fetch(`/api/recordings/${recordingId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ folderId }),
      });
      router.refresh();
    } finally {
      setSaving(false);
    }
  };

  const toggle = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setOpen((o) => !o);
  };

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={toggle}
        disabled={saving}
        title={currentFolderId ? 'Move to folder' : 'Add to folder'}
        className={`p-1.5 rounded-lg transition-colors touch-manipulation ${
          currentFolderId
            ? 'text-brand hover:bg-brand/10'
            : 'text-surface-muted hover:text-ftc-mid hover:bg-surface-raised'
        } disabled:opacity-40`}
      >
        {saving ? (
          <div className="w-4 h-4 rounded-full border-2 border-current border-t-transparent animate-spin" />
        ) : (
          <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" d="M2.25 12.75V12A2.25 2.25 0 014.5 9.75h15A2.25 2.25 0 0121.75 12v.75m-8.69-6.44l-2.12-2.12a1.5 1.5 0 00-1.061-.44H4.5A2.25 2.25 0 002.25 6v8.25" />
          </svg>
        )}
      </button>

      {open && (
        <div className="absolute right-0 top-full mt-1 z-50 w-44 rounded-xl border border-surface-border bg-surface-card shadow-xl overflow-hidden">
          {currentFolderId && (
            <button
              type="button"
              onClick={(e) => assign(e, null)}
              className="w-full text-left px-3 py-2 text-xs text-ftc-mid hover:bg-surface-raised transition-colors"
            >
              Remove from folder
            </button>
          )}
          {folders.length === 0 && (
            <p className="px-3 py-2 text-xs text-ftc-mid">No folders yet — create one above</p>
          )}
          {folders.map((f) => (
            <button
              key={f.id}
              type="button"
              onClick={(e) => assign(e, f.id)}
              className={`w-full text-left px-3 py-2 text-xs transition-colors flex items-center gap-2 ${
                f.id === currentFolderId
                  ? 'text-brand bg-brand/5'
                  : 'text-ftc-gray hover:bg-surface-raised'
              }`}
            >
              <svg className="w-3 h-3 flex-shrink-0" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" d="M2.25 12.75V12A2.25 2.25 0 014.5 9.75h15A2.25 2.25 0 0121.75 12v.75m-8.69-6.44l-2.12-2.12a1.5 1.5 0 00-1.061-.44H4.5A2.25 2.25 0 002.25 6v8.25" />
              </svg>
              {f.name}
              {f.id === currentFolderId && (
                <svg className="w-3 h-3 ml-auto text-brand" fill="currentColor" viewBox="0 0 20 20">
                  <path fillRule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clipRule="evenodd" />
                </svg>
              )}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
