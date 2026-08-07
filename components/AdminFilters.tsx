'use client';

import { useRouter, useSearchParams, usePathname } from 'next/navigation';
import { useState } from 'react';
import type { Org, OrgMember } from '@/lib/contacts-db';
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
} from '@/components/ui/dropdown-menu';
import { Popover, PopoverTrigger, PopoverContent } from '@/components/ui/popover';

// ── helpers ──────────────────────────────────────────────────────────────────

function getInitials(str: string): string {
  return str
    .split(/[\s@.]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map(w => w[0].toUpperCase())
    .join('');
}

const AVATAR_COLORS = [
  '#E67E22', '#3498DB', '#2ECC71', '#9B59B6',
  '#E74C3C', '#1ABC9C', '#F39C12', '#E91E63',
];
function avatarColor(userId: string): string {
  const idx = userId.split('').reduce((a, c) => a + c.charCodeAt(0), 0) % AVATAR_COLORS.length;
  return AVATAR_COLORS[idx];
}

function displayName(m: OrgMember): string {
  if (m.sender_name) return m.sender_name;
  if (m.email) {
    return m.email
      .split('@')[0]
      .replace(/[._]/g, ' ')
      .replace(/\b\w/g, c => c.toUpperCase());
  }
  return m.user_id.slice(0, 8);
}

function emailDomain(m: OrgMember): string {
  const domain = m.email?.split('@')[1] ?? '';
  return domain.replace(/\.(com|org|net|co\.uk)$/i, '');
}

// ── avatar ───────────────────────────────────────────────────────────────────

function MemberAvatar({ member }: { member: OrgMember }) {
  const [failed, setFailed] = useState(false);
  const name  = displayName(member);
  const color = avatarColor(member.user_id);

  if (member.avatar_url && !failed) {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={member.avatar_url}
        alt={name}
        referrerPolicy="no-referrer"
        onError={() => setFailed(true)}
        className="w-7 h-7 rounded-full object-cover flex-shrink-0"
      />
    );
  }

  // eslint-disable-next-line react/forbid-dom-props
  return (
    <span
      className="w-7 h-7 rounded-full flex items-center justify-center text-white text-[11px] font-bold flex-shrink-0 select-none"
      style={{ backgroundColor: color }}
    >
      {getInitials(name)}
    </span>
  );
}

// ── main component ────────────────────────────────────────────────────────────

