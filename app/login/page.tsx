'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { createClient } from '@/lib/supabase/client';

export default function LoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
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

    router.push('/');
    router.refresh();
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-surface px-4">
      <div className="w-full max-w-sm">
        {/* Logo */}
        <div className="flex justify-center mb-8">
          <img src="/logo.png" alt="FTC Transcribe" className="h-10 object-contain" />
        </div>

        <div className="rounded-2xl border border-surface-border bg-surface-card p-8">
          <h1 className="text-lg font-semibold text-ftc-gray mb-1">Sign in</h1>
          <p className="text-sm text-ftc-mid mb-6">Use your FTC account to continue</p>

          <form onSubmit={handleSubmit} className="space-y-4">
            <div>
              <label htmlFor="email" className="block text-xs font-medium text-ftc-mid mb-1.5">
                Email
              </label>
              <input
                id="email"
                type="email"
                autoComplete="email"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                className="w-full rounded-xl border border-surface-border bg-surface px-4 py-2.5 text-sm text-ftc-gray placeholder-surface-muted focus:outline-none focus:ring-2 focus:ring-brand/50 focus:border-brand transition-colors"
                placeholder="you@example.com"
              />
            </div>

            <div>
              <label htmlFor="password" className="block text-xs font-medium text-ftc-mid mb-1.5">
                Password
              </label>
              <input
                id="password"
                type="password"
                autoComplete="current-password"
                required
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="w-full rounded-xl border border-surface-border bg-surface px-4 py-2.5 text-sm text-ftc-gray placeholder-surface-muted focus:outline-none focus:ring-2 focus:ring-brand/50 focus:border-brand transition-colors"
                placeholder="••••••••"
              />
            </div>

            {error && (
              <p className="text-sm text-red-400 bg-red-400/10 rounded-xl px-4 py-2.5">
                {error}
              </p>
            )}

            <button
              type="submit"
              disabled={loading}
              className="w-full btn-brand py-2.5 rounded-xl text-sm font-semibold text-white disabled:opacity-60 transition-opacity"
            >
              {loading ? 'Signing in…' : 'Sign in'}
            </button>
          </form>
        </div>

        <p className="text-center text-xs text-surface-muted mt-6">
          FTC Transcribe — meeting notes, secured
        </p>
      </div>
    </div>
  );
}
