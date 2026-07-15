'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { createClient } from '@/lib/supabase/client';

// Claims unowned recordings for the current user, then refreshes so they appear.
export default function AutoClaim() {
  const router = useRouter();
  useEffect(() => {
    // Only attempt the claim once per browser session. The server already
    // claims legacy rows on render (page.tsx claimPromise); running this on
    // every dashboard mount fired a redundant getSession + POST and, worse,
    // busted the client router cache so every "Back" refetched the whole list.
    try {
      if (sessionStorage.getItem('autoclaim-done') === '1') return;
      sessionStorage.setItem('autoclaim-done', '1');
    } catch { /* sessionStorage unavailable — fall through, claim once */ }

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