export default function AdminFilters({
  orgs,
  members,
  activeOrgId,
  activeAssigneeId,
}: {
  orgs: Org[];
  members: OrgMember[];
  activeOrgId: string | null;
  activeAssigneeId: string | null;
}) {
  const router       = useRouter();
  const pathname     = usePathname();
  const searchParams = useSearchParams();

  const [assigneeOpen, setAssigneeOpen]     = useState(false);
  const [assigneeSearch, setAssigneeSearch] = useState('');

  const activeOrg = orgs.find(o => o.id === activeOrgId) ?? null;
  // No assignee param = your own meetings (the landing state). 'all' = everyone.
  const viewingMine     = !activeAssigneeId;
  const viewingEveryone = activeAssigneeId === 'all';
  const activeMember    = members.find(m => m.user_id === activeAssigneeId) ?? null;

  const filteredMembers = assigneeSearch
    ? members.filter(m => displayName(m).toLowerCase().includes(assigneeSearch.toLowerCase()))
    : members;

  function navigate(patch: Record<string, string | null>) {
    const sp = new URLSearchParams(searchParams.toString());
    for (const [k, v] of Object.entries(patch)) {
      if (v === null) sp.delete(k); else sp.set(k, v);
    }
    if ('org' in patch) { sp.delete('team'); sp.delete('folder'); }
    router.push(`${pathname}?${sp.toString()}`);
  }

  const selectAssignee = (userId: string | null) => {
    navigate({ assignee: userId });
    setAssigneeOpen(false);
    setAssigneeSearch('');
  };

  return (
    <div className="flex items-center gap-2 flex-wrap">

      {/* ── Company dropdown ── */}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            className="flex items-center gap-2 px-3 py-1.5 rounded-xl text-sm font-medium border border-surface-border bg-surface-raised text-ftc-gray hover:border-surface-muted transition-colors"
          >
            <svg className="w-3.5 h-3.5 text-ftc-mid flex-shrink-0" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" d="M3.75 21h16.5M4.5 3h15M5.25 3v18m13.5-18v18M9 6.75h1.5m-1.5 3h1.5m-1.5 3h1.5m3-6H15m-1.5 3H15m-1.5 3H15M9 21v-3.375c0-.621.504-1.125 1.125-1.125h3.75c.621 0 1.125.504 1.125 1.125V21" />
            </svg>
            <span className="max-w-[140px] truncate">
              {activeOrg ? activeOrg.name : 'All Companies'}
            </span>
            <svg className="w-3.5 h-3.5 text-ftc-mid flex-shrink-0" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 8.25l-7.5 7.5-7.5-7.5" />
            </svg>
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="min-w-[200px] max-h-64 overflow-y-auto">
          <DropdownMenuItem
            onSelect={() => navigate({ org: null })}
            className={!activeOrgId ? 'text-brand font-semibold' : ''}
          >
            All Companies
          </DropdownMenuItem>
          {orgs.map(org => (
            <DropdownMenuItem
              key={org.id}
              onSelect={() => navigate({ org: org.id })}
              className={activeOrgId === org.id ? 'text-brand font-semibold' : ''}
            >
              {org.name}
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>

      {/* ── Assignee dropdown (searchable) ── */}
      <Popover open={assigneeOpen} onOpenChange={(o) => { setAssigneeOpen(o); if (!o) setAssigneeSearch(''); }}>
        <PopoverTrigger asChild>
          <button
            type="button"
            className="flex items-center gap-2 px-3 py-1.5 rounded-xl text-sm font-medium border border-surface-border bg-surface-raised text-ftc-gray hover:border-surface-muted transition-colors"
          >
            <svg className="w-3.5 h-3.5 text-ftc-mid flex-shrink-0" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 6a3.75 3.75 0 11-7.5 0 3.75 3.75 0 017.5 0zM4.501 20.118a7.5 7.5 0 0114.998 0A17.933 17.933 0 0112 21.75c-2.676 0-5.216-.584-7.499-1.632z" />
            </svg>
            {activeMember ? (
              <span className="flex items-center gap-1.5">
                <MemberAvatar member={activeMember} />
                <span className="max-w-[100px] truncate">{displayName(activeMember)}</span>
              </span>
            ) : (
              <span>{viewingEveryone ? 'Everyone' : 'My meetings'}</span>
            )}
            <svg className="w-3.5 h-3.5 text-ftc-mid flex-shrink-0" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 8.25l-7.5 7.5-7.5-7.5" />
            </svg>
          </button>
        </PopoverTrigger>
        <PopoverContent align="start" className="w-[240px] p-0">
          <div className="p-2 border-b border-surface-border">
            <input
              autoFocus
              value={assigneeSearch}
              onChange={e => setAssigneeSearch(e.target.value)}
              placeholder="Search..."
              className="w-full px-3 py-1.5 text-sm rounded-lg bg-surface-raised border border-surface-border text-ftc-gray placeholder:text-surface-muted focus:outline-none focus:border-brand"
            />
          </div>
          <div className="max-h-56 overflow-y-auto py-1">
            {!assigneeSearch && (
              <>
                <button
                  type="button"
                  onClick={() => selectAssignee(null)}
                  className={`w-full text-left px-3 py-2 text-sm hover:bg-surface-raised transition-colors flex items-center gap-2.5 ${viewingMine ? 'text-brand' : 'text-ftc-gray'}`}
                >
                  <div className="w-7 h-7 rounded-full bg-surface-raised border border-surface-border flex items-center justify-center flex-shrink-0">
                    <svg className="w-3.5 h-3.5 text-ftc-mid" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 6a3.75 3.75 0 11-7.5 0 3.75 3.75 0 017.5 0zM4.501 20.118a7.5 7.5 0 0114.998 0A17.933 17.933 0 0112 21.75c-2.676 0-5.216-.584-7.499-1.632z" />
                    </svg>
                  </div>
                  <span className={viewingMine ? 'font-semibold' : ''}>My meetings</span>
                </button>
                <button
                  type="button"
                  onClick={() => selectAssignee('all')}
                  className={`w-full text-left px-3 py-2 text-sm hover:bg-surface-raised transition-colors flex items-center gap-2.5 ${viewingEveryone ? 'text-brand' : 'text-ftc-gray'}`}
                >
                  <div className="w-7 h-7 rounded-full bg-surface-raised border border-surface-border flex items-center justify-center flex-shrink-0">
                    <svg className="w-3.5 h-3.5 text-ftc-mid" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" d="M15 19.128a9.38 9.38 0 002.625.372 9.337 9.337 0 004.121-.952 4.125 4.125 0 00-7.533-2.493M15 19.128v-.003c0-1.113-.285-2.16-.786-3.07M15 19.128v.106A12.318 12.318 0 018.624 21c-2.331 0-4.512-.645-6.374-1.766l-.001-.109a6.375 6.375 0 0111.964-3.07M12 6.375a3.375 3.375 0 11-6.75 0 3.375 3.375 0 016.75 0zm8.25 2.25a2.625 2.625 0 11-5.25 0 2.625 2.625 0 015.25 0z" />
                    </svg>
                  </div>
                  <span className={viewingEveryone ? 'font-semibold' : ''}>Everyone</span>
                </button>
              </>
            )}
            {filteredMembers.map(m => (
              <button
                key={m.user_id}
                type="button"
                onClick={() => selectAssignee(m.user_id)}
                className={`w-full text-left px-3 py-2 text-sm hover:bg-surface-raised transition-colors flex items-center gap-2.5 ${activeAssigneeId === m.user_id ? 'text-brand' : 'text-ftc-gray'}`}
              >
                <MemberAvatar member={m} />
                <div className="min-w-0 flex-1">
                  <div className={`truncate ${activeAssigneeId === m.user_id ? 'font-semibold' : ''}`}>
                    {displayName(m)}
                  </div>
                  {emailDomain(m) && (
                    <div className="text-[11px] text-ftc-mid truncate">{emailDomain(m)}</div>
                  )}
                </div>
              </button>
            ))}
            {filteredMembers.length === 0 && (
              <div className="px-3 py-3 text-sm text-ftc-mid text-center">No results</div>
            )}
          </div>
        </PopoverContent>
      </Popover>
    </div>
  );
}
