'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { createClient } from '@/lib/supabase/client';

// Handles cross-app SSO from FTC Contacts.
// FTC Contacts passes access_token + refresh_token as URL hash fragment;
// this page reads them, sets the Supabase session, then redirects home.
export default function SsoPage() {
  const router = useRouter();

  useEffect(() => {
    const hash = window.location.hash.slice(1);
    const params = new URLSearchParams(hash);
    const accessToken  = params.get('access_token');
    const refreshToken = params.get('refresh_token');

    if (!accessToken || !refreshToken) {
      router.replace('/login');
      return;
    }

    const supabase = createClient();
    supabase.auth
      .setSession({ access_token: accessToken, refresh_token: refreshToken })
      .then(() => {
        router.replace('/');
        router.refresh();
      })
      .catch(() => router.replace('/login'));
  }, [router]);

  return (
    <div className="min-h-screen flex items-center justify-center bg-surface">
      <p className="text-ftc-mid text-sm">Signing in…</p>
    </div>
  );
}
