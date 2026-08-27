import Link from 'next/link';
import { Suspense } from 'react';
import { prisma, withDbRetry } from '@/lib/db';
import NewFolderButton from '@/components/NewFolderButton';
import FolderActions from '@/components/FolderActions';
import RecordingsList from '@/components/RecordingsList';
import LogoutButton from '@/components/LogoutButton';
import AdminFilters from '@/components/AdminFilters';
import SearchBar from '@/components/SearchBar';
import { estimateSeconds } from '@/lib/estimate';
import { measuredCost } from '@/lib/finalize-progress';
import { getAuthUser } from '@/lib/auth';
import { ensureSchema } from '@/lib/ensure-schema';
import { SpotlightCard, GlowCard } from '@/components/ui/spotlight-card';
import {
  getOrganisations,
  getOrgTeams,
  getOrgMembers,
  getAllOrgMembers,
  getMemberUserIds,
  getMemberNames,
} from '@/lib/contacts-db';

export const dynamic = 'force-dynamic';

// ── Async server component so org/member data streams in without blocking the page ─
async function AdminFiltersLoader({
  orgs,
  activeOrgId,
  activeTeamId,
  activeAssigneeId,
}: {
  // null = fetch inside this Suspense boundary (keeps the external Contacts
  // API call off the page's critical path)
  orgs: import('@/lib/contacts-db').Org[] | null;
  activeOrgId: string | null;
  activeTeamId: string | null;
  activeAssigneeId: string | null;
}) {
  const [orgList, members] = await Promise.all([
    orgs ? Promise.resolve(orgs) : getOrganisations(),
    activeOrgId ? getOrgMembers(activeOrgId, activeTeamId) : getAllOrgMembers(),
  ]);
  return (
    <AdminFilters
      orgs={orgList}
      members={members}
      activeOrgId={activeOrgId}
      activeAssigneeId={activeAssigneeId}
    />
  );
}

