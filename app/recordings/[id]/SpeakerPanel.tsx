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
  const [names,       setNames]       = useState<Record<string, string>>(
    () => Object.fromEntries(speakers.map(s => [String(s), String(s)])),
  );
  const [remember,    setRemember]    = useState<Record<string, boolean>>({});
  const [saving,      setSaving]      = useState(false);
  const [reanalysing, setReanalysing] = useState(false);
  const [saveStatus,  setSaveStatus]  = useState<'idle' | 'ok' | 'err'>('idle');
  const [reanalStatus,setReanalStatus]= useState<'idle' | 'ok' | 'err' | 'running'>('idle');

  // Merge mode state
  const [mergeMode,   setMergeMode]   = useState(false);
  const [mergeFrom,   setMergeFrom]   = useState<string | null>(null);
  const [mergeTo,     setMergeTo]     = useState<string | null>(null);
  const [merging,     setMerging]     = useState(false);

  const hasChanges = speakers.some(s => (names[s] ?? s) !== s);

  async function handleSave() {
    const renames: Record<string, string> = {};
    for (const orig of speakers) {
      const next = (names[orig] ?? orig).trim();
      if (next && next !== orig) renames[orig] = next;
    }

    setSaving(true);
    setSaveStatus('idle');
    try {
      if (Object.keys(renames).length) {
        const res = await fetch(`/api/recordings/${recordingId}/speakers`, {
          method:  'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body:    JSON.stringify({ renames }),
        });
        if (!res.ok) { setSaveStatus('err'); return; }
      }

      // Save voice profiles for checked speakers
      const rememberJobs = speakers
        .filter(orig => remember[orig])
        .map(orig => {
          const resolvedName = (names[orig] ?? orig).trim() || orig;
          return fetch('/api/speakers/profiles', {
            method:  'POST',
            headers: { 'Content-Type': 'application/json' },
            body:    JSON.stringify({ name: resolvedName, recordingId, speakerLabel: orig }),
          });
        });
      await Promise.all(rememberJobs);

      setSaveStatus('ok');
      router.refresh();
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
      if (res.ok) { setReanalStatus('ok'); router.refresh(); }
      else        { setReanalStatus('err'); }
    } catch { setReanalStatus('err'); }
    finally  { setReanalysing(false); }
  }

  async function handleMerge() {
    if (!mergeFrom || !mergeTo || mergeFrom === mergeTo) return;
    setMerging(true);
    try {
      const res = await fetch(`/api/recordings/${recordingId}/speakers`, {
        method:  'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ renames: { [mergeFrom]: mergeTo } }),
      });
      if (res.ok) {
        setMergeMode(false); setMergeFrom(null); setMergeTo(null);
        router.refresh();
      }
    } catch { /* ignore */ }
    finally  { setMerging(false); }
  }

  return (
    <div className="rounded-2xl border border-surface-border bg-surface-card p-4 space-y-3 mb-4">
      <div className="flex items-center justify-between gap-2">
        <p className="text-xs font-semibold uppercase tracking-widest text-ftc-mid">Speakers</p>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => { setMergeMode(m => !m); setMergeFrom(null); setMergeTo(null); }}
            className={`text-xs px-2.5 py-1 rounded-lg border transition-colors ${
              mergeMode
                ? 'border-brand/40 bg-brand/10 text-brand'
                : 'border-surface-border text-ftc-mid hover:text-ftc-gray hover:border-ftc-mid'
            }`}
          >
            Merge
          </button>
          <button
            type="button"
            onClick={handleReanalyse}
            disabled={reanalysing}
            title="Re-separate the transcript by voice, using the latest saved voice profiles for each person"
            className="text-xs px-2.5 py-1 rounded-lg border border-surface-border text-ftc-mid hover:text-ftc-gray hover:border-ftc-mid transition-colors disabled:opacity-50"
          >
            {reanalysing ? 'Re-analysing…' : reanalStatus === 'ok' ? 'Done ✓' : reanalStatus === 'err' ? 'Failed — retry' : 'Re-analyse'}
          </button>
        </div>
      </div>

      {/* Merge mode UI */}
      {mergeMode && (
        <div className="rounded-xl border border-brand/20 bg-brand/5 p-3 space-y-2">
          <p className="text-xs text-ftc-mid">Select the speaker to replace, then the target:</p>
          <div className="flex gap-2">
            <select
              title="Speaker to replace"
              value={mergeFrom ?? ''}
              onChange={e => setMergeFrom(e.target.value || null)}
              className="flex-1 text-xs bg-surface border border-surface-border rounded-lg px-2.5 py-1.5 text-ftc-gray focus:outline-none"
            >
              <option value="">Replace…</option>
              {speakers.map(s => <option key={s} value={s}>{names[s] ?? s}</option>)}
            </select>
            <span className="text-xs text-ftc-mid self-center">→</span>
            <select
              title="Speaker to merge into"
              value={mergeTo ?? ''}
              onChange={e => setMergeTo(e.target.value || null)}
              className="flex-1 text-xs bg-surface border border-surface-border rounded-lg px-2.5 py-1.5 text-ftc-gray focus:outline-none"
            >
              <option value="">Into…</option>
              {speakers.filter(s => s !== mergeFrom).map(s => <option key={s} value={s}>{names[s] ?? s}</option>)}
            </select>
          </div>
          <button
            type="button"
            onClick={handleMerge}
            disabled={!mergeFrom || !mergeTo || merging}
            className="text-xs px-3 py-1.5 rounded-lg bg-brand/10 text-brand hover:bg-brand/20 transition-colors disabled:opacity-40"
          >
            {merging ? 'Merging…' : 'Merge speakers'}
          </button>
        </div>
      )}

      {/* Speaker name inputs */}
      {!mergeMode && (
        <>
          <div className="space-y-2">
            {speakers.map((orig, i) => {
              const c = SPEAKER_COLOURS[i % SPEAKER_COLOURS.length];
              return (
                <div key={orig} className="space-y-1">
                  <div className="flex items-center gap-2">
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
                  <label className="flex items-center gap-2 pl-8 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={!!remember[orig]}
                      onChange={e => setRemember(r => ({ ...r, [orig]: e.target.checked }))}
                      className="w-3 h-3 rounded accent-brand"
                    />
                    <span className="text-[11px] text-ftc-mid">Remember this voice</span>
                  </label>
                </div>
              );
            })}
          </div>

          <div className="flex items-center gap-3 pt-0.5">
            <button
              type="button"
              onClick={handleSave}
              disabled={saving || (!hasChanges && !Object.values(remember).some(Boolean))}
              className="text-xs px-3 py-1.5 rounded-lg bg-brand/10 text-brand hover:bg-brand/20 transition-colors disabled:opacity-40"
            >
              {saving ? 'Saving…' : 'Save names'}
            </button>
            {saveStatus === 'ok' && <span className="text-xs text-emerald-400">Saved ✓</span>}
            {saveStatus === 'err' && <span className="text-xs text-red-400">Save failed</span>}
          </div>
        </>
      )}
    </div>
  );
}
