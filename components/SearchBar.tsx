'use client';

import { useState, useRef, useEffect, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';

interface Result {
  id:          string;
  title:       string;
  createdAt:   string;
  meetingType: string;
  source:      string;
  excerpt:     string;
}

function formatDate(d: string) {
  return new Date(d).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
}

export default function SearchBar() {
  const [query,    setQuery]    = useState('');
  const [results,  setResults]  = useState<Result[]>([]);
  const [open,     setOpen]     = useState(false);
  const [loading,  setLoading]  = useState(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout>>(undefined);
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

  // Close on outside click
  useEffect(() => {
    function handle(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener('mousedown', handle);
    return () => document.removeEventListener('mousedown', handle);
  }, []);

  return (
    <div ref={containerRef} className="relative w-full max-w-lg">
      <div className="relative">
        <svg
          className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-ftc-mid pointer-events-none"
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
          placeholder="Search recordings…"
          className="w-full pl-9 pr-4 py-2 text-sm text-ftc-gray bg-surface-card border border-surface-border
                     rounded-xl focus:outline-none focus:border-brand/50 transition-colors"
        />
        {loading && (
          <span className="absolute right-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 rounded-full border-2 border-ftc-mid/30 border-t-ftc-mid animate-spin" />
        )}
      </div>

      {open && (
        <div className="absolute top-full mt-1.5 left-0 right-0 z-30 rounded-2xl border border-surface-border bg-surface-card shadow-xl overflow-hidden">
          {results.length === 0 ? (
            <p className="text-xs text-ftc-mid px-4 py-3">No results found.</p>
          ) : (
            <ul>
              {results.map(r => (
                <li key={r.id}>
                  <Link
                    href={`/recordings/${r.id}`}
                    onClick={() => { setOpen(false); setQuery(''); }}
                    className="flex flex-col gap-0.5 px-4 py-3 hover:bg-surface-raised transition-colors"
                  >
                    <span className="text-sm font-medium text-ftc-gray">{r.title}</span>
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