function AdminFiltersFallback() {
  return (
    <div className="flex items-center gap-2">
      <div className="h-8 w-36 rounded-xl bg-surface-raised animate-pulse" />
      <div className="h-8 w-28 rounded-xl bg-surface-raised animate-pulse" />
    </div>
  );
}

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
  searchParams: { folder?: string; source?: string; org?: string; team?: string; assignee?: string; limit?: string };
}) {
  const activeFolderId   = searchParams.folder ?? null;
  const activeSource     = searchParams.source === 'teams' ? 'teams' : searchParams.source === 'web' ? 'web' : null;
  const activeOrgId      = searchParams.org ?? null;
  const activeTeamId     = searchParams.team ?? null;
  const activeAssigneeId = searchParams.assignee ?? null;

  // Paginate the recordings list — previously every row + summary was loaded on
  // every render. take one extra to know whether a "Show more" link is needed.
  const PAGE_SIZE = 30;
  const limit = Math.max(PAGE_SIZE, parseInt(searchParams.limit ?? '', 10) || PAGE_SIZE);

  await ensureSchema();

  const authUser  = await getAuthUser();
  const userId    = authUser?.id ?? null;
  const canSeeAll = authUser?.canSeeAll ?? false;

  // ── Who am I looking at? ──────────────────────────────────────────────────
  // Admins land on their OWN meetings, not the whole company. `assignee=all`
  // widens to everyone; `assignee=<uid>` narrows to one person. Anyone without
  // canSeeAll is always scoped to themselves regardless of the URL.
  const viewingEveryone = canSeeAll && activeAssigneeId === 'all';
  const assigneeUserId  = canSeeAll && activeAssigneeId && activeAssigneeId !== 'all'
    ? activeAssigneeId
    : null;
  // Org/team views are an explicit request for other people's meetings.
  const inTeamScope = canSeeAll && (!!activeOrgId || !!activeTeamId);
  const scopedToSelf = !canSeeAll || (!viewingEveryone && !assigneeUserId && !inTeamScope);

  // ── Org data — external Contacts API call, only awaited when the breadcrumb
  // or team cards actually need it (org filter active). Otherwise the filter
  // dropdown fetches it inside its own Suspense boundary.
  // Both external Contacts calls fire together — previously they ran one after
  // the other, doubling the network latency on the org-breadcrumb critical path.
  const [orgs, orgTeams] = canSeeAll && activeOrgId
    ? await Promise.all([getOrganisations(), getOrgTeams(activeOrgId)])
    : [null, [] as Awaited<ReturnType<typeof getOrgTeams>>];
  const activeOrg = orgs?.find(o => o.id === activeOrgId) ?? null;

  // ── Recording scope ───────────────────────────────────────────────────────
  // Every widened view is additionally bounded by the viewer's own
  // organisation. `canSeeAll` grants sight of colleagues, not of other
  // customers, and the super admin is the single deliberate exception. Without
  // this, "assignee=all" in the URL would list every tenant's meetings.
  const tenantScope: Record<string, unknown> = authUser?.isSuperAdmin
    ? {}
    : { orgId: authUser?.orgId ?? '__no_org__' };

  let userScope: Record<string, unknown> = {};

  if (scopedToSelf) {
    userScope = userId ? { userId } : {};
  } else if (assigneeUserId) {
    userScope = { userId: assigneeUserId, ...tenantScope };
  } else if (inTeamScope) {
    const ids = await getMemberUserIds(activeOrgId, activeTeamId);
    userScope = ids.length > 0 ? { userId: { in: ids }, ...tenantScope } : { userId: '__no_match__' };
  } else {
    // viewingEveryone → everyone in MY org, not everyone on the platform.
    userScope = tenantScope;
  }

  // In org view (org set, no team), we show org_teams as folder cards —
  // so we skip personal Transcribe folders and show all org recordings below.
  const inOrgFolderView = canSeeAll && !!activeOrgId && !activeTeamId && !activeAssigneeId && !activeFolderId;

  let folders: { id: string; name: string; _count: { recordings: number } }[] = [];
  let recordings: Awaited<ReturnType<typeof prisma.recording.findMany<{
    include: {
      summary: { select: { overview: true; keyPoints: true; actionItems: true } };
      _count: { select: { chunks: true } };
    };
  }>>> = [];

  // Stats scope mirrors the list scope, so the tiles always count what's shown.
  // null = unscoped (everyone / org / team views).
  const statsUserId = scopedToSelf ? userId : assigneeUserId;
  // Tiles count what the list shows, tenant boundary included. Null means
  // unscoped, which only the super admin ever reaches.
  const statsOrgId = authUser?.isSuperAdmin || scopedToSelf ? null : (authUser?.orgId ?? '__no_org__');
  const folderScope = inOrgFolderView
    ? { userId: '__no_match__' }                            // don't load personal folders in org view
    : scopedToSelf   ? (userId ? { userId } : {})
    : assigneeUserId ? { userId: assigneeUserId }
    : {};

  // The recordings query is the one that matters most: if it fails we must NOT
  // silently render "No recordings yet" (that reads as data-loss). We retry
  // transient blips and, only when it genuinely can't be loaded, flag an error
  // so the UI shows a Refresh prompt instead of a false empty state.
  let recordingsFailed = false;

  const [folderResult, recordingResult, countsRows] = await Promise.all([
    withDbRetry(() => prisma.folder.findMany({
      where: folderScope,
      orderBy: { createdAt: 'asc' },
      include: { _count: { select: { recordings: { where: { deletedAt: null } } } } },
    })).catch(() => []),
    withDbRetry(() => prisma.recording.findMany({
      where: {
        ...(activeFolderId ? { folderId: activeFolderId } : { folderId: null }),
        ...(activeSource   ? { source: activeSource }    : {}),
        ...userScope,
        deletedAt: null,
      },
      // Cards only render overview + key-point/action counts — pulling the full
      // summary row (topics, decisions, checked state) inflated every list load.
      include: {
        summary: { select: { overview: true, keyPoints: true, actionItems: true } },
        _count: { select: { chunks: true } },
      },
      orderBy: { createdAt: 'desc' },
      take: limit + 1,
    })).catch(() => { recordingsFailed = true; return []; }),
    // All four stat tiles in one round-trip instead of four parallel counts —
    // one pooled connection instead of four per home render.
    withDbRetry(() => prisma.$queryRaw<{ all: number; completed: number; week: number; teams: number }[]>`
      SELECT
        COUNT(*)::int                                                         AS "all",
        COUNT(*) FILTER (WHERE "status" = 'completed')::int                   AS "completed",
        COUNT(*) FILTER (WHERE "createdAt" >= NOW() - INTERVAL '7 days')::int AS "week",
        COUNT(*) FILTER (WHERE "source" = 'teams')::int                       AS "teams"
      FROM "Recording"
      WHERE "deletedAt" IS NULL
        AND (${statsUserId}::text IS NULL OR "userId" = ${statsUserId}::text)
        AND (${statsOrgId}::text IS NULL OR "orgId" = ${statsOrgId}::text)
    `).catch(() => []),
  ]);
  folders = folderResult;
  recordings = recordingResult;
  const { all: allCount = 0, completed = 0, week: thisWeek = 0, teams: teamsCount = 0 } = countsRows[0] ?? {};

  // Trim the sentinel extra row and decide whether to offer "Show more".
  const hasMore = recordings.length > limit;
  if (hasMore) recordings = recordings.slice(0, limit);

  // ── How long is left, for the rows still working ──────────────────────────
  // The wait is driven by chunks still to transcribe, not by meeting length, so
  // count the ones already done rather than inferring anything from duration.
  // One grouped query over the queued rows only; a settled list costs nothing.
  const queuedIds = recordings
    .filter(r => r.status === 'uploading' || r.status === 'queued' || r.status === 'processing')
    .map(r => r.id);

  const [finalizeCost, chunkProgress] = await Promise.all([
    queuedIds.length ? measuredCost(userId) : Promise.resolve(undefined),
    queuedIds.length
      ? prisma.chunkTranscript.groupBy({
          by: ['recordingId'],
          where: { recordingId: { in: queuedIds }, status: { in: ['succeeded', 'skipped'] } },
          _count: { _all: true },
        }).catch(() => [])
      : Promise.resolve([]),
  ]);
  const chunksDoneById = new Map(chunkProgress.map(r => [r.recordingId, r._count._all]));

  // ── Owner labels ──────────────────────────────────────────────────────────
  // Only looked up when the view spans more than one person — that's the only
  // time "who recorded this" is ambiguous, and it keeps the personal view at
  // one query. Also names the person in the heading for a single-assignee view.
  const showOwner = !scopedToSelf && !assigneeUserId;
  const nameIds = [
    ...(showOwner ? recordings.map(r => r.userId).filter((v): v is string => !!v) : []),
    ...(assigneeUserId ? [assigneeUserId] : []),
  ];
  const ownerNames = nameIds.length > 0 ? await getMemberNames(nameIds) : {};

  const scopeHeading = scopedToSelf
    ? 'My Recordings'
    : assigneeUserId
      ? `${ownerNames[assigneeUserId] ?? 'Team member'}'s Recordings`
      : 'All Recordings';

  // Keep the active assignee scope on every in-page link, so drilling into a
  // folder or a source tab doesn't silently snap back to your own meetings.
  const withScope = (params: Record<string, string>) => {
    const sp = new URLSearchParams(params);
    if (canSeeAll && activeAssigneeId) sp.set('assignee', activeAssigneeId);
    const qs = sp.toString();
    return qs ? `/?${qs}` : '/';
  };

  const showMoreParams = new URLSearchParams();
  if (activeFolderId)   showMoreParams.set('folder', activeFolderId);
  if (activeSource)     showMoreParams.set('source', activeSource);
  if (activeOrgId)      showMoreParams.set('org', activeOrgId);
  if (activeTeamId)     showMoreParams.set('team', activeTeamId);
  if (activeAssigneeId) showMoreParams.set('assignee', activeAssigneeId);
  showMoreParams.set('limit', String(limit + PAGE_SIZE));
  const showMoreHref = `/?${showMoreParams.toString()}`;

  const folderList   = folders.map(f => ({ id: f.id, name: f.name }));
  const activeFolder = activeFolderId ? folders.find(f => f.id === activeFolderId) : null;
  const activeTeam   = orgTeams.find(t => t.id === activeTeamId) ?? null;

  // ── Breadcrumb back URL ───────────────────────────────────────────────────
  // Team view: back to org view
  const teamBackHref = activeOrgId ? `/?org=${activeOrgId}` : '/';

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
              <GlowCard key={label} backdrop="rgb(var(--c-surface-card))" className="p-4 text-center ring-1 ring-surface-border">
                <p className="text-2xl font-bold text-ftc-gray">{value}</p>
                <p className="text-xs mt-0.5 text-ftc-mid">{label}</p>
              </GlowCard>
            ))}
          </div>
        )}

        {/* ── Super-admin filter dropdowns (members stream in separately) ── */}
        {canSeeAll && (
          <div className="mb-5">
            <Suspense fallback={<AdminFiltersFallback />}>
              <AdminFiltersLoader
                orgs={orgs}
                activeOrgId={activeOrgId}
                activeTeamId={activeTeamId}
                activeAssigneeId={activeAssigneeId}
              />
            </Suspense>
          </div>
        )}

        {/* Search — sits below the stats and (for super admins) the company /
            assignee dropdowns. Normal search is a plain text search; the filter
            button opens Ask-AI + source/type/date filters. */}
        {allCount > 0 && (
          <div className="mb-6">
            <SearchBar canSeeAll={canSeeAll} />
          </div>
        )}

        {/* ── Source filter tabs ── */}
        {!activeFolderId && !activeTeamId && teamsCount > 0 && (
          <div className="flex gap-2 mb-5">
            <Link
              href={withScope(activeOrgId ? { org: activeOrgId } : {})}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-sm font-medium transition-colors ${
                !activeSource ? 'bg-brand text-white' : 'text-ftc-mid hover:text-ftc-gray hover:bg-surface-raised border border-surface-border'
              }`}
            >
              All
            </Link>
            <Link
              href={withScope({ source: 'web', ...(activeOrgId ? { org: activeOrgId } : {}) })}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-sm font-medium transition-colors ${
                activeSource === 'web' ? 'bg-brand text-white' : 'text-ftc-mid hover:text-ftc-gray hover:bg-surface-raised border border-surface-border'
              }`}
            >
              <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" d="M17.982 18.725A7.488 7.488 0 0012 15.75a7.488 7.488 0 00-5.982 2.975m11.963 0a9 9 0 10-11.963 0m11.963 0A8.966 8.966 0 0112 21a8.966 8.966 0 01-5.982-2.275M15 9.75a3 3 0 11-6 0 3 3 0 016 0z" />
              </svg>
              In Person
            </Link>
            <Link
              href={withScope({ source: 'teams', ...(activeOrgId ? { org: activeOrgId } : {}) })}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-sm font-medium transition-colors ${
                activeSource === 'teams' ? 'bg-[#6264A7] text-white' : 'text-ftc-mid hover:text-ftc-gray hover:bg-surface-raised border border-surface-border'
              }`}
            >
              <svg className="w-3.5 h-3.5" fill="currentColor" viewBox="0 0 24 24">
                <path d="M12.5 2C11.1 2 10 3.1 10 4.5S11.1 7 12.5 7 15 5.9 15 4.5 13.9 2 12.5 2zm5 3c-.8 0-1.5.7-1.5 1.5S16.7 8 17.5 8 19 7.3 19 6.5 18.3 5 17.5 5zM3 9v10h2v-4h1.5c.3 1.2 1.3 2 2.5 2s2.2-.8 2.5-2H13v4h2V9H3zm8 4H5v-2h6v2z"/>
              </svg>
              Online
              <span className="text-[10px] font-bold opacity-80">{teamsCount}</span>
            </Link>
          </div>
        )}

        {/* ── Breadcrumb / heading row ── */}
        <div className="flex items-center justify-between gap-3 mb-5">
          {/* Personal Transcribe folder breadcrumb */}
          {activeFolderId ? (
            <div className="flex items-center gap-2 min-w-0">
              <Link
                href={withScope({})}
                className="flex items-center gap-1 text-sm text-ftc-mid hover:text-ftc-gray transition-colors flex-shrink-0"
              >
                <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M15 19l-7-7 7-7" />
                </svg>
                Back
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

          /* Org team breadcrumb (team selected) */
          ) : activeTeamId ? (
            <div className="flex items-center gap-2 min-w-0">
              <Link
                href={teamBackHref}
                className="flex items-center gap-1 text-sm text-ftc-mid hover:text-ftc-gray transition-colors flex-shrink-0"
              >
                <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M15 19l-7-7 7-7" />
                </svg>
                {activeOrg?.name ?? 'All'}
              </Link>
              <svg className="w-3.5 h-3.5 text-surface-muted flex-shrink-0" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
              </svg>
              <div className="flex items-center gap-2 min-w-0">
                <svg className="w-4 h-4 text-brand flex-shrink-0" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M15 19.128a9.38 9.38 0 002.625.372 9.337 9.337 0 004.121-.952 4.125 4.125 0 00-7.533-2.493M15 19.128v-.003c0-1.113-.285-2.16-.786-3.07M15 19.128v.106A12.318 12.318 0 018.624 21c-2.331 0-4.512-.645-6.374-1.766l-.001-.109a6.375 6.375 0 0111.964-3.07M12 6.375a3.375 3.375 0 11-6.75 0 3.375 3.375 0 016.75 0zm8.25 2.25a2.625 2.625 0 11-5.25 0 2.625 2.625 0 015.25 0z" />
                </svg>
                <span className="font-semibold text-sm text-ftc-gray truncate">
                  {activeTeam?.name ?? 'Team'}
                </span>
              </div>
            </div>

          ) : inOrgFolderView ? (
            /* Org folder view heading */
            <h2 className="text-xs font-semibold uppercase tracking-widest text-ftc-mid">
              {activeOrg?.name ?? 'Company'}
            </h2>

          ) : (
            /* Default heading — names whose meetings are on screen */
            <h2 className="text-xs font-semibold uppercase tracking-widest text-ftc-mid">
              {scopeHeading}
            </h2>
          )}

          {/* New folder — only in plain all-recordings view, not admin org views */}
          {!activeFolderId && !inOrgFolderView && !activeTeamId && (
            <Suspense>
              <NewFolderButton />
            </Suspense>
          )}
        </div>

        {/* ── Org team "folder" cards (super admin org view) ── */}
        {inOrgFolderView && orgTeams.length > 0 && (
          <ul className="space-y-2 mb-6">
            {orgTeams.map(team => (
              <li key={team.id}>
                <SpotlightCard>
                <Link
                  href={`/?org=${activeOrgId}&team=${team.id}`}
                  className="group flex items-center gap-4 rounded-2xl px-5 py-4 active:scale-[0.99] touch-manipulation"
                >
                  <div className="w-9 h-9 rounded-xl bg-brand/10 flex-shrink-0 flex items-center justify-center">
                    <svg className="w-5 h-5 text-brand" fill="none" stroke="currentColor" strokeWidth={1.75} viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" d="M15 19.128a9.38 9.38 0 002.625.372 9.337 9.337 0 004.121-.952 4.125 4.125 0 00-7.533-2.493M15 19.128v-.003c0-1.113-.285-2.16-.786-3.07M15 19.128v.106A12.318 12.318 0 018.624 21c-2.331 0-4.512-.645-6.374-1.766l-.001-.109a6.375 6.375 0 0111.964-3.07M12 6.375a3.375 3.375 0 11-6.75 0 3.375 3.375 0 016.75 0zm8.25 2.25a2.625 2.625 0 11-5.25 0 2.625 2.625 0 015.25 0z" />
                    </svg>
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="font-semibold text-sm text-ftc-gray">{team.name}</p>
                  </div>
                  <svg className="w-4 h-4 text-surface-muted group-hover:text-ftc-mid transition-colors flex-shrink-0" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
                  </svg>
                </Link>
                </SpotlightCard>
              </li>
            ))}
          </ul>
        )}

        {/* ── Personal Transcribe folder cards (non-org view) ── */}
        {!activeFolderId && !inOrgFolderView && !activeTeamId && folders.length > 0 && (
          <ul className="space-y-2 mb-6">
            {folders.map(folder => (
              <li key={folder.id}>
                <SpotlightCard>
                <Link
                  href={withScope({ folder: folder.id })}
                  className="group flex items-center gap-4 rounded-2xl px-5 py-4 active:scale-[0.99] touch-manipulation"
                >
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
                </SpotlightCard>
              </li>
            ))}
          </ul>
        )}

        {/* ── Unassigned label (only in folder views where folders exist) ── */}
        {!activeFolderId && !inOrgFolderView && !activeTeamId && folders.length > 0 && (
          <h3 className="text-xs font-semibold uppercase tracking-widest text-ftc-mid mb-4">
            Unassigned
          </h3>
        )}
        {inOrgFolderView && orgTeams.length > 0 && recordings.length > 0 && (
          <h3 className="text-xs font-semibold uppercase tracking-widest text-ftc-mid mb-4">
            All Recordings
          </h3>
        )}

        {/* ── Recording cards ── */}
        {recordingsFailed ? (
          // DB was unreachable — never imply the meetings are gone. Offer a retry.
          <div className="flex flex-col items-center justify-center py-24 gap-5">
            <div className="w-20 h-20 rounded-2xl border border-amber-500/30 bg-amber-500/10 flex items-center justify-center">
              <svg className="w-9 h-9 text-amber-400" fill="none" stroke="currentColor" strokeWidth={1.8} viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m0 3.75h.008M10.34 3.94l-8.4 14.55A1.5 1.5 0 003.24 21h17.52a1.5 1.5 0 001.3-2.25l-8.4-14.55a1.5 1.5 0 00-2.62 0z" />
              </svg>
            </div>
            <div className="text-center">
              <p className="font-semibold text-ftc-gray mb-1">Couldn&apos;t load your recordings</p>
              <p className="text-sm text-ftc-mid max-w-sm">
                We couldn&apos;t reach the database just now — your meetings are safe. Refresh to try again.
              </p>
            </div>
            <Link href="/" prefetch={false} className="btn-brand px-6 py-3 rounded-2xl text-sm font-semibold text-white touch-manipulation">
              Refresh
            </Link>
          </div>
        ) : recordings.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-24 gap-5">
            <div className="w-20 h-20 rounded-2xl border border-surface-border bg-surface-card flex items-center justify-center">
              <MicIcon className="w-9 h-9 text-surface-muted" />
            </div>
            <div className="text-center">
              <p className="font-semibold text-ftc-gray mb-1">
                {activeFolderId || activeTeamId ? 'No recordings in this folder' : 'No recordings yet'}
              </p>
              <p className="text-sm text-ftc-mid">
                {activeFolderId || activeTeamId
                  ? 'Move recordings here using the folder icon on each card'
                  : 'Tap New Recording to capture your first meeting'}
              </p>
            </div>
            {!activeFolderId && !activeTeamId && (
              <Link href="/record" className="btn-brand px-6 py-3 rounded-2xl text-sm font-semibold text-white touch-manipulation">
                Start Recording
              </Link>
            )}
          </div>
        ) : (
          <>
          <RecordingsList
            recordings={recordings.map(rec => {
              const isQueued = rec.status === 'uploading' || rec.status === 'queued' || rec.status === 'processing';
              return {
                id: rec.id,
                title: rec.title,
                createdAt: rec.createdAt.toISOString(),
                status: rec.status,
                source: rec.source ?? 'web',
                meetingProvider: rec.meetingProvider ?? null,
                folderId: rec.folderId,
                duration: rec.duration ?? 0,
                summary: rec.summary
                  ? { overview: rec.summary.overview, keyPoints: rec.summary.keyPoints, actionItems: rec.summary.actionItems }
                  : null,
                _count: rec._count,
                eta: isQueued
                  ? formatEta(estimateSeconds(rec._count.chunks, chunksDoneById.get(rec.id) ?? 0, finalizeCost))
                  : null,
                ownerName: showOwner
                  ? (rec.userId ? ownerNames[rec.userId] ?? 'Unknown' : 'Unassigned')
                  : null,
              };
            })}
            folders={folderList}
          />
          {hasMore && (
            <div className="flex justify-center mt-6">
              <Link
                href={showMoreHref}
                className="px-5 py-2.5 rounded-xl text-sm font-medium text-ftc-gray bg-surface-raised border border-surface-border hover:border-surface-muted transition-colors touch-manipulation"
              >
                Show more
              </Link>
            </div>
          )}
          </>
        )}
      </main>
      <div className="pb-safe" />
    </div>
  );
}
