'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';

const SPEAKER_COLOURS = [
  { label: 'text-blue-400',    dot: 'bg-blue-400'    },
  { label: 'text-violet-400',  dot: 'bg-violet-400'  },
  { label: 'text-emerald-400', dot: 'bg-emerald-400' },
  { label: 'text-amber-400',   dot: 'bg-amber-400'   },
  { label: 'text-rose-400',    dot: 'bg-rose-400'    },
];

interface Props {
  recordingId: string;
  speakers: string[];
}

export default function SpeakerPanel({ recordingId, speakers }: Props) {
  const router = useRouter();
  const [names, setNames] = useState<Record<string, string>>(
    () => Object.fromEntries(speakers.map(s => [String(s), String(s)])),
  );
  const [saving, setSaving] = useState(false);
  const [reanalysing, setReanalysing] = useState(false);
  const [saveStatus, setSaveStatus] = useState<'idle' | 'ok' | 'err'>('idle');
  const [reanalStatus, setReanalStatus] = useState<'idle' | 'ok' | 'err' | 'running'>('idle');

  const hasChanges = speakers.some(s => (names[s] ?? s) !== s);

  async function handleSave() {
    const renames: Record<string, string> = {};
    for (const orig of speakers) {
      const next = (names[orig] ?? orig).trim();
      if (next && next !== orig) renames[orig] = next;
    }
    if (!Object.keys(renames).length) return;

    setSaving(true);
    setSaveStatus('idle');
    try {
      const res = await fetch(`/api/recordings/${recordingId}/speakers`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ renames }),
      });
      if (res.ok) {
        setSaveStatus('ok');
        router.refresh();
      } else {
        setSaveStatus('err');
      }
    } catch {
      setSaveStatus('err');
    } finally {
      setSaving(false);
    }
  }

  async function handleReanalyse() {
    setReanalysing(true);
    setReanalStatus('running');
    try {
      const res = await fetch(`/api/recordings/${recordingId}/rediarize`, { method: 'POST' });
      if (res.ok) {
        setReanalStatus('ok');
        router.refresh();
      } else {
        setReanalStatus('err');
      }
    } catch {
      setReanalStatus('err');
    } finally {
      setReanalysing(false);
    }
  }

  return (
    <div className="rounded-2xl border border-surface-border bg-surface-card p-4 space-y-3 mb-4">
      <div className="flex items-center justify-between gap-2">
        <p className="text-xs font-semibold uppercase tracking-widest text-ftc-mid">Speakers</p>
        <button
          onClick={handleReanalyse}
          disabled={reanalysing}
          className="text-xs px-2.5 py-1 rounded-lg border border-surface-border text-ftc-mid hover:text-ftc-gray hover:border-ftc-mid transition-colors disabled:opacity-50 flex-shrink-0"
        >
          {reanalysing
            ? 'Re-analysing…'
            : reanalStatus === 'ok'
            ? 'Done ✓'
            : reanalStatus === 'err'
            ? 'Failed — retry'
            : 'Re-analyse'}
        </button>
      </div>

      {reanalysing && (
        <p className="text-xs text-ftc-mid">
          Re-running speaker analysis — this can take a minute for long meetings…
        </p>
      )}

      <div className="space-y-2">
        {speakers.map((orig, i) => {
          const c = SPEAKER_COLOURS[i % SPEAKER_COLOURS.length];
          return (
            <div key={orig} className="flex items-center gap-2">
              <span className={`w-2 h-2 rounded-full flex-shrink-0 ${c.dot}`} />
              <span className={`text-xs ${c.label} w-20 flex-shrink-0 truncate`} title={orig}>{orig}</span>
              <input
                type="text"
                value={names[orig] ?? orig}
                onChange={e => setNames(n => ({ ...n, [orig]: e.target.value }))}
                className="flex-1 text-xs bg-surface border border-surface-border rounded-lg px-2.5 py-1.5 text-ftc-gray focus:outline-none focus:border-brand/50 min-w-0"
                placeholder="Enter name…"
              />
            </div>
          );
        })}
      </div>

      <div className="flex items-center gap-3 pt-0.5">
        <button
          onClick={handleSave}
          disabled={saving || !hasChanges}
          className="text-xs px-3 py-1.5 rounded-lg bg-brand/10 text-brand hover:bg-brand/20 transition-colors disabled:opacity-40"
        >
          {saving ? 'Saving…' : 'Save names'}
        </button>
        {saveStatus === 'ok' && <span className="text-xs text-emerald-400">Saved ✓</span>}
        {saveStatus === 'err' && <span className="text-xs text-red-400">Save failed</span>}
      </div>
    </div>
  );
}
