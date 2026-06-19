'use client';

import { useState } from 'react';
import type { TopicSection } from '@/lib/ai';

// ─── Types ────────────────────────────────────────────────────────────────────

interface AISummary {
  overview:    string;
  keyPoints:   string[];
  actionItems: string[];
  decisions:   string[];
  topics:      TopicSection[];
}

type Section = 'overview' | 'keyPoints' | 'actionItems' | 'decisions' | 'topics';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function formatTimestamp(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

// ─── Section card with edit/save/cancel header ────────────────────────────────

function SectionCard({
  title, isEditing, onEdit, onSave, onCancel, saving, children,
}: {
  title:     string;
  isEditing: boolean;
  onEdit:    () => void;
  onSave:    () => void;
  onCancel:  () => void;
  saving:    boolean;
  children:  React.ReactNode;
}) {
  return (
    <div className="rounded-2xl border border-surface-border bg-surface-card p-5">
      <div className="flex items-center mb-4">
        <h2 className="flex-1 text-xs font-semibold uppercase tracking-widest text-ftc-mid">
          {title}
        </h2>
        {isEditing ? (
          <div className="flex items-center gap-2">
            <button
              onClick={onCancel}
              className="text-xs text-ftc-mid hover:text-ftc-gray transition-colors px-2 py-1 rounded-lg"
            >
              Cancel
            </button>
            <button
              onClick={onSave}
              disabled={saving}
              className="text-xs bg-brand text-white px-3 py-1 rounded-lg font-medium
                         hover:bg-brand-dark transition-colors disabled:opacity-50"
            >
              {saving ? 'Saving…' : 'Save'}
            </button>
          </div>
        ) : (
          <button
            onClick={onEdit}
            title={`Edit ${title}`}
            className="text-surface-muted hover:text-brand transition-colors p-1 rounded-lg -mr-1"
          >
            {/* Pencil icon */}
            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round"
                d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5
                   m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
            </svg>
          </button>
        )}
      </div>
      {children}
    </div>
  );
}

// ─── Generic list editor (key points / action items / decisions) ───────────────

function ListEditor({
  items, onChange, placeholder,
}: {
  items:       string[];
  onChange:    (items: string[]) => void;
  placeholder: string;
}) {
  return (
    <div className="space-y-2">
      {items.map((item, i) => (
        <div key={i} className="flex items-center gap-2">
          <input
            value={item}
            onChange={e => { const n = [...items]; n[i] = e.target.value; onChange(n); }}
            placeholder={placeholder}
            className="flex-1 text-sm text-ftc-gray bg-surface-raised border border-surface-border
                       rounded-lg px-3 py-2 outline-none focus:border-brand/50 transition-colors"
          />
          <button
            onClick={() => onChange(items.filter((_, idx) => idx !== i))}
            title="Remove"
            className="text-surface-muted hover:text-red-400 transition-colors p-1.5 rounded-lg flex-shrink-0"
          >
            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>
      ))}
      <button
        onClick={() => onChange([...items, ''])}
        className="flex items-center gap-1.5 text-xs text-ftc-mid hover:text-brand transition-colors py-1"
      >
        <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" d="M12 4v16m8-8H4" />
        </svg>
        Add item
      </button>
    </div>
  );
}

// ─── Topics editor (timestamp read-only, title editable, rows deletable) ──────

function TopicsEditor({
  items, onChange,
}: {
  items:    TopicSection[];
  onChange: (items: TopicSection[]) => void;
}) {
  return (
    <div className="space-y-2">
      {items.map((topic, i) => (
        <div key={i} className="flex items-center gap-2">
          <span className="tabular-nums text-xs font-mono text-ftc-mid w-10 flex-shrink-0">
            {formatTimestamp(topic.time)}
          </span>
          <input
            value={topic.title}
            onChange={e => {
              const n = items.map((t, idx) => idx === i ? { ...t, title: e.target.value } : t);
              onChange(n);
            }}
            className="flex-1 text-sm text-ftc-gray bg-surface-raised border border-surface-border
                       rounded-lg px-3 py-2 outline-none focus:border-brand/50 transition-colors"
          />
          <button
            onClick={() => onChange(items.filter((_, idx) => idx !== i))}
            title="Remove"
            className="text-surface-muted hover:text-red-400 transition-colors p-1.5 rounded-lg flex-shrink-0"
          >
            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>
      ))}
    </div>
  );
}

// ─── Main component ───────────────────────────────────────────────────────────

export default function EditableAINotes({
  recordingId,
  recordingTitle,
  initialSummary,
}: {
  recordingId:    string;
  recordingTitle: string;
  initialSummary: AISummary;
}) {
  const [data,         setData]        = useState<AISummary>(initialSummary);
  const [editing,      setEditing]     = useState<Section | null>(null);
  const [draftText,    setDraftText]   = useState('');
  const [draftList,    setDraftList]   = useState<string[]>([]);
  const [draftTopics,  setDraftTopics] = useState<TopicSection[]>([]);
  const [checkedItems,  setCheckedItems] = useState<Set<number>>(new Set());
  const [saving,        setSaving]       = useState(false);
  const [saveError,     setSaveError]    = useState('');
  const [downloading,   setDownloading]  = useState(false);
  const [downloadingPdf, setDownloadingPdf] = useState(false);

  // Enter edit mode for a section
  const startEdit = (section: Section) => {
    setSaveError('');
    if (section === 'overview') {
      setDraftText(data.overview);
    } else if (section === 'topics') {
      setDraftTopics(data.topics.map(t => ({ ...t })));
    } else {
      setDraftList([...data[section as keyof Pick<AISummary, 'keyPoints' | 'actionItems' | 'decisions'>]]);
    }
    setEditing(section);
  };

  const cancel = () => { setEditing(null); setSaveError(''); };

  const save = async (section: Section) => {
    setSaving(true);
    setSaveError('');

    const value: unknown =
      section === 'overview' ? draftText :
      section === 'topics'   ? draftTopics :
      draftList.filter(s => s.trim() !== '');

    try {
      const res = await fetch(`/api/recordings/${recordingId}/summary`, {
        method:  'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ [section]: value }),
      });
      if (!res.ok) {
        const d = await res.json().catch(() => ({})) as { error?: string };
        throw new Error(d.error ?? 'Save failed');
      }
      setData(prev => ({ ...prev, [section]: value }));
      setEditing(null);
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : 'Save failed');
    } finally {
      setSaving(false);
    }
  };

  const download = async () => {
    setDownloading(true);
    try {
      const res = await fetch(`/api/recordings/${recordingId}/export/word`);
      if (!res.ok) return;
      const blob = await res.blob();
      const url  = URL.createObjectURL(blob);
      const a    = document.createElement('a');
      a.href     = url;
      a.download = `${recordingTitle.replace(/[^a-z0-9 ]/gi, '_')}.docx`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } finally {
      setDownloading(false);
    }
  };

  const downloadPdf = async () => {
    setDownloadingPdf(true);
    try {
      const res = await fetch(`/api/recordings/${recordingId}/export/pdf`);
      if (!res.ok) return;
      const blob = await res.blob();
      const url  = URL.createObjectURL(blob);
      const a    = document.createElement('a');
      a.href     = url;
      a.download = `${recordingTitle.replace(/[^a-z0-9 ]/gi, '_')}.pdf`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } finally {
      setDownloadingPdf(false);
    }
  };

  const isEdit = (s: Section) => editing === s;

  const sectionProps = (s: Section) => ({
    isEditing: isEdit(s),
    onEdit:    () => startEdit(s),
    onSave:    () => save(s),
    onCancel:  cancel,
    saving,
  });

  return (
    <div className="space-y-4">

      {/* ── Header ── */}
      <div className="flex items-center gap-2">
        <p className="flex-1 text-xs font-semibold uppercase tracking-widest text-ftc-mid flex items-center gap-2">
          <svg className="w-3.5 h-3.5 text-brand" fill="currentColor" viewBox="0 0 24 24">
            <path d="M12 2a10 10 0 1 0 0 20A10 10 0 0 0 12 2zm-1 5h2v6h-2zm0 8h2v2h-2z"/>
          </svg>
          AI Notes
        </p>
        <button
          onClick={download}
          disabled={downloading}
          title="Download as Word document"
          className="flex items-center gap-1.5 text-xs text-ftc-mid hover:text-brand
                     border border-surface-border hover:border-brand/40 rounded-xl
                     px-2.5 py-1.5 transition-colors disabled:opacity-50"
        >
          <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round"
              d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
          </svg>
          {downloading ? 'Preparing…' : '.docx'}
        </button>
        <button
          onClick={downloadPdf}
          disabled={downloadingPdf}
          title="Download as PDF"
          className="flex items-center gap-1.5 text-xs text-ftc-mid hover:text-brand
                     border border-surface-border hover:border-brand/40 rounded-xl
                     px-2.5 py-1.5 transition-colors disabled:opacity-50"
        >
          <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round"
              d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
          </svg>
          {downloadingPdf ? 'Preparing…' : '.pdf'}
        </button>
      </div>

      {saveError && <p className="text-xs text-red-400 px-1">{saveError}</p>}

      {/* ── Topics (only if AI found some) ── */}
      {data.topics.length > 0 && (
        <SectionCard title="Topics" {...sectionProps('topics')}>
          {isEdit('topics') ? (
            <TopicsEditor items={draftTopics} onChange={setDraftTopics} />
          ) : (
            <ol className="space-y-0">
              {data.topics.map((t, i) => (
                <li key={i} className="flex items-center gap-3 py-2 border-b border-surface-border last:border-0">
                  <span className="tabular-nums text-xs font-mono text-ftc-mid w-10 flex-shrink-0">
                    {formatTimestamp(t.time)}
                  </span>
                  <span className="text-sm text-ftc-gray">{t.title}</span>
                </li>
              ))}
            </ol>
          )}
        </SectionCard>
      )}

      {/* ── Summary ── */}
      <SectionCard title="Summary" {...sectionProps('overview')}>
        {isEdit('overview') ? (
          <textarea
            value={draftText}
            onChange={e => setDraftText(e.target.value)}
            rows={5}
            className="w-full text-sm text-ftc-gray bg-surface-raised border border-surface-border
                       rounded-xl px-3 py-2.5 resize-none outline-none focus:border-brand/50
                       transition-colors leading-7"
          />
        ) : (
          <p className="text-sm text-ftc-gray leading-7">{data.overview}</p>
        )}
      </SectionCard>

      {/* ── Action Items ── */}
      <SectionCard title="Action Items" {...sectionProps('actionItems')}>
        {isEdit('actionItems') ? (
          <ListEditor items={draftList} onChange={setDraftList} placeholder="Action item…" />
        ) : data.actionItems.length > 0 ? (
          <ul className="space-y-3">
            {data.actionItems.map((item, i) => {
              const done = checkedItems.has(i);
              return (
                <li key={i} className="flex items-start gap-3">
                  <button
                    type="button"
                    onClick={() => setCheckedItems(prev => {
                      const next = new Set(prev);
                      done ? next.delete(i) : next.add(i);
                      return next;
                    })}
                    title={done ? 'Mark incomplete' : 'Mark complete'}
                    className={`mt-0.5 w-5 h-5 rounded border flex items-center justify-center flex-shrink-0 transition-colors
                      ${done
                        ? 'bg-brand border-brand text-white'
                        : 'border-surface-muted hover:border-brand/60 text-transparent'
                      }`}
                  >
                    <svg className="w-3 h-3" fill="none" stroke="currentColor" strokeWidth={2.5} viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                    </svg>
                  </button>
                  <span className={`text-sm leading-relaxed transition-colors ${done ? 'line-through text-ftc-mid' : 'text-ftc-gray'}`}>
                    {item}
                  </span>
                </li>
              );
            })}
          </ul>
        ) : (
          <p className="text-sm text-ftc-mid">No action items found.</p>
        )}
      </SectionCard>

      {/* ── Key Points ── */}
      <SectionCard title="Key Points" {...sectionProps('keyPoints')}>
        {isEdit('keyPoints') ? (
          <ListEditor items={draftList} onChange={setDraftList} placeholder="Key point…" />
        ) : data.keyPoints.length > 0 ? (
          <ul className="space-y-2.5">
            {data.keyPoints.map((p, i) => (
              <li key={i} className="flex items-start gap-2.5">
                <span className="mt-2 w-1.5 h-1.5 rounded-full bg-brand flex-shrink-0" />
                <span className="text-sm text-ftc-gray leading-relaxed">{p}</span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-ftc-mid">No key points found.</p>
        )}
      </SectionCard>

      {/* ── Decisions ── */}
      <SectionCard title="Decisions" {...sectionProps('decisions')}>
        {isEdit('decisions') ? (
          <ListEditor items={draftList} onChange={setDraftList} placeholder="Decision…" />
        ) : data.decisions.length > 0 && data.decisions[0] !== 'None' ? (
          <ul className="space-y-2.5">
            {data.decisions.map((d, i) => (
              <li key={i} className="flex items-start gap-2.5">
                <svg className="w-4 h-4 mt-0.5 text-emerald-500 flex-shrink-0" fill="none" stroke="currentColor" strokeWidth={2.5} viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                </svg>
                <span className="text-sm text-ftc-gray leading-relaxed">{d}</span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-ftc-mid">No decisions recorded.</p>
        )}
      </SectionCard>

    </div>
  );
}
