import Link from 'next/link';
import { Suspense } from 'react';
import { prisma } from '@/lib/db';
import QuickDeleteButton from '@/components/QuickDeleteButton';
import AssignFolderButton from '@/components/AssignFolderButton';
import FolderTabs from '@/components/FolderTabs';
import { estimateSeconds } from '@/lib/finalize-recording';

export const dynamic = 'force-dynamic';

function formatDate(date: Date) {
  return new Intl.DateTimeFormat('en-GB', {
    day: 'numeric', month: 'short', year: 'numeric',
    hour: '2-digit', minute: '2-digit',
  }).format(new Date(date));
}

function formatEta(seconds: number): string {
  if (seconds < 60) return '< 1 min';
  const mins = Math.ceil(seconds / 60);
  return `~${mins} min`;
}

function safeJson<T>(value: string | null | undefined, fallback: T): T {
  if (!value) return fallback;
  try { return JSON.parse(value) as T; } catch { return fallback; }
}

function MicIcon({ className }: { className?: string }) {
  return (
    <svg className={className} fill="currentColor" viewBox="0 0 24 24">
      <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z" />
      <path d="M19 10v2a7 7 0 0 1-14 0v-2H3v2a9 9 0 0 0 8 8.94V22H9v2h6v-2h-2v-1.06A9 9 0 0 0 21 12v-2h-2z" />
    </svg>
  );
}

