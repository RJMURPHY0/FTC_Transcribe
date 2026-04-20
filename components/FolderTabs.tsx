'use client';

import { useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';

interface Folder {
  id: string;
  name: string;
  _count: { recordings: number };
}

export default function FolderTabs({ folders }: { folders: Folder[] }) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const active = searchParams.get('folder') ?? 'all';

  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState('');
  const [saving, setSaving] = useState(false);

  const navigate = (folderId: string | null) => {
    const params = new URLSearchParams(searchParams.toString());
    if (folderId) params.set('folder', folderId);
    else params.delete('folder');
    router.push(`/?${params.toString()}`);
  };

  const createFolder = async () => {
    const name = newName.trim();
    if (!name) return;
    setSaving(true);
    try {
      const res = await fetch('/api/folders', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name }),
      });
      if (res.ok) {
        setNewName('');
        setCreating(false);
        router.refresh();
      }
    } finally {
      setSaving(false);
    }
  };

  const deleteFolder = async (e: React.MouseEvent, id: string) => {
    e.stopPropagation();
    if (!confirm('Delete this folder? Recordings inside will be moved to All.')) return;
    await fetch(`/api/folders/${id}`, { method: 'DELETE' });
    if (active === id) navigate(null);
    else router.refresh();
  };

  return (
    <div className="mb-6">
      <div className="flex items-center gap-1.5 flex-wrap">
        {/* All tab */}
        <button
          type="button"
          onClick={() => navigate(null)}
          className={`flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs font-medium transition-colors touch-manipulation ${
            active === 'all'
              ? 'bg-brand text-white'
              : 'bg-surface-raised text-ftc-mid hover:text-ftc-gray hover:bg-surface-border'
          }`}
        >
          All
        </button>

        {/* Folder tabs */}
        {folders.map((f) => (
          <button
            key={f.id}
            type="button"
            onClick={() => navigate(f.id)}
            className={`group flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs font-medium transition-colors touch-manipulation ${
              active === f.id
                ? 'bg-brand text-white'
                : 'bg-surface-raised text-ftc-mid hover:text-ftc-gray hover:bg-surface-border'
            }`}
          >
            <svg className="w-3 h-3 flex-shrink-0" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" d="M2.25 12.75V12A2.25 2.25 0 014.5 9.75h15A2.25 2.25 0 0121.75 12v.75m-8.69-6.44l-2.12-2.12a1.5 1.5 0 00-1.061-.44H4.5A2.25 2.25 0 002.25 6v8.25" />
            </svg>
            {f.name}
            <span className="opacity-60">({f._count.recordings})</span>
            {/* Delete folder */}
            <span
              role="button"
              onClick={(e) => deleteFolder(e, f.id)}
              className={`ml-0.5 opacity-0 group-hover:opacity-60 hover:!opacity-100 transition-opacity touch-manipulation ${active === f.id ? 'text-white' : 'text-ftc-mid'}`}
              title="Delete folder"
            >
              <svg className="w-3 h-3" fill="none" stroke="currentColor" strokeWidth={2.5} viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
              </svg>
            </span>
          </button>
        ))}

        {/* New folder */}
        {creating ? (
          <div className="flex items-center gap-1.5">
            <input
              autoFocus
              type="text"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void createFolder();
                if (e.key === 'Escape') { setCreating(false); setNewName(''); }
              }}
              placeholder="Folder name…"
              className="bg-surface-raised border border-brand rounded-xl px-3 py-1.5 text-xs text-ftc-gray outline-none w-36"
            />
            <button
              type="button"
              onClick={createFolder}
              disabled={saving || !newName.trim()}
              className="text-xs px-2.5 py-1.5 rounded-xl bg-brand text-white disabled:opacity-50 touch-manipulation"
            >
              {saving ? '…' : 'Save'}
            </button>
            <button
              type="button"
              onClick={() => { setCreating(false); setNewName(''); }}
              className="text-xs text-ftc-mid hover:text-ftc-gray touch-manipulation"
            >
              Cancel
            </button>
          </div>
        ) : (
          <button
            type="button"
            onClick={() => setCreating(true)}
            className="flex items-center gap-1 px-3 py-1.5 rounded-xl text-xs font-medium text-ftc-mid hover:text-ftc-gray hover:bg-surface-border transition-colors touch-manipulation border border-dashed border-surface-border"
          >
            <svg className="w-3 h-3" fill="none" stroke="currentColor" strokeWidth={2.5} viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 4.5v15m7.5-7.5h-15" />
            </svg>
            New folder
          </button>
        )}
      </div>
    </div>
  );
}
