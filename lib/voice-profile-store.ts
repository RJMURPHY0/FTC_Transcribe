// Model-space-aware VoiceProfile persistence. Embeddings from different
// models are incomparable, so every row carries a modelVersion tag and
// matching only loads rows from one space. The local Prisma client cannot be
// regenerated while a dev server holds the engine DLL, so the tag is written
// and read via raw SQL; environments whose DB predates the column degrade to
// treating every row as legacy CAM++ data.
import { prisma } from '@/lib/db';
import { LEGACY_MODEL_VERSION } from '@/lib/voice-id';
import type { Prisma as PrismaTypes } from '@prisma/client';

export interface StoredProfile { personName: string; embedding: number[]; source: string }

export async function createVoiceProfileTagged(
  data: PrismaTypes.VoiceProfileUncheckedCreateInput,
  modelVersion: string,
): Promise<{ id: string }> {
  const row = await prisma.voiceProfile.create({ data, select: { id: true } });
  try {
    await prisma.$executeRaw`UPDATE "VoiceProfile" SET "modelVersion" = ${modelVersion} WHERE "id" = ${row.id}`;
  } catch { /* column missing in this env — rows stay legacy-tagged by default */ }
  return row;
}

// Profiles usable for matching against embeddings produced by `version`,
// scoped to one user's rows (+ unclaimed legacy null-userId rows).
export async function loadProfilesForVersion(
  userId: string | null,
  version: string,
): Promise<StoredProfile[]> {
  try {
    const rows = userId
      ? await prisma.$queryRaw<Array<{ personName: string; embedding: string; source: string }>>`
          SELECT "personName", "embedding", "source" FROM "VoiceProfile"
          WHERE "modelVersion" = ${version} AND ("userId" = ${userId} OR "userId" IS NULL)`
      : await prisma.$queryRaw<Array<{ personName: string; embedding: string; source: string }>>`
          SELECT "personName", "embedding", "source" FROM "VoiceProfile"
          WHERE "modelVersion" = ${version}`;
    return rows
      .map((p) => {
        try { return { personName: p.personName, embedding: JSON.parse(p.embedding) as number[], source: p.source }; }
        catch { return null; }
      })
      .filter((p): p is StoredProfile => !!p);
  } catch {
    // No modelVersion column → everything in this DB is legacy CAM++ data
    if (version !== LEGACY_MODEL_VERSION) return [];
    const rows = await prisma.voiceProfile.findMany({
      where: userId ? { OR: [{ userId }, { userId: null }] } : {},
      select: { personName: true, embedding: true, source: true },
    }).catch(() => [] as Array<{ personName: string; embedding: string; source: string }>);
    return rows
      .map((p) => {
        try { return { personName: p.personName, embedding: JSON.parse(p.embedding) as number[], source: p.source }; }
        catch { return null; }
      })
      .filter((p): p is StoredProfile => !!p);
  }
}

// Map of VoiceProfile id → modelVersion for a set of rows (samples UI).
export async function profileVersions(ids: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (!ids.length) return out;
  try {
    const rows = await prisma.$queryRaw<Array<{ id: string; modelVersion: string }>>`
      SELECT "id", "modelVersion" FROM "VoiceProfile" WHERE "id" = ANY(${ids})`;
    for (const r of rows) out.set(r.id, r.modelVersion);
  } catch {
    for (const id of ids) out.set(id, LEGACY_MODEL_VERSION);
  }
  return out;
}
