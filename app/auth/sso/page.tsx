'use client';

import { useEffect, useRef } from 'react';
import { createClient } from '@/lib/supabase/client';

// Handles cross-app SSO from FTC Contacts / BrightLink.
// The parent app passes access_token + refresh_token as a URL hash fragment
// (falls back to the query string); this page sets the Supabase session, then
// does a HARD navigation home.
export default function SsoPage() {
  // Strict Mode mounts effects twice in dev — guard so setSession runs once.
  const ran = useRef(false);

  useEffect(() => {
    if (ran.current) return;
    ran.current = true;

    (async () => {
      const hash  = new URLSearchParams(window.location.hash.slice(1));
      const query = new URLSearchParams(window.location.search);
      const accessToken  = hash.get('access_token')  ?? query.get('access_token');
      const refreshToken = hash.get('refresh_token') ?? query.get('refresh_token');
      // Optional landing target, so a deep link can be handed over too. Only
      // same-origin paths are honoured — never an absolute/external URL.
      const nextParam = hash.get('next') ?? query.get('next') ?? '/';
      const dest = nextParam.startsWith('/') && !nextParam.startsWith('//') ? nextParam : '/';

      if (!accessToken || !refreshToken) {
        window.location.replace('/login');
        return;
      }

      try {
        const supabase = createClient();
        const { error } = await supabase.auth.setSession({
          access_token: accessToken,
          refresh_token: refreshToken,
        });
        if (error) {
          window.location.replace('/login');
          return;
        }
      } catch {
        window.location.replace('/login');
        return;
      }

      // HARD navigation, not router.replace(): a full document load guarantees
      // the freshly written session cookies are sent on the very first request
      // to `dest`, and it strips the tokens out of the URL. The soft nav that
      // was here relied on the client router carrying a cookie the server
      // hadn't necessarily committed yet.
      window.location.replace(dest);
    })();
  }, []);

  return (
    <div className="min-h-screen flex items-center justify-center bg-surface">
      <p className="text-ftc-mid text-sm">Signing in…</p>
    </div>
  );
}
