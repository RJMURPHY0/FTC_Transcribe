// Instant skeleton while the recording detail loads — Next.js prefetches this
// boundary from list links, so tapping a meeting paints immediately.
export default function RecordingLoading() {
  return (
    <div className="min-h-screen flex flex-col bg-surface">
      <header className="sticky top-0 z-20 border-b border-surface-border bg-surface/80 backdrop-blur-md">
        <div className="max-w-6xl mx-auto px-4 py-3 flex items-center gap-3">
          <div className="h-8 w-16 rounded-xl bg-surface-raised animate-pulse" />
          <div className="h-5 w-64 rounded-lg bg-surface-raised animate-pulse" />
        </div>
      </header>
      <main className="max-w-6xl mx-auto w-full px-4 py-6 flex-1">
        <div className="grid gap-6 lg:grid-cols-[1fr_1fr]">
          <div className="space-y-3">
            <div className="h-4 w-32 rounded bg-surface-raised animate-pulse" />
            {Array.from({ length: 6 }).map((_, i) => (
              <div key={i} className="rounded-2xl border border-surface-border bg-surface-card p-4 space-y-2">
                <div className="h-3 w-24 rounded bg-surface-raised animate-pulse" />
                <div className="h-3 w-full rounded bg-surface-raised animate-pulse" />
                <div className="h-3 w-3/4 rounded bg-surface-raised animate-pulse" />
              </div>
            ))}
          </div>
          <div className="space-y-3">
            <div className="h-4 w-24 rounded bg-surface-raised animate-pulse" />
            <div className="rounded-2xl border border-surface-border bg-surface-card p-5 space-y-3">
              {Array.from({ length: 8 }).map((_, i) => (
                <div key={i} className="h-3 rounded bg-surface-raised animate-pulse" style={{ width: `${90 - (i % 4) * 15}%` }} />
              ))}
            </div>
          </div>
        </div>
      </main>
    </div>
  );
}
