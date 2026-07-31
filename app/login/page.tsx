'use client';

import { useState } from 'react';
import { Mic, Users, FileText, Loader2 } from 'lucide-react';
import { createClient } from '@/lib/supabase/client';

// Product value points for the brand panel. Brand-neutral wording so the
// imminent rebrand doesn't leave stale copy behind.
const HIGHLIGHTS = [
  { icon: Mic,      title: 'Record anywhere',          body: 'Capture meetings in the browser or on your phone — survives dropped connections.' },
  { icon: Users,    title: 'Diarised transcripts',     body: 'Speaker-labelled transcripts with names, not just walls of text.' },
  { icon: FileText, title: 'AI summaries & exports',   body: 'Overview, key points, action items and decisions — exported to PDF or Word.' },
];

export default function LoginPage() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    setLoading(true);

    try {
      const supabase = createClient();
      const { error } = await supabase.auth.signInWithPassword({ email, password });
      if (error) {
        setError(error.message === 'Invalid login credentials'
          ? 'Incorrect email or password.'
          : error.message);
        setLoading(false);
        return;
      }
    } catch (e) {
      setError('Auth not configured — add NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY to Vercel env vars.');
      setLoading(false);
      return;
    }

    // Hard redirect — faster than router.push + router.refresh (avoids double round-trip).
    // The session cookie is already set by signInWithPassword, so the server sees it immediately.
    window.location.href = '/';
  }

  return (
    <div className="relative min-h-screen w-full overflow-hidden bg-surface text-ftc-gray">
      {/* Ambient brand glow */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 bg-[radial-gradient(60rem_40rem_at_top_left,rgb(var(--c-brand)/0.14),transparent_60%)]"
      />
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 bg-[radial-gradient(50rem_40rem_at_bottom_right,rgb(var(--c-brand)/0.08),transparent_55%)]"
      />

      <div className="relative z-10 grid min-h-screen lg:grid-cols-2">
        {/* Brand / hero panel — desktop only */}
        <aside className="hidden flex-col justify-between border-r border-surface-border p-12 lg:flex">
          <img src="/logo.png" alt="FTC Transcribe" className="h-10 w-auto self-start object-contain" />

          <div className="max-w-md">
            <h1 className="text-3xl font-semibold leading-tight tracking-tight text-ftc-gray xl:text-4xl">
              Every meeting, captured and searchable.
            </h1>
            <p className="mt-4 text-base text-ftc-mid">
              Record in the browser or on your phone, get diarised transcripts and AI summaries, and export in a click — no note-taker required.
            </p>

            <ul className="mt-10 space-y-5">
              {HIGHLIGHTS.map(({ icon: Icon, title, body }) => (
                <li key={title} className="flex items-start gap-4">
                  <span className="mt-0.5 flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-surface-border bg-surface-card">
                    <Icon className="h-5 w-5 text-brand" />
                  </span>
                  <span>
                    <span className="block text-sm font-medium text-ftc-gray">{title}</span>
                    <span className="block text-sm text-ftc-mid">{body}</span>
                  </span>
                </li>
              ))}
            </ul>
          </div>

          <p className="text-xs text-ftc-mid">
            © {new Date().getFullYear()} FTC Safety Solutions. All rights reserved.
          </p>
        </aside>

        {/* Sign-in panel */}
        <main className="flex items-center justify-center px-6 py-12 sm:px-12">
          <div className="w-full max-w-sm">
            {/* Mobile logo — hero panel is hidden below lg */}
            <img src="/logo.png" alt="FTC Transcribe" className="mx-auto mb-8 h-10 w-auto object-contain lg:hidden" />

            <div className="rounded-2xl border border-surface-border bg-surface-card p-6 shadow-2xl shadow-black/30 sm:p-8">
              <div className="mb-6 text-center">
                <h2 className="text-2xl font-semibold tracking-tight text-ftc-gray">Welcome back</h2>
                <p className="mt-1.5 text-sm text-ftc-mid">Sign in to pick up where you left off.</p>
              </div>

              <form onSubmit={handleSubmit} className="space-y-4">
                <div className="space-y-1.5">
                  <label htmlFor="email" className="block text-xs font-medium text-ftc-mid">Email</label>
                  <input
                    id="email"
                    type="email"
                    autoComplete="email"
                    required
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    placeholder="you@company.com"
                    className="auth-input h-11 w-full rounded-xl border border-gray-200 px-4 text-sm placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-brand/60 transition-colors"
                  />
                </div>

                <div className="space-y-1.5">
                  <label htmlFor="password" className="block text-xs font-medium text-ftc-mid">Password</label>
                  <div className="relative">
                    <input
                      id="password"
                      type={showPassword ? 'text' : 'password'}
                      autoComplete="current-password"
                      required
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                      placeholder="Your password"
                      className="auth-input h-11 w-full rounded-xl border border-gray-200 px-4 pr-11 text-sm placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-brand/60 transition-colors"
                    />
                    <button
                      type="button"
                      onClick={() => setShowPassword((v) => !v)}
                      aria-label={showPassword ? 'Hide password' : 'Show password'}
                      aria-pressed={showPassword}
                      tabIndex={-1}
                      className="absolute inset-y-0 right-0 flex items-center px-3 text-gray-500 hover:text-gray-800 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand/50 rounded-r-xl transition-colors"
                    >
                      {showPassword ? (
                        <svg className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" d="M13.875 18.825A10.05 10.05 0 0112 19c-4.478 0-8.268-2.943-9.543-7a9.97 9.97 0 011.563-3.029m5.858.908a3 3 0 114.243 4.243M9.878 9.878l4.242 4.242M9.88 9.88l-3.29-3.29m7.532 7.532l3.29 3.29M3 3l3.59 3.59m0 0A9.953 9.953 0 0112 5c4.478 0 8.268 2.943 9.543 7a10.025 10.025 0 01-4.132 5.411m0 0L21 21" />
                        </svg>
                      ) : (
                        <svg className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                          <path strokeLinecap="round" strokeLinejoin="round" d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" />
                        </svg>
                      )}
                    </button>
                  </div>
                </div>

                {error && (
                  <p className="rounded-xl bg-red-400/10 px-4 py-2.5 text-sm text-red-400">{error}</p>
                )}

                <button
                  type="submit"
                  disabled={loading}
                  className="btn-brand flex h-11 w-full items-center justify-center gap-2 rounded-xl text-sm font-semibold text-white disabled:opacity-60"
                >
                  {loading && <Loader2 className="h-4 w-4 animate-spin" />}
                  {loading ? 'Signing in…' : 'Sign in'}
                </button>
              </form>
            </div>

            <p className="mt-6 text-center text-xs text-ftc-mid">
              FTC Transcribe — meeting notes, secured.
            </p>
          </div>
        </main>
      </div>
    </div>
  );
}