export default async function Home({
  searchParams,
}: {
  searchParams: { folder?: string };
}) {
  const activeFolderId = searchParams.folder ?? null;

  let folders: { id: string; name: string; _count: { recordings: number } }[] = [];
  let recordings: Awaited<ReturnType<typeof prisma.recording.findMany<{
    include: { summary: true; _count: { select: { chunks: true } } };
  }>>> = [];

  try {
    [folders, recordings] = await Promise.all([
      prisma.folder.findMany({
        orderBy: { createdAt: 'asc' },
        include: { _count: { select: { recordings: true } } },
      }),
      prisma.recording.findMany({
        where: activeFolderId ? { folderId: activeFolderId } : {},
        include: { summary: true, _count: { select: { chunks: true } } },
        orderBy: { createdAt: 'desc' },
      }),
    ]);
  } catch { /* DB not ready */ }

  const allCount = await prisma.recording.count().catch(() => 0);
  const completed = await prisma.recording.count({ where: { status: 'completed' } }).catch(() => 0);
  const thisWeek  = await prisma.recording.count({
    where: { createdAt: { gte: new Date(Date.now() - 7 * 86400_000) } },
  }).catch(() => 0);

  const folderList = folders.map((f) => ({ id: f.id, name: f.name }));

  return (
    <div className="min-h-screen flex flex-col bg-surface">
      {/* Nav */}
      <header className="sticky top-0 z-20 border-b border-surface-border bg-surface/80 backdrop-blur-md">
        <div className="max-w-5xl mx-auto px-4 py-3 flex items-center justify-between">
          <div className="flex items-center h-12">
            <img src="/logo.png" alt="FTC Transcribe" className="h-full object-contain" />
          </div>
          <Link href="/record" className="btn-brand flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-semibold text-white touch-manipulation">
            <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={2.5} viewBox="0 0 24 24">
              <circle cx="12" cy="12" r="4" fill="currentColor" stroke="none" />
              <circle cx="12" cy="12" r="9" />
            </svg>
            New Recording
          </Link>
        </div>
      </header>

      <main className="max-w-5xl mx-auto w-full px-4 py-8 flex-1">

        {/* Stats */}
        {allCount > 0 && (
          <div className="grid grid-cols-3 gap-3 mb-8">
            {[
              { label: 'Total', value: allCount },
              { label: 'Complete', value: completed },
              { label: 'This week', value: thisWeek },
            ].map(({ label, value }) => (
              <div key={label} className="rounded-2xl border border-surface-border bg-surface-card p-4 text-center">
                <p className="text-2xl font-bold text-ftc-gray">{value}</p>
                <p className="text-xs mt-0.5 text-ftc-mid">{label}</p>
              </div>
            ))}
          </div>
        )}

        {/* Folder tabs */}
        <Suspense>
          <FolderTabs folders={folders} />
        </Suspense>

        <h2 className="text-xs font-semibold uppercase tracking-widest text-ftc-mid mb-4">
          {activeFolderId ? (folders.find((f) => f.id === activeFolderId)?.name ?? 'Folder') : 'All Recordings'}
        </h2>

        {recordings.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-24 gap-5">
            <div className="w-20 h-20 rounded-2xl border border-surface-border bg-surface-card flex items-center justify-center">
              <MicIcon className="w-9 h-9 text-surface-muted" />
            </div>
            <div className="text-center">
              <p className="font-semibold text-ftc-gray mb-1">
                {activeFolderId ? 'No recordings in this folder' : 'No recordings yet'}
              </p>
              <p className="text-sm text-ftc-mid">
                {activeFolderId ? 'Move recordings here using the folder icon on each card' : 'Tap New Recording to capture your first meeting'}
              </p>
            </div>
            {!activeFolderId && (
              <Link href="/record" className="btn-brand px-6 py-3 rounded-2xl text-sm font-semibold text-white touch-manipulation">
                Start Recording
              </Link>
            )}
          </div>
        ) : (
          <ul className="space-y-3">
            {recordings.map((rec) => {
              const actions = safeJson<string[]>(rec.summary?.actionItems, []);
              const points  = safeJson<string[]>(rec.summary?.keyPoints,   []);
              const isQueued = rec.status === 'uploading' || rec.status === 'queued' || rec.status === 'processing';
              const chunkCount = rec._count.chunks;
              const eta = isQueued ? formatEta(estimateSeconds(chunkCount)) : null;

              return (
                <li key={rec.id} className="relative">
                  <Link
                    href={`/recordings/${rec.id}`}
                    className="flex flex-col gap-3 rounded-2xl border border-surface-border bg-surface-card p-5 pr-20 transition-colors hover:border-surface-muted active:scale-[0.99] touch-manipulation"
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div className="flex items-center gap-3 min-w-0">
                        <div className="w-9 h-9 rounded-xl bg-surface-raised flex-shrink-0 flex items-center justify-center">
                          <MicIcon className="w-5 h-5 text-brand" />
                        </div>
                        <div className="min-w-0">
                          <p className="font-semibold text-sm text-ftc-gray truncate">{rec.title}</p>
                          <p className="text-xs mt-0.5 text-ftc-mid">{formatDate(rec.createdAt)}</p>
                        </div>
                      </div>
                      <div className="flex flex-col items-end gap-1 flex-shrink-0">
                        <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${
                          rec.status === 'completed' ? 'bg-emerald-500/10 text-emerald-400'
                          : rec.status === 'failed'  ? 'bg-red-500/10 text-red-400'
                          : isQueued                 ? 'bg-blue-500/10 text-blue-400'
                          : 'bg-amber-500/10 text-amber-400'
                        }`}>
                          {rec.status === 'processing' ? 'analysing'
                            : (rec.status === 'uploading' || rec.status === 'queued') ? 'queued'
                            : rec.status}
                        </span>
                        {eta && (
                          <span className="text-[10px] text-ftc-mid">{eta}</span>
                        )}
                      </div>
                    </div>

                    {rec.summary && (
                      <p className="text-sm leading-relaxed line-clamp-2 text-ftc-mid">
                        {rec.summary.overview}
                      </p>
                    )}

                    {(actions.length > 0 || points.length > 0) && (
                      <div className="flex items-center gap-4 text-xs text-surface-muted">
                        {actions.length > 0 && (
                          <span className="flex items-center gap-1">
                            <svg className="w-3.5 h-3.5 text-emerald-500" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
                              <path strokeLinecap="round" strokeLinejoin="round" d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
                            </svg>
                            {actions.length} action{actions.length !== 1 ? 's' : ''}
                          </span>
                        )}
                        {points.length > 0 && (
                          <span className="flex items-center gap-1">
                            <svg className="w-3.5 h-3.5 text-brand" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
                              <path strokeLinecap="round" strokeLinejoin="round" d="M13 10V3L4 14h7v7l9-11h-7z" />
                            </svg>
                            {points.length} key point{points.length !== 1 ? 's' : ''}
                          </span>
                        )}
                      </div>
                    )}
                  </Link>

                  {/* Action buttons outside the Link */}
                  <div className="absolute top-1/2 right-3 -translate-y-1/2 flex flex-col gap-1 items-center">
                    <AssignFolderButton
                      recordingId={rec.id}
                      currentFolderId={rec.folderId}
                      folders={folderList}
                    />
                    <QuickDeleteButton id={rec.id} />
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </main>
      <div className="pb-safe" />
    </div>
  );
}
