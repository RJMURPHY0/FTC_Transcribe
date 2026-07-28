'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from '@/components/ui/dropdown-menu';

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
  const [saving, setSaving] = useState(false);
  const router = useRouter();

  const assign = async (folderId: string | null) => {
    setSaving(true);
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

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
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
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-44">
        {currentFolderId && (
          <>
            <DropdownMenuItem onSelect={() => assign(null)} className="text-xs text-ftc-mid">
              Remove from folder
            </DropdownMenuItem>
            <DropdownMenuSeparator />
          </>
        )}
        {folders.length === 0 && (
          <p className="px-2 py-1.5 text-xs text-ftc-mid">No folders yet — create one above</p>
        )}
        {folders.map((f) => (
          <DropdownMenuItem
            key={f.id}
            onSelect={() => assign(f.id)}
            className={`text-xs gap-2 ${f.id === currentFolderId ? 'text-brand' : ''}`}
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
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
