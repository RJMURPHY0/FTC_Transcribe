'use client';

// Search + filters for the dashboard.
//
// Every filter lives in the URL, which is what makes it real: the server
// re-renders the list, the stat tiles and the "Show more" link from the same
// params. Until this change the panel only narrowed the search popover, so
// picking "This week" with an empty box changed nothing on screen.
//
// The typed box still opens a quick-jump dropdown of matching meetings. "Ask
// AI" takes whatever is in that box as a question and turns it into the same
// filter the chips below produce — same control surface as the CRM's pipeline
// search, so the two apps behave the same way.

import { useState, useRef, useEffect, useCallback, useMemo } from 'react';
import { useRouter, useSearchParams, usePathname } from 'next/navigation';
import Link from 'next/link';
import { Search, SlidersHorizontal, Sparkles, Loader2, X } from 'lucide-react';
import {
  parseFilters, filtersToParams, describeFilters, hasAnyFilter,
  FILTER_KEYS, MEETING_TYPES, MEETING_TYPE_LABELS, DATE_LABELS,
  STATUS_FILTERS, STATUS_LABELS,
  type RecordingFilters, type DateFilter, type MeetingTypeFilter, type SortFilter, type StatusFilter,
} from '@/lib/recording-filters';

interface Result {
  id:          string;
  title:       string;
  createdAt:   string;
  meetingType: string;
  source:      string;
  excerpt:     string;
}

const SORT_LABELS: Record<SortFilter, string> = {
  newest: 'Newest', oldest: 'Oldest', longest: 'Longest', shortest: 'Shortest',
};

function formatDate(d: string) {
  return new Date(d).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
}

/** Chip styling is shared by every option in the panel so a selected Source and
 *  a selected Date can't drift apart visually. */
function chipClass(active: boolean) {
  return `text-[11px] font-medium px-2.5 py-1 rounded-lg transition-colors ${
    active ? 'bg-brand text-white' : 'text-ftc-mid hover:text-ftc-gray bg-surface-raised'
  }`;
}

