// Instant skeleton for the home list while server data loads.
export default function HomeLoading() {
  return (
    <div className="min-h-screen flex flex-col bg-surface">
      <header className="sticky top-0 z-20 border-b border-surface-border bg-surface/80 backdrop-blur-md">
        <div className="max-w-5xl mx-auto px-4 py-3 flex items-center justify-between">
          <div className="h-12 w-32 rounded-lg bg-surface-raised animate-pulse" />
          <div className="h-9 w-40 rounded-xl bg-surface-raised animate-pulse" />
        </div>
      </header>
      <main className="max-w-5xl mx-auto w-full px-4 py-8 flex-1 space-y-6">
        <div className="grid grid-cols-3 gap-3">
          {Array.from({ length: 3 }).map((_, i) => (
            <div key={i} className="h-20 rounded-2xl border border-surface-border bg-surface-card animate-pulse" />
          ))}
        </div>
        <div className="space-y-3">
          {Array.from({ length: 5 }).map((_, i) => (
            <div key={i} className="h-28 rounded-2xl border border-surface-border bg-surface-card animate-pulse" />
          ))}
        </div>
      </main>
    </div>
  );
}
