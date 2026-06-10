'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { createClient } from '@/lib/supabase/client';

// Claims unowned recordings for the current user, then refreshes so they appear.
export default function AutoClaim() {
  const router = useRouter();
  useEffect(() => {
    (async () => {
      const supabase = createClient();
      const { data: { session } } = await supabase.auth.getSession();
      if (!session?.access_token) return;
      const res = await fetch('/api/admin/claim-recordings', {
        method: 'POST',
        headers: { Authorization: `Bearer ${session.access_token}` },
      }).catch(() => null);
      if (!res?.ok) return;
      const data = await res.json().catch(() => null);
      // Only refresh if recordings were actually claimed (avoids infinite loop)
      if (data?.recordingsClaimed > 0 || data?.foldersClaimed > 0) {
        router.refresh();
      }
    })();
  }, [router]);
  return null;
}