export default function SearchBar({ canSeeAll = false }: { canSeeAll?: boolean }) {
  const router      = useRouter();
  const pathname    = usePathname();
  const urlParams   = useSearchParams();

  // The URL is the single source of truth for filters; this component only
  // reads it and writes back to it.
  const filters = useMemo(() => parseFilters(urlParams), [urlParams]);
  const chips   = useMemo(() => describeFilters(filters), [filters]);
  const active  = hasAnyFilter(filters);

  const [query,   setQuery]   = useState('');
  const [results, setResults] = useState<Result[]>([]);
  const [open,    setOpen]    = useState(false);
  const [loading, setLoading] = useState(false);
  const [aiLoading, setAiLoading] = useState(false);
  const [aiError, setAiError] = useState<string | null>(null);
  const [filtersOpen, setFiltersOpen] = useState(false);

  const debounceRef  = useRef<ReturnType<typeof setTimeout>>(undefined);
  const containerRef = useRef<HTMLDivElement>(null);

  /** Rewrite the URL with a new filter set, preserving the scope params the
   *  dashboard owns (folder, org, team, assignee) and resetting pagination —
   *  a narrower list should start at page one, not 90 rows in. */
  const applyFilters = useCallback((next: Partial<RecordingFilters>, replaceAll = false) => {
    const merged = replaceAll ? { ...filters, ...next } : { ...filters, ...next };
    const sp = new URLSearchParams(urlParams.toString());
    for (const k of FILTER_KEYS) sp.delete(k);
    sp.delete('limit');
    for (const [k, v] of Object.entries(filtersToParams(merged))) sp.set(k, v);
    const qs = sp.toString();
    router.push(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
  }, [filters, urlParams, router, pathname]);

  /** Drop one chip. Clearing an AI filter clears everything it set, because the
   *  parts of an AI filter are not separately meaningful. */
  const removeChip = useCallback((keys: string[]) => {
    const sp = new URLSearchParams(urlParams.toString());
    for (const k of keys) sp.delete(k);
    // Any hand-edit invalidates the AI filter's name.
    if (!keys.includes('label')) sp.delete('label');
    sp.delete('limit');
    const qs = sp.toString();
    router.push(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
  }, [urlParams, router, pathname]);

  const clearAll = useCallback(() => {
    const sp = new URLSearchParams(urlParams.toString());
    for (const k of FILTER_KEYS) sp.delete(k);
    sp.delete('limit');
    const qs = sp.toString();
    router.push(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
  }, [urlParams, router, pathname]);

  // ── Quick-jump dropdown ────────────────────────────────────────────────────
  // Carries the active filters so the dropdown and the list below always agree
  // on what is in scope.
  const runSearch = useCallback(async (term: string) => {
    if (term.trim().length < 2) { setResults([]); setOpen(false); return; }
    setLoading(true);
    try {
      const p = new URLSearchParams(urlParams.toString());
      p.set('q', term);
      p.delete('limit');
      const res  = await fetch(`/api/search?${p.toString()}`);
      const data = await res.json() as Result[];
      setResults(data);
      setOpen(true);
    } catch { /* ignore */ }
    finally { setLoading(false); }
  }, [urlParams]);

  useEffect(() => {
    clearTimeout(debounceRef.current);
    if (query.length < 2) { setResults([]); setOpen(false); return; }
    debounceRef.current = setTimeout(() => runSearch(query), 350);
    return () => clearTimeout(debounceRef.current);
  }, [query, runSearch]);

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

  // ── Ask AI ─────────────────────────────────────────────────────────────────
  const askAi = useCallback(async () => {
    const question = query.trim();
    if (question.length < 2 || aiLoading) return;
    setAiLoading(true);
    setAiError(null);
    setOpen(false);
    try {
      const res = await fetch('/api/search/ai-filter', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ question }),
      });
      const data = await res.json() as { params?: Record<string, string>; error?: string };
      if (!res.ok || !data.params) {
        setAiError(data.error ?? "Couldn't interpret that — try rephrasing");
        return;
      }
      const sp = new URLSearchParams(urlParams.toString());
      for (const k of FILTER_KEYS) sp.delete(k);
      sp.delete('limit');
      for (const [k, v] of Object.entries(data.params)) sp.set(k, v);
      const qs = sp.toString();
      router.push(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
      setQuery('');
      setFiltersOpen(false);
    } catch {
      setAiError('AI search is unavailable right now');
    } finally {
      setAiLoading(false);
    }
  }, [query, aiLoading, urlParams, router, pathname]);

  // The error is transient — it answers one click and then gets out of the way.
  useEffect(() => {
    if (!aiError) return;
    const t = setTimeout(() => setAiError(null), 5000);
    return () => clearTimeout(t);
  }, [aiError]);

  const canAsk = query.trim().length >= 2 && !aiLoading;

  return (
    <div ref={containerRef} className="relative w-full">
      <div className="relative">
        <Search className="absolute left-3.5 top-1/2 -translate-y-1/2 w-4 h-4 text-ftc-mid pointer-events-none" />
        <input
          type="text"
          value={query}
          onChange={e => setQuery(e.target.value)}
          onFocus={() => results.length > 0 && setOpen(true)}
          onKeyDown={e => {
            if (e.key === 'Escape') { setOpen(false); setFiltersOpen(false); }
            // Enter on the search box asks AI — the dropdown is already live as
            // you type, so the keystroke is free for the more useful action.
            if (e.key === 'Enter') { e.preventDefault(); askAi(); }
          }}
          placeholder="Search meetings, or ask AI…"
          className="w-full pl-10 pr-[8.5rem] py-2.5 text-sm text-ftc-gray bg-surface-card border border-surface-border
                     rounded-xl focus:outline-none focus:border-brand/50 transition-colors"
        />

        {/* Inline controls, mirroring the CRM pipeline search bar */}
        <div className="absolute right-2 inset-y-0 flex items-center gap-0.5">
          {loading && (
            <Loader2 className="w-3.5 h-3.5 mr-1 text-ftc-mid animate-spin" />
          )}
          {query && !loading && (
            <button
              type="button"
              onClick={() => { setQuery(''); setResults([]); setOpen(false); }}
              title="Clear"
              className="h-6 w-6 flex items-center justify-center rounded text-ftc-mid hover:text-ftc-gray transition-colors touch-manipulation"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          )}
          <button
            type="button"
            onClick={askAi}
            disabled={!canAsk}
            title="Ask AI — turn your search into a filter"
            className={`relative h-6 flex items-center gap-1 rounded px-1.5 text-[11px] font-medium text-brand transition-colors touch-manipulation ${
              canAsk ? 'hover:bg-brand/10' : 'opacity-70'
            }`}
          >
            {aiLoading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Sparkles className="w-3.5 h-3.5" />}
            <span>Ask AI</span>
          </button>
          <button
            type="button"
            onClick={() => { setFiltersOpen(o => !o); setOpen(false); }}
            title="Filter"
            aria-label="Filters"
            className={`relative h-6 w-6 flex items-center justify-center rounded transition-colors touch-manipulation ${
              filtersOpen || active ? 'text-brand' : 'text-ftc-mid hover:text-ftc-gray'
            }`}
          >
            <SlidersHorizontal className="w-3.5 h-3.5" />
            {chips.length > 0 && (
              <span className="absolute -top-1 -right-1 h-3.5 min-w-[0.875rem] px-0.5 rounded-full bg-brand text-white text-[8px] flex items-center justify-center font-bold">
                {chips.length}
              </span>
            )}
          </button>
        </div>
      </div>

      {aiError && (
        <p className="mt-1.5 text-[11px] text-brand">{aiError}</p>
      )}

      {/* ── Active filters ── */}
      {chips.length > 0 && (
        <div className="mt-2 flex flex-wrap items-center gap-1.5">
          {chips.map(chip => (
            <button
              key={chip.key}
              type="button"
              onClick={() => removeChip(chip.keys)}
              title="Remove filter"
              className="group flex items-center gap-1 pl-2.5 pr-1.5 py-1 rounded-lg text-[11px] font-medium
                         bg-brand/10 text-brand hover:bg-brand/20 transition-colors touch-manipulation"
            >
              {chip.key === 'label' && <Sparkles className="w-3 h-3" />}
              {chip.label}
              <X className="w-3 h-3 opacity-60 group-hover:opacity-100" />
            </button>
          ))}
          <button
            type="button"
            onClick={clearAll}
            className="text-[11px] text-ftc-mid hover:text-ftc-gray transition-colors px-1.5 py-1"
          >
            Clear all
          </button>
        </div>
      )}

      {/* ── Filters panel ── */}
      {filtersOpen && (
        <div className="absolute top-full mt-1.5 right-0 z-40 w-80 rounded-2xl border border-surface-border bg-surface-card shadow-xl p-4 space-y-4 animate-in fade-in-0 zoom-in-95 slide-in-from-top-2 duration-150">
          <div className="flex items-center justify-between">
            <p className="text-xs font-semibold uppercase tracking-widest text-ftc-mid">Filters</p>
            {active && (
              <button type="button" onClick={clearAll} className="text-[11px] text-brand hover:underline">
                Clear
              </button>
            )}
          </div>

          {/* Source */}
          <div>
            <p className="text-xs font-medium text-ftc-gray mb-1.5">Source</p>
            <div className="flex flex-wrap gap-1.5">
              <button type="button" onClick={() => applyFilters({ source: undefined, label: undefined })} className={chipClass(!filters.source)}>All</button>
              <button type="button" onClick={() => applyFilters({ source: 'web',   label: undefined })} className={chipClass(filters.source === 'web')}>In person</button>
              <button type="button" onClick={() => applyFilters({ source: 'teams', label: undefined })} className={chipClass(filters.source === 'teams')}>Online</button>
            </div>
          </div>

          {/* Meeting type */}
          <div>
            <p className="text-xs font-medium text-ftc-gray mb-1.5">Meeting type</p>
            <div className="flex flex-wrap gap-1.5">
              <button type="button" onClick={() => applyFilters({ type: undefined, label: undefined })} className={chipClass(!filters.type)}>All</button>
              {MEETING_TYPES.map(t => (
                <button
                  key={t}
                  type="button"
                  onClick={() => applyFilters({ type: t as MeetingTypeFilter, label: undefined })}
                  className={chipClass(filters.type === t)}
                >
                  {MEETING_TYPE_LABELS[t]}
                </button>
              ))}
            </div>
          </div>

          {/* Status */}
          <div>
            <p className="text-xs font-medium text-ftc-gray mb-1.5">Status</p>
            <div className="flex flex-wrap gap-1.5">
              <button type="button" onClick={() => applyFilters({ status: undefined, label: undefined })} className={chipClass(!filters.status)}>All</button>
              {STATUS_FILTERS.map(s => (
                <button
                  key={s}
                  type="button"
                  onClick={() => applyFilters({ status: s as StatusFilter, label: undefined })}
                  className={chipClass(filters.status === s)}
                >
                  {STATUS_LABELS[s]}
                </button>
              ))}
            </div>
          </div>

          {/* Date */}
          <div>
            <p className="text-xs font-medium text-ftc-gray mb-1.5">Date</p>
            <div className="flex flex-wrap gap-1.5">
              <button
                type="button"
                onClick={() => applyFilters({ date: undefined, from: undefined, to: undefined, label: undefined })}
                className={chipClass(!filters.date && !filters.from && !filters.to)}
              >
                Any time
              </button>
              {(Object.keys(DATE_LABELS) as DateFilter[]).map(d => (
                <button
                  key={d}
                  type="button"
                  onClick={() => applyFilters({ date: d, from: undefined, to: undefined, label: undefined })}
                  className={chipClass(filters.date === d)}
                >
                  {DATE_LABELS[d]}
                </button>
              ))}
            </div>
          </div>

          {/* Sort */}
          <div>
            <p className="text-xs font-medium text-ftc-gray mb-1.5">Sort</p>
            <div className="flex flex-wrap gap-1.5">
              {(Object.keys(SORT_LABELS) as SortFilter[]).map(s => (
                <button
                  key={s}
                  type="button"
                  onClick={() => applyFilters({ sort: s, label: undefined })}
                  className={chipClass(filters.sort === s)}
                >
                  {SORT_LABELS[s]}
                </button>
              ))}
            </div>
          </div>

          {/* Only meetings that produced follow-ups */}
          <button
            type="button"
            onClick={() => applyFilters({ hasActions: !filters.hasActions, label: undefined })}
            className="flex items-center gap-2 w-full text-left"
          >
            <span className={`w-4 h-4 rounded border flex items-center justify-center transition-colors ${
              filters.hasActions ? 'bg-brand border-brand' : 'border-surface-border'
            }`}>
              {filters.hasActions && (
                <svg className="w-2.5 h-2.5 text-white" fill="none" stroke="currentColor" strokeWidth={3} viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                </svg>
              )}
            </span>
            <span className="text-xs text-ftc-gray">Only meetings with action items</span>
          </button>

          {canSeeAll && (
            <p className="text-[11px] text-surface-muted leading-relaxed">
              Filters apply on top of the Company / Assignee selected in the dropdowns above.
            </p>
          )}
        </div>
      )}

      {/* ── Quick-jump results ── */}
      {open && (
        <div className="absolute top-full mt-1.5 left-0 right-0 z-30 rounded-2xl border border-surface-border bg-surface-card shadow-xl overflow-hidden animate-in fade-in-0 zoom-in-95 slide-in-from-top-2 duration-150">
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
                        <span className="flex-shrink-0 text-[9px] font-semibold px-1.5 py-0.5 rounded bg-[#4b53bc]/15 text-[#6264A7]">Online</span>
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
