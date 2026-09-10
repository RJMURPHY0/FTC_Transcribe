import { createServerClient } from '@supabase/ssr';
import { NextResponse, type NextRequest } from 'next/server';

export async function middleware(request: NextRequest) {
  // If Supabase env vars aren't configured, pass through rather than crashing
  if (!process.env.NEXT_PUBLIC_SUPABASE_URL || !process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY) {
    return NextResponse.next({ request });
  }

  let supabaseResponse = NextResponse.next({ request });

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
    {
      cookies: {
        getAll() { return request.cookies.getAll(); },
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value }) =>
            request.cookies.set(name, value),
          );
          supabaseResponse = NextResponse.next({ request });
          cookiesToSet.forEach(({ name, value, options }) =>
            supabaseResponse.cookies.set(name, value, options),
          );
        },
      },
    },
  );

  // getUser() (verifies the JWT with the Auth server) rather than getSession()
  // (a bare cookie decode). The distinction is what fixes the cross-app SSO
  // bounce: when the access token has expired — which the token handed over
  // from BrightLink usually is within the hour — getUser() uses the refresh
  // token to mint a new session and writes the rotated cookies back via the
  // setAll() callback above. getSession() never did that, so the FIRST
  // navigation that needed a refresh (e.g. clicking a meeting after landing on
  // the list) found an expired cookie, read null, and got redirected to /login
  // even though the session was still renewable. This is the Supabase-
  // recommended SSR middleware pattern. It is still only a UX redirect — the
  // real boundary is getAuthUser() on every data access.
  //
  // Prefetch requests are skipped entirely: they are speculative, they must not
  // drive a redirect, and refreshing on a burst of parallel prefetches is what
  // races the refresh-token rotation. The page each one targets runs its own
  // getAuthUser() check, so nothing is left unguarded.
  const isPrefetch =
    request.headers.get('next-router-prefetch') === '1' ||
    request.headers.get('purpose') === 'prefetch' ||
    request.headers.get('sec-purpose')?.includes('prefetch');
  if (isPrefetch) return supabaseResponse;

  let user = null;
  try {
    const { data } = await supabase.auth.getUser();
    user = data.user ?? null;
  } catch {
    // Auth server unreachable / cookie parse error — treat as unauthenticated
    // for the redirect only.
  }

  const { pathname } = request.nextUrl;

  // Allow unauthenticated access to login and webhook/cron endpoints
  const isPublic =
    pathname === '/login' ||
    pathname === '/auth/sso' ||
    pathname.startsWith('/api/auto-fix') ||
    pathname.startsWith('/api/jobs/finalize') ||
    pathname.startsWith('/api/health') ||
    // Desktop clients authenticate with a bearer token, not a cookie, so the
    // redirect above would bounce them to /login before their route ran. Each
    // of these verifies its own bearer via getBearerUser().
    pathname.startsWith('/api/voice-training') ||
    pathname.startsWith('/_next') ||
    pathname.startsWith('/favicon') ||
    pathname.startsWith('/icon') ||
    pathname.startsWith('/apple-touch-icon') ||
    pathname.startsWith('/manifest') ||
    pathname.startsWith('/sw.js') ||
    pathname.startsWith('/logo');

  if (!user && !isPublic) {
    const url = request.nextUrl.clone();
    url.pathname = '/login';
    const redirect = NextResponse.redirect(url);
    // Preserve any cookies getUser() just refreshed, so a session caught
    // mid-rotation isn't thrown away by the redirect itself.
    supabaseResponse.cookies.getAll().forEach((c) => redirect.cookies.set(c));
    return redirect;
  }

  return supabaseResponse;
}

export const config = {
  // Skip public static assets entirely — they were already isPublic inside the
  // handler, so running the edge function (cookie parse + client setup) for
  // every logo/icon/manifest request was pure overhead on each page load.
  matcher: [
    '/((?!_next/static|_next/image|favicon|icon|apple-touch-icon|logo|manifest|sw\\.js).*)',
  ],
};
