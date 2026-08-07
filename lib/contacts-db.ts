import { prisma } from '@/lib/db';

// Shared-DB reads against the Contacts app's org tables. Failures return []
// so the UI stays usable, but they are ALWAYS logged — a dead connection or a
// renamed table must be distinguishable from "no orgs exist".
function logged(fn: string, err: unknown): [] {
  console.error(`[contacts-db] ${fn} failed:`, err instanceof Error ? err.message : err);
  return [];
}

export type Org = { id: string; name: string };
export type OrgTeam = { id: string; name: string; org_id: string };
export type OrgMember = {
  user_id: string;
  email: string | null;
  sender_name: string | null;
  avatar_url: string | null;
  team_id: string | null;
};

export async function getOrganisations(): Promise<Org[]> {
  try {
    return await prisma.$queryRaw<Org[]>`
      SELECT id::text, name FROM public.organisations ORDER BY name
    `;
  } catch (err) { return logged('getOrganisations', err); }
}

export async function getOrgTeams(orgId: string): Promise<OrgTeam[]> {
  try {
    return await prisma.$queryRaw<OrgTeam[]>`
      SELECT id::text, name, org_id::text
      FROM public.org_teams
      WHERE org_id = ${orgId}::uuid
      ORDER BY name
    `;
  } catch (err) { return logged('getOrgTeams', err); }
}

export async function getOrgMembers(orgId: string, teamId?: string | null): Promise<OrgMember[]> {
  try {
    if (teamId) {
      return await prisma.$queryRaw<OrgMember[]>`
        SELECT om.user_id::text, om.sender_name, om.avatar_url, om.team_id::text,
               au.email
        FROM public.org_members om
        LEFT JOIN auth.users au ON au.id = om.user_id
        WHERE om.org_id = ${orgId}::uuid AND om.team_id = ${teamId}::uuid
        ORDER BY COALESCE(om.sender_name, au.email)
      `;
    }
    return await prisma.$queryRaw<OrgMember[]>`
      SELECT om.user_id::text, om.sender_name, om.avatar_url, om.team_id::text,
             au.email
      FROM public.org_members om
      LEFT JOIN auth.users au ON au.id = om.user_id
      WHERE om.org_id = ${orgId}::uuid
      ORDER BY COALESCE(om.sender_name, au.email)
    `;
  } catch (err) { return logged('getOrgMembers', err); }
}

export async function getAllOrgMembers(): Promise<OrgMember[]> {
  try {
    return await prisma.$queryRaw<OrgMember[]>`
      SELECT DISTINCT ON (om.user_id)
             om.user_id::text, om.sender_name, om.avatar_url, om.team_id::text,
             au.email
      FROM public.org_members om
      LEFT JOIN auth.users au ON au.id = om.user_id
      ORDER BY om.user_id, COALESCE(om.sender_name, au.email)
    `;
  } catch (err) { return logged('getAllOrgMembers', err); }
}

/**
 * Display names for a set of auth user ids — used to show WHO recorded a
 * meeting when an admin looks beyond their own. Falls back to the email local
 * part when the user has no org_members row (e.g. external testers).
 */
export async function getMemberNames(userIds: string[]): Promise<Record<string, string>> {
  const ids = [...new Set(userIds.filter(Boolean))];
  if (ids.length === 0) return {};
  try {
    const rows = await prisma.$queryRaw<{ user_id: string; sender_name: string | null; email: string | null }[]>`
      SELECT u.id::text AS user_id,
             (SELECT om.sender_name FROM public.org_members om
               WHERE om.user_id = u.id AND om.sender_name IS NOT NULL LIMIT 1) AS sender_name,
             u.email
      FROM auth.users u
      WHERE u.id::text = ANY(${ids}::text[])
    `;
    const out: Record<string, string> = {};
    for (const r of rows) {
      out[r.user_id] =
        r.sender_name ??
        (r.email
          ? r.email.split('@')[0].replace(/[._]/g, ' ').replace(/\b\w/g, c => c.toUpperCase())
          : r.user_id.slice(0, 8));
    }
    return out;
  } catch (err) {
    console.error('[contacts-db] getMemberNames failed:', err instanceof Error ? err.message : err);
    return {};
  }
}

export async function getMemberUserIds(orgId?: string | null, teamId?: string | null): Promise<string[]> {
  try {
    if (teamId && orgId) {
      const rows = await prisma.$queryRaw<{ user_id: string }[]>`
        SELECT user_id::text FROM public.org_members
        WHERE org_id = ${orgId}::uuid AND team_id = ${teamId}::uuid
      `;
      return rows.map(r => r.user_id);
    }
    if (orgId) {
      const rows = await prisma.$queryRaw<{ user_id: string }[]>`
        SELECT user_id::text FROM public.org_members WHERE org_id = ${orgId}::uuid
      `;
      return rows.map(r => r.user_id);
    }
    return [];
  } catch (err) { return logged('getMemberUserIds', err); }
}
