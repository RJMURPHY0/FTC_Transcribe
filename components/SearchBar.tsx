'use client';

import { useState, useRef, useEffect, useMemo } from 'react';
import Link from 'next/link';

interface Result {
  id:          string;
  title:       string;
  createdAt:   string;
  meetingType: string;
  source:      string;
  excerpt:     string;
}

const TYPE_LABELS: Record<string, string> = {
  general: 'General', standup: 'Standup', sales: 'Sales', interview: 'Interview', review: 'Review',
};

function formatDate(d: string) {
  return new Date(d).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
}

export default function SearchBar() {
  const [query,   setQuery]   = useState('');
  const [results, setResults] = useState<Result[]>([]);
  const [open,    setOpen]    = useState(false);
  const [loading, setLoading] = useState(false);
  const [source,  setSource]  = useState<'all' | 'web' | 'teams'>('all');
  const [type,    setType]    = useState<'all' | keyof typeof TYPE_LABELS>('all');

  const debounceRef  = useRef<ReturnType<typeof setTimeout>>(undefined);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    clearTimeout(debounceRef.current);
    if (query.length < 2) { setResults([]); setOpen(false); return; }

    debounceRef.current = setTimeout(async () => {
      setLoading(true);
      try {
        const res  = await fetch(`/api/search?q=${encodeURIComponent(query)}`);
        const data = await res.json() as Result[];
        setResults(data);
        setOpen(true);
      } catch { /* ignore */ }
      finally { setLoading(false); }
    }, 350);

    return () => clearTimeout(debounceRef.current);
  }, [query]);

  useEffect(() => {
    function handle(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener('mousedown', handle);
    return () => document.removeEventListener('mousedown', handle);
  }, []);

  // Which meeting types actually appear in the results — only offer those as filters
  const availableTypes = useMemo(
    () => Array.from(new Set(results.map(r => r.meetingType).filter(t => t && TYPE_LABELS[t]))),
    [results],
  );

  const filtered = useMemo(
    () => results.filter(r =>
      (source === 'all' || r.source === source) &&
      (type === 'all' || r.meetingType === type),
    ),
    [results, source, type],
  );

  const hasFilters = source !== 'all' || type !== 'all';

  return (
    <div ref={containerRef} className="relative w-full">
      <div className="relative">
        <svg
          className="absolute left-3.5 top-1/2 -translate-y-1/2 w-4 h-4 text-ftc-mid pointer-events-none"
          fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24"
        >
          <circle cx="11" cy="11" r="8" />
          <path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-4.35-4.35" />
        </svg>
        <input
          type="search"
          value={query}
          onChange={e => setQuery(e.target.value)}
          onFocus={() => results.length > 0 && setOpen(true)}
          placeholder="Search recordings, transcripts, action items…"
          className="w-full pl-10 pr-9 py-2.5 text-sm text-ftc-gray bg-surface-card border border-surface-border
                     rounded-xl focus:outline-none focus:border-brand/50 transition-colors"
        />
        {loading && (
          <span className="absolute right-3.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 rounded-full border-2 border-ftc-mid/30 border-t-ftc-mid animate-spin" />
        )}
      </div>

      {open && (
        <div className="absolute top-full mt-1.5 left-0 right-0 z-30 rounded-2xl border border-surface-border bg-surface-card shadow-xl overflow-hidden">
          {/* Filter row */}
          <div className="flex items-center gap-1.5 px-3 py-2.5 border-b border-surface-border overflow-x-auto">
            {(['all', 'web', 'teams'] as const).map(s => (
              <button
                key={s}
                type="button"
                onClick={() => setSource(s)}
                className={`text-[11px] font-medium px-2.5 py-1 rounded-lg whitespace-nowrap transition-colors ${
                  source === s ? 'bg-brand text-white' : 'text-ftc-mid hover:text-ftc-gray bg-surface-raised'
                }`}
              >
                {s === 'all' ? 'All' : s === 'web' ? 'In person' : 'Teams'}
              </button>
            ))}
            {availableTypes.length > 0 && <span className="w-px h-4 bg-surface-border mx-0.5" />}
            {availableTypes.map(t => (
              <button
                key={t}
                type="button"
                onClick={() => setType(type === t ? 'all' : t as keyof typeof TYPE_LABELS)}
                className={`text-[11px] font-medium px-2.5 py-1 rounded-lg whitespace-nowrap transition-colors ${
                  type === t ? 'bg-brand text-white' : 'text-ftc-mid hover:text-ftc-gray bg-surface-raised'
                }`}
              >
                {TYPE_LABELS[t]}
              </button>
            ))}
          </div>

          {filtered.length === 0 ? (
            <p className="text-xs text-ftc-mid px-4 py-3">
              {results.length === 0 ? 'No results found.' : 'No results match these filters.'}
              {hasFilters && (
                <button
                  type="button"
                  onClick={() => { setSource('all'); setType('all'); }}
                  className="ml-2 text-brand hover:underline"
                >
                  Clear filters
                </button>
              )}
            </p>
          ) : (
            <ul className="max-h-96 overflow-y-auto">
              {filtered.map(r => (
                <li key={r.id}>
                  <Link
                    href={`/recordings/${r.id}`}
                    onClick={() => { setOpen(false); setQuery(''); }}
                    className="flex flex-col gap-0.5 px-4 py-3 hover:bg-surface-raised transition-colors border-b border-surface-border last:border-0"
                  >
                    <span className="flex items-center gap-2">
                      <span className="text-sm font-medium text-ftc-gray truncate">{r.title}</span>
                      {r.source === 'teams' && (
                        <span className="flex-shrink-0 text-[9px] font-semibold px-1.5 py-0.5 rounded bg-[#4b53bc]/15 text-[#6264A7]">Teams</span>
                      )}
                    </span>
                    {r.excerpt && (
                      <span className="text-xs text-ftc-mid line-clamp-2">{r.excerpt}</span>
                    )}
                    <span className="text-[10px] text-surface-muted">{formatDate(r.createdAt)}</span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
