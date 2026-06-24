// Shared helpers for action-item due dates.
// Due dates are stored as a parallel array (aligned by index with actionItems),
// each entry an ISO `YYYY-MM-DD` string or null when no date was set.

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Coerce any value into a valid ISO date string (YYYY-MM-DD) or null. */
export function normaliseDue(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!ISO_DATE_RE.test(trimmed)) return null;
  // Reject impossible dates like 2026-13-40
  const d = new Date(`${trimmed}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return null;
  return trimmed;
}

/**
 * Parse a stored JSON due array into a clean (string|null)[] aligned to `length`.
 * Pads with null and truncates so it always matches the action-item count.
 */
export function parseDueArray(json: string | null | undefined, length: number): (string | null)[] {
  let raw: unknown[] = [];
  if (json) {
    try {
      const v = JSON.parse(json);
      if (Array.isArray(v)) raw = v;
    } catch { /* fall through to empty */ }
  }
  return Array.from({ length }, (_, i) => normaliseDue(raw[i]));
}

/** Human-readable due date, e.g. "27 Jun 2026". Returns null for no date. */
export function formatDue(iso: string | null | undefined): string | null {
  const d = normaliseDue(iso);
  if (!d) return null;
  return new Date(`${d}T00:00:00Z`).toLocaleDateString('en-GB', {
    day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC',
  });
}

export type DueStatus = 'overdue' | 'today' | 'upcoming' | 'none';

/** Status of a due date relative to `now` (defaults to today). */
export function dueStatus(iso: string | null | undefined, now: Date = new Date()): DueStatus {
  const d = normaliseDue(iso);
  if (!d) return 'none';
  const today = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const due = new Date(`${d}T00:00:00Z`);
  if (due.getTime() < today.getTime()) return 'overdue';
  if (due.getTime() === today.getTime()) return 'today';
  return 'upcoming';
}
