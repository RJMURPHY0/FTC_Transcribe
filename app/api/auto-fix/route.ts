// Webhook endpoint called by Supabase Database Webhooks when a new row is
// inserted into the error_log table.
//
// Security: requests must carry the header  X-Auto-Fix-Secret: <value>
// matching the AUTO_FIX_SECRET env var.  Set this same value in Supabase
// as a custom webhook header.
//
// Deduplication: an AutoFixAttempt row is inserted before the fix starts.
// If an attempt with the same errorHash already exists within 24 h, the
// webhook returns 200 immediately without creating a duplicate PR.

import { NextRequest, NextResponse } from 'next/server';
import { createHash } from 'crypto';
import { prisma } from '@/lib/db';
import { runAutoFix } from '@/lib/auto-fix';

// Supabase wraps the inserted row under { type, table, record: {...} }.
// We also accept a flat { message, source, context } for manual testing.
interface SupabaseWebhookPayload {
  type?: string;
  table?: string;
  record?: {
    message?: string;
    source?: string;
    context?: string | Record<string, unknown>;
    created_at?: string;
  };
  // flat form
  message?: string;
  source?: string;
  context?: string | Record<string, unknown>;
}

function parseContext(raw: string | Record<string, unknown> | undefined): Record<string, unknown> {
  if (!raw) return {};
  if (typeof raw === 'object') return raw;
  try { return JSON.parse(raw) as Record<string, unknown>; } catch { return {}; }
}

export async function POST(request: NextRequest) {
  // ── Auth ─────────────────────────────────────────────────────────────────
  // Fail closed: AUTO_FIX_SECRET must be set AND match. An unset secret used
  // to allow every request through — on this public (middleware-exempt) route
  // that let anyone trigger AI auto-fix runs. The secret is configured in
  // Vercel (Production + Development), so real webhook traffic is unaffected.
  const secret = process.env.AUTO_FIX_SECRET;
  const provided = request.headers.get('x-auto-fix-secret') ?? request.headers.get('x-webhook-secret');
  if (!secret || provided !== secret) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  // ── Parse ─────────────────────────────────────────────────────────────────
  let body: SupabaseWebhookPayload;
  try {
    body = await request.json() as SupabaseWebhookPayload;
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  const record   = body.record ?? body;
  const errorMsg = typeof record.message === 'string' ? record.message.trim() : '';
  const source   = typeof record.source  === 'string' ? record.source.trim()  : 'unknown';
  const context  = parseContext(record.context);

  if (!errorMsg) {
    return NextResponse.json({ ok: true, skipped: true, reason: 'empty message' });
  }

  // ── Dedup (24 h window) ───────────────────────────────────────────────────
  const errorHash = createHash('sha256').update(errorMsg).digest('hex').slice(0, 16);
  const cutoff    = new Date(Date.now() - 24 * 60 * 60 * 1000);

  let attempt: { id: string } | null = null;
  try {
    const recent = await prisma.autoFixAttempt.findFirst({
      where: { errorHash, createdAt: { gte: cutoff } },
      select: { id: true, status: true, prUrl: true },
    });

    if (recent) {
      return NextResponse.json({
        ok: true,
        skipped: true,
        reason: `Already processed this error (attempt ${recent.id}, status ${recent.status})`,
        prUrl: recent.prUrl,
      });
    }

    // Reserve a slot immediately to prevent concurrent webhooks racing
    attempt = await prisma.autoFixAttempt.create({
      data: { errorHash, errorMsg, source, status: 'pending' },
    });
  } catch (err) {
    // DB not ready / migration not run — log and continue without dedup
    console.warn('[auto-fix] dedup DB unavailable:', err instanceof Error ? err.message : err);
  }

  // ── Run the fix (non-blocking — respond quickly to Supabase) ─────────────
  // Vercel allows fire-and-forget via waitUntil on supported runtimes.
  // For simplicity we await it here; the function timeout is set to 120 s.
  const result = await runAutoFix({ errorMsg, errorContext: context, source });

  if (attempt) {
    await prisma.autoFixAttempt.update({
      where: { id: attempt.id },
      data:  {
        status: result.status,
        prUrl:  result.prUrl ?? null,
      },
    }).catch(() => {});
  }

  return NextResponse.json({
    ok:     true,
    status: result.status,
    prUrl:  result.prUrl,
    reason: result.reason,
  });
}
