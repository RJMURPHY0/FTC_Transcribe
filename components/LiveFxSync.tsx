'use client';

import { useEffect } from 'react';
import { setGlowEnabled } from '@/components/ui/spotlight-card';

// Hydrates the card-animation glow from the user's saved DB preference on load,
// then caches it in localStorage (via setGlowEnabled) so the cards read it
// instantly on subsequent renders. On /login the fetch 401s and no-ops.
export default function LiveFxSync() {
  useEffect(() => {
    let cancelled = false;
    fetch('/api/user-settings')
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (!cancelled && d && typeof d.liveFx === 'boolean') setGlowEnabled(d.liveFx);
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, []);
  return null;
}
