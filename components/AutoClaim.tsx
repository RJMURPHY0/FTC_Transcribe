'use client';

import { useEffect } from 'react';
import { createClient } from '@/lib/supabase/client';

// Silently claims all unowned recordings for the current user on first page load.
export default function AutoClaim() {
  useEffect(() => {
    (async () => {
      const supabase = createClient();
      const { data: { session } } = await supabase.auth.getSession();
      if (!session?.access_token) return;
      await fetch('/api/admin/claim-recordings', {
        method: 'POST',
        headers: { Authorization: `Bearer ${session.access_token}` },
      }).catch(() => {});
    })();
  }, []);
  return null;
}
