import Link from 'next/link';
import { Suspense } from 'react';
import { prisma } from '@/lib/db';
import NewFolderButton from '@/components/NewFolderButton';
import FolderActions from '@/components/FolderActions';
import RecordingsList from '@/components/RecordingsList';
import LogoutButton from '@/components/LogoutButton';
import { estimateSeconds } from '@/lib/finalize-recording';

export const dynamic = 'force-dynamic';

function formatEta(seconds: number): string {
  if (seconds < 60) return '< 1 min';
  return `~${Math.ceil(seconds / 60)} min`;
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
        // In a folder: show that folder's recordings. In All: show unassigned only.
        where: activeFolderId ? { folderId: activeFolderId } : { folderId: null },
        include: { summary: true, _count: { select: { chunks: true } } },
        orderBy: { createdAt: 'desc' },
      }),
    ]);
  } catch { /* DB not ready */ }

  const allCount  = await prisma.recording.count().catch(() => 0);
  const completed = await prisma.recording.count({ where: { status: 'completed' } }).catch(() => 0);
  const thisWeek  = await prisma.recording.count({
    where: { createdAt: { gte: new Date(Date.now() - 7 * 86400_000) } },
  }).catch(() => 0);

  const folderList = folders.map((f) => ({ id: f.id, name: f.name }));
  const activeFolder = activeFolderId ? folders.find(f => f.id === activeFolderId) : null;

  return (
    <div className="min-h-screen flex flex-col bg-surface">
      {/* Nav */}
      <header className="sticky top-0 z-20 border-b border-surface-border bg-surface/80 backdrop-blur-md">
        <div className="max-w-5xl mx-auto px-4 py-3 flex items-center justify-between">
          <div className="flex items-center h-12">
            <img src="/logo.png" alt="FTC Transcribe" className="h-full object-contain" />
          </div>
          <div className="flex items-center gap-2">
            <LogoutButton />
            <Link
              href="/settings"
              className="p-2 rounded-xl text-ftc-mid hover:text-ftc-gray hover:bg-surface-raised transition-colors touch-manipulation"
              title="Settings"
            >
              <svg className="w-5 h-5" fill="none" stroke="currentColor" strokeWidth={1.75} viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" d="M9.594 3.94c.09-.542.56-.94 1.11-.94h2.593c.55 0 1.02.398 1.11.94l.213 1.281c.063.374.313.686.645.87.074.04.147.083.22.127.325.196.72.257 1.075.124l1.217-.456a1.125 1.125 0 0 1 1.37.49l1.296 2.247a1.125 1.125 0 0 1-.26 1.431l-1.003.827c-.293.241-.438.613-.43.992a7.723 7.723 0 0 1 0 .255c-.008.378.137.75.43.991l1.004.827c.424.35.534.955.26 1.43l-1.298 2.247a1.125 1.125 0 0 1-1.369.491l-1.217-.456c-.355-.133-.75-.072-1.076.124a6.47 6.47 0 0 1-.22.128c-.331.183-.581.495-.644.869l-.213 1.281c-.09.543-.56.94-1.11.94h-2.594c-.55 0-1.019-.398-1.11-.94l-.213-1.281c-.062-.374-.312-.686-.644-.87a6.52 6.52 0 0 1-.22-.127c-.325-.196-.72-.257-1.076-.124l-1.217.456a1.125 1.125 0 0 1-1.369-.49l-1.297-2.247a1.125 1.125 0 0 1 .26-1.431l1.004-.827c.292-.24.437-.613.43-.991a6.932 6.932 0 0 1 0-.255c.007-.38-.138-.751-.43-.992l-1.004-.827a1.125 1.125 0 0 1-.26-1.43l1.297-2.247a1.125 1.125 0 0 1 1.37-.491l1.216.456c.356.133.751.072 1.076-.124.072-.044.146-.086.22-.128.332-.183.582-.495.644-.869l.214-1.28Z" />
                <path strokeLinecap="round" strokeLinejoin="round" d="M15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0Z" />
              </svg>
            </Link>
            <Link href="/record" className="btn-brand flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-semibold text-white touch-manipulation">
              <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={2.5} viewBox="0 0 24 24">
                <circle cx="12" cy="12" r="4" fill="currentColor" stroke="none" />
                <circle cx="12" cy="12" r="9" />
              </svg>
              New Recording
            </Link>
          </div>
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

        {/* ── Breadcrumb / heading row ── */}
        <div className="flex items-center justify-between gap-3 mb-5">
          {activeFolderId ? (
            /* Folder view breadcrumb */
            <div className="flex items-center gap-2 min-w-0">
              <Link
                href="/"
                className="flex items-center gap-1 text-sm text-ftc-mid hover:text-ftc-gray transition-colors flex-shrink-0"
              >
                <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M15 19l-7-7 7-7" />
                </svg>
                All
              </Link>
              <svg className="w-3.5 h-3.5 text-surface-muted flex-shrink-0" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
              </svg>
              <div className="flex items-center gap-2 min-w-0">
                <svg className="w-4 h-4 text-brand flex-shrink-0" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M2.25 12.75V12A2.25 2.25 0 014.5 9.75h15A2.25 2.25 0 0121.75 12v.75m-8.69-6.44l-2.12-2.12a1.5 1.5 0 00-1.061-.44H4.5A2.25 2.25 0 002.25 6v8.25" />
                </svg>
                <span className="font-semibold text-sm text-ftc-gray truncate">
                  {activeFolder?.name ?? 'Folder'}
                </span>
                <span className="text-xs text-ftc-mid flex-shrink-0">
                  ({activeFolder?._count.recordings ?? 0})
                </span>
              </div>
              {activeFolder && (
                <Suspense>
                  <FolderActions id={activeFolderId} name={activeFolder.name} isActive />
                </Suspense>
              )}
            </div>
          ) : (
            /* All view heading */
            <h2 className="text-xs font-semibold uppercase tracking-widest text-ftc-mid">
              All Recordings
            </h2>
          )}

          {/* New folder button — only shown in All view */}
          {!activeFolderId && (
            <Suspense>
              <NewFolderButton />
            </Suspense>
          )}
        </div>

        {/* ── Folder cards (All view only) ── */}
        {!activeFolderId && folders.length > 0 && (
          <ul className="space-y-2 mb-6">
            {folders.map((folder) => (
              <li key={folder.id}>
                <Link
                  href={`/?folder=${folder.id}`}
                  className="group flex items-center gap-4 rounded-2xl border border-surface-border bg-surface-card px-5 py-4 transition-colors hover:border-surface-muted active:scale-[0.99] touch-manipulation"
                >
                  {/* Folder icon */}
                  <div className="w-9 h-9 rounded-xl bg-brand/10 flex-shrink-0 flex items-center justify-center">
                    <svg className="w-5 h-5 text-brand" fill="none" stroke="currentColor" strokeWidth={1.75} viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" d="M2.25 12.75V12A2.25 2.25 0 014.5 9.75h15A2.25 2.25 0 0121.75 12v.75m-8.69-6.44l-2.12-2.12a1.5 1.5 0 00-1.061-.44H4.5A2.25 2.25 0 002.25 6v8.25" />
                    </svg>
                  </div>

                  <div className="flex-1 min-w-0">
                    <p className="font-semibold text-sm text-ftc-gray">{folder.name}</p>
                    <p className="text-xs text-ftc-mid mt-0.5">
                      {folder._count.recordings} recording{folder._count.recordings !== 1 ? 's' : ''}
                    </p>
                  </div>

                  <Suspense>
                    <FolderActions id={folder.id} name={folder.name} isActive={false} />
                  </Suspense>

                  <svg className="w-4 h-4 text-surface-muted group-hover:text-ftc-mid transition-colors flex-shrink-0" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
                  </svg>
                </Link>
              </li>
            ))}
          </ul>
        )}

        {/* ── Recording list label when in All view with folders ── */}
        {!activeFolderId && folders.length > 0 && (
          <h3 className="text-xs font-semibold uppercase tracking-widest text-ftc-mid mb-4">
            Unassigned
          </h3>
        )}

        {/* ── Recording cards ── */}
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
                {activeFolderId
                  ? 'Move recordings here using the folder icon on each card'
                  : 'Tap New Recording to capture your first meeting'}
              </p>
            </div>
            {!activeFolderId && (
              <Link href="/record" className="btn-brand px-6 py-3 rounded-2xl text-sm font-semibold text-white touch-manipulation">
                Start Recording
              </Link>
            )}
          </div>
        ) : (
          <RecordingsList
            recordings={recordings.map((rec) => {
              const isQueued = rec.status === 'uploading' || rec.status === 'queued' || rec.status === 'processing';
              return {
                id: rec.id,
                title: rec.title,
                createdAt: rec.createdAt.toISOString(),
                status: rec.status,
                folderId: rec.folderId,
                summary: rec.summary
                  ? { overview: rec.summary.overview, keyPoints: rec.summary.keyPoints, actionItems: rec.summary.actionItems }
                  : null,
                _count: rec._count,
                eta: isQueued ? formatEta(estimateSeconds(rec._count.chunks)) : null,
              };
            })}
            folders={folderList}
          />
        )}
      </main>
      <div className="pb-safe" />
    </div>
  );
}
