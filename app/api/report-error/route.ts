import { NextRequest, NextResponse } from 'next/server';
import { reportError } from '@/lib/reportError';

export async function POST(request: NextRequest) {
  try {
    const body = await request.json() as { message?: unknown; context?: unknown };
    const message = typeof body.message === 'string' ? body.message.trim() : '';
    const context = body.context && typeof body.context === 'object' && !Array.isArray(body.context)
      ? body.context as Record<string, unknown>
      : {};
    if (message) await reportError(message, context);
  } catch {
    // Never fail
  }
  return NextResponse.json({ ok: true });
}
