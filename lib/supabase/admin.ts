import { createClient, type SupabaseClient } from '@supabase/supabase-js';

// Service-role client for server-side storage access (bypasses RLS).
// Returns null when SUPABASE_SERVICE_ROLE_KEY isn't configured — callers must
// degrade gracefully (e.g. keep audio chunks in the DB instead of archiving).
export function getAdminClient(): SupabaseClient | null {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL || '';
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
  if (!url || !key) return null;
  return createClient(url, key, { auth: { persistSession: false } });
}
