import { prisma } from '@/lib/db';

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
  } catch { return []; }
}

export async function getOrgTeams(orgId: string): Promise<OrgTeam[]> {
  try {
    return await prisma.$queryRaw<OrgTeam[]>`
      SELECT id::text, name, org_id::text
      FROM public.org_teams
      WHERE org_id = ${orgId}::uuid
      ORDER BY name
    `;
  } catch { return []; }
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
  } catch { return []; }
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
  } catch { return []; }
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
  } catch { return []; }
}
