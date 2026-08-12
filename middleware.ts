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

  // Cookie-only session read — fast (no network call). This is a UX redirect,
  // NOT the auth boundary: every data access verifies the JWT server-side via
  // getAuthUser() (supabase.auth.getUser()), so a forged cookie gets past this
  // redirect but can never read data.
  let user = null;
  try {
    const { data } = await supabase.auth.getSession();
    user = data.session?.user ?? null;
  } catch {
    // Cookie parse error — treat as unauthenticated
  }

  const { pathname } = request.nextUrl;

  // Allow unauthenticated access to login and webhook/cron endpoints
  const isPublic =
    pathname === '/login' ||
    pathname === '/auth/sso' ||
    pathname.startsWith('/api/auto-fix') ||
    pathname.startsWith('/api/jobs/finalize') ||
    pathname.startsWith('/api/health') ||
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
    return NextResponse.redirect(url);
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
