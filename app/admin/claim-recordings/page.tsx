import { redirect } from 'next/navigation';
import { prisma } from '@/lib/db';
import { getAuthUser } from '@/lib/auth';

export const dynamic = 'force-dynamic';

export default async function ClaimRecordingsPage() {
  const user = await getAuthUser();
  if (!user) redirect('/login');

  const [recordings, folders] = await Promise.all([
    prisma.recording.updateMany({ where: { userId: null }, data: { userId: user.id } }),
    prisma.folder.updateMany({ where: { userId: null }, data: { userId: user.id } }),
  ]);

  return (
    <div className="min-h-screen flex items-center justify-center bg-surface px-4">
      <div className="w-full max-w-sm rounded-2xl border border-surface-border bg-surface-card p-8 space-y-5">
        <div className="rounded-xl bg-green-500/10 border border-green-500/20 px-4 py-3 text-sm text-green-400">
          Done — {recordings.count} recording{recordings.count !== 1 ? 's' : ''} and {folders.count} folder{folders.count !== 1 ? 's' : ''} moved to your account.
        </div>
        <a
          href="/"
          className="block w-full btn-brand py-2.5 rounded-xl text-sm font-semibold text-white text-center"
        >
          Go to recordings
        </a>
      </div>
    </div>
  );
}
