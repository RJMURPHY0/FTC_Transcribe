'use client';

import { useState, useRef, useEffect, useCallback } from 'react';
import { useSearchParams } from 'next/navigation';
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

const DATE_LABELS: Record<string, string> = {
  all: 'Any time', week: 'This week', month: 'This month',
};

function formatDate(d: string) {
  return new Date(d).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
}

function dateFrom(range: string): string | null {
  const now = Date.now();
  if (range === 'week')  return new Date(now - 7  * 86400_000).toISOString();
  if (range === 'month') return new Date(now - 30 * 86400_000).toISOString();
  return null;
}

export default function SearchBar({ canSeeAll = false }: { canSeeAll?: boolean }) {
  const urlParams = useSearchParams();

  const [query,   setQuery]   = useState('');
  const [aiQuery, setAiQuery] = useState('');
  const [results, setResults] = useState<Result[]>([]);
  const [open,    setOpen]    = useState(false);
  const [loading, setLoading] = useState(false);
  const [aiActive, setAiActive] = useState(false);   // true when showing AI results

  // Filters
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [fSource, setFSource] = useState<'all' | 'web' | 'teams'>('all');
  const [fType,   setFType]   = useState<'all' | keyof typeof TYPE_LABELS>('all');
  const [fDate,   setFDate]   = useState<'all' | 'week' | 'month'>('all');

  const debounceRef  = useRef<ReturnType<typeof setTimeout>>(undefined);
  const containerRef = useRef<HTMLDivElement>(null);

  const hasFilters = fSource !== 'all' || fType !== 'all' || fDate !== 'all';

  // Build the query string shared by normal + AI search. Company/assignee scope
  // comes from the page's dropdown selection (URL); the panel owns source/type/date.
  const buildParams = useCallback((term: string, ai: boolean) => {
    const p = new URLSearchParams();
    p.set('q', term);
    if (ai) p.set('mode', 'ai');
    if (fSource !== 'all') p.set('source', fSource);
    if (fType   !== 'all') p.set('type', fType);
    const from = dateFrom(fDate);
    if (from) p.set('from', from);
    // Pass through the active company / assignee scope from the dashboard URL
    for (const k of ['org', 'team', 'assignee', 'source'] as const) {
      const v = urlParams.get(k);
      if (v && !p.has(k)) p.set(k, v);
    }
    return p.toString();
  }, [fSource, fType, fDate, urlParams]);

  const run = useCallback(async (term: string, ai: boolean) => {
    if (term.trim().length < 2) { setResults([]); setOpen(false); return; }
    setLoading(true);
    setAiActive(ai);
    try {
      const res  = await fetch(`/api/search?${buildParams(term, ai)}`);
      const data = await res.json() as Result[];
      setResults(data);
      setOpen(true);
    } catch { /* ignore */ }
    finally { setLoading(false); }
  }, [buildParams]);

  // Debounced normal search on typing / filter change
  useEffect(() => {
    clearTimeout(debounceRef.current);
    if (query.length < 2) { setResults([]); setOpen(false); setAiActive(false); return; }
    debounceRef.current = setTimeout(() => run(query, false), 350);
    return () => clearTimeout(debounceRef.current);
  }, [query, fSource, fType, fDate, run]);

  // Close popovers on outside click
  useEffect(() => {
    function handle(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
        setFiltersOpen(false);
      }
    }
    document.addEventListener('mousedown', handle);
    return () => document.removeEventListener('mousedown', handle);
  }, []);

  const submitAi = (e: React.FormEvent) => {
    e.preventDefault();
    if (aiQuery.trim().length < 2) return;
    setFiltersOpen(false);
    run(aiQuery, true);
  };

  const clearFilters = () => { setFSource('all'); setFType('all'); setFDate('all'); };

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
          onFocus={() => results.length > 0 && !aiActive && setOpen(true)}
          placeholder="Search meetings by title, transcript, notes…"
          className="w-full pl-10 pr-20 py-2.5 text-sm text-ftc-gray bg-surface-card border border-surface-border
                     rounded-xl focus:outline-none focus:border-brand/50 transition-colors"
        />
        {loading && (
          <span className="absolute right-12 top-1/2 -translate-y-1/2 w-3.5 h-3.5 rounded-full border-2 border-ftc-mid/30 border-t-ftc-mid animate-spin" />
        )}
        {/* Filter button */}
        <button
          type="button"
          onClick={() => { setFiltersOpen(o => !o); setOpen(false); }}
          aria-label="Filters"
          className={`absolute right-2.5 top-1/2 -translate-y-1/2 p-1.5 rounded-lg transition-colors ${
            filtersOpen || hasFilters ? 'text-brand bg-brand/10' : 'text-ftc-mid hover:text-ftc-gray hover:bg-surface-raised'
          }`}
        >
          <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" d="M12 3v3m0 0a2 2 0 100 4 2 2 0 000-4zm-6 6v9m0-9a2 2 0 100 4 2 2 0 000-4zm0 0V3m12 0v9m0 0a2 2 0 100 4 2 2 0 000-4zm0 0V3" />
          </svg>
          {hasFilters && !filtersOpen && (
            <span className="absolute top-1 right-1 w-1.5 h-1.5 rounded-full bg-brand" />
          )}
        </button>
      </div>

      {/* ── Filters panel ── */}
      {filtersOpen && (
        <div className="absolute top-full mt-1.5 right-0 z-40 w-80 rounded-2xl border border-surface-border bg-surface-card shadow-xl p-4 space-y-4">
          <div className="flex items-center justify-between">
            <p className="text-xs font-semibold uppercase tracking-widest text-ftc-mid">Filters</p>
            {hasFilters && (
              <button type="button" onClick={clearFilters} className="text-[11px] text-brand hover:underline">
                Clear
              </button>
            )}
          </div>

          {/* Ask AI */}
          <div>
            <p className="flex items-center gap-1.5 text-xs font-medium text-ftc-gray mb-1.5">
              <svg className="w-3.5 h-3.5 text-brand" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" d="M5 3v4M3 5h4M6 17v4m-2-2h4m5-16l2.286 6.857L23 12l-6.714 2.143L14 21l-2.286-6.857L5 12l6.714-2.143L14 3z" />
              </svg>
              Ask AI
            </p>
            <form onSubmit={submitAi} className="flex items-center gap-1.5">
              <input
                value={aiQuery}
                onChange={e => setAiQuery(e.target.value)}
                placeholder="e.g. meetings about pricing…"
                className="flex-1 min-w-0 px-3 py-2 text-sm rounded-lg bg-surface-raised border border-surface-border text-ftc-gray placeholder:text-surface-muted focus:outline-none focus:border-brand"
              />
              <button
                type="submit"
                aria-label="Ask AI"
                className="flex-shrink-0 p-2 rounded-lg bg-brand text-white hover:bg-brand/90 transition-colors"
              >
                <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M5 3v4M3 5h4M6 17v4m-2-2h4m5-16l2.286 6.857L23 12l-6.714 2.143L14 21l-2.286-6.857L5 12l6.714-2.143L14 3z" />
                </svg>
              </button>
            </form>
          </div>

          <div className="h-px bg-surface-border" />

          {/* Source */}
          <div>
            <p className="text-xs font-medium text-ftc-gray mb-1.5">Source</p>
            <div className="flex flex-wrap gap-1.5">
              {(['all', 'web', 'teams'] as const).map(s => (
                <button
                  key={s}
                  type="button"
                  onClick={() => setFSource(s)}
                  className={`text-[11px] font-medium px-2.5 py-1 rounded-lg transition-colors ${
                    fSource === s ? 'bg-brand text-white' : 'text-ftc-mid hover:text-ftc-gray bg-surface-raised'
                  }`}
                >
                  {s === 'all' ? 'All' : s === 'web' ? 'In person' : 'Teams'}
                </button>
              ))}
            </div>
          </div>

          {/* Meeting type */}
          <div>
            <p className="text-xs font-medium text-ftc-gray mb-1.5">Meeting type</p>
            <div className="flex flex-wrap gap-1.5">
              <button
                type="button"
                onClick={() => setFType('all')}
                className={`text-[11px] font-medium px-2.5 py-1 rounded-lg transition-colors ${
                  fType === 'all' ? 'bg-brand text-white' : 'text-ftc-mid hover:text-ftc-gray bg-surface-raised'
                }`}
              >
                All
              </button>
              {Object.keys(TYPE_LABELS).map(t => (
                <button
                  key={t}
                  type="button"
                  onClick={() => setFType(t as keyof typeof TYPE_LABELS)}
                  className={`text-[11px] font-medium px-2.5 py-1 rounded-lg transition-colors ${
                    fType === t ? 'bg-brand text-white' : 'text-ftc-mid hover:text-ftc-gray bg-surface-raised'
                  }`}
                >
                  {TYPE_LABELS[t]}
                </button>
              ))}
            </div>
          </div>

          {/* Date range */}
          <div>
            <p className="text-xs font-medium text-ftc-gray mb-1.5">Date</p>
            <div className="flex flex-wrap gap-1.5">
              {(['all', 'week', 'month'] as const).map(d => (
                <button
                  key={d}
                  type="button"
                  onClick={() => setFDate(d)}
                  className={`text-[11px] font-medium px-2.5 py-1 rounded-lg transition-colors ${
                    fDate === d ? 'bg-brand text-white' : 'text-ftc-mid hover:text-ftc-gray bg-surface-raised'
                  }`}
                >
                  {DATE_LABELS[d]}
                </button>
              ))}
            </div>
          </div>

          {canSeeAll && (
            <p className="text-[11px] text-surface-muted leading-relaxed">
              Search is scoped to the Company / Assignee selected in the dropdowns above.
            </p>
          )}
        </div>
      )}

      {/* ── Results dropdown ── */}
      {open && (
        <div className="absolute top-full mt-1.5 left-0 right-0 z-30 rounded-2xl border border-surface-border bg-surface-card shadow-xl overflow-hidden">
          {aiActive && (
            <div className="flex items-center gap-1.5 px-4 py-2 border-b border-surface-border text-[11px] font-medium text-brand">
              <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" d="M5 3v4M3 5h4M6 17v4m-2-2h4m5-16l2.286 6.857L23 12l-6.714 2.143L14 21l-2.286-6.857L5 12l6.714-2.143L14 3z" />
              </svg>
              AI results
            </div>
          )}
          {results.length === 0 ? (
            <p className="text-xs text-ftc-mid px-4 py-3">No results found.</p>
          ) : (
            <ul className="max-h-96 overflow-y-auto">
              {results.map(r => (
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
