// Shape of a meeting as the .docx and .pdf exporters consume it, plus the one
// place a Recording row is mapped onto it. Both export routes call
// `meetingDocFrom` so a Word and a PDF download of the same meeting can never
// disagree about what is in them.

import type { TopicSection } from '@/lib/ai';
import { parseDueArray } from '@/lib/action-items';

export interface MeetingDoc {
  title: string;
  createdAt: Date;
  overview: string;
  topics: TopicSection[];
  actionItems: string[];
  actionDue: (string | null)[];
  /** Indices of action items already ticked off — rendered struck through. */
  actionChecked: Set<number>;
  keyPoints: string[];
  decisions: string[];
}

function safeJson<T>(v: string | null | undefined, fallback: T): T {
  if (!v) return fallback;
  try {
    const parsed = JSON.parse(v) as unknown;
    return (parsed ?? fallback) as T;
  } catch { return fallback; }
}

interface SummaryRow {
  overview: string | null;
  keyPoints: string | null;
  actionItems: string | null;
  decisions: string | null;
  topics: string | null;
}

export function meetingDocFrom(recording: {
  title: string;
  createdAt: Date;
  summary?: (SummaryRow & Record<string, unknown>) | null;
}): MeetingDoc {
  const s = recording.summary;
  const actionItems: string[] = safeJson(s?.actionItems, []);
  const checked = safeJson<number[]>(s?.actionItemsChecked as string | undefined, []);
  return {
    title: recording.title,
    createdAt: recording.createdAt,
    overview: s?.overview ?? '',
    topics: safeJson<TopicSection[]>(s?.topics, []),
    actionItems,
    actionDue: parseDueArray(s?.actionItemsDue as string | undefined, actionItems.length),
    actionChecked: new Set(Array.isArray(checked) ? checked : []),
    keyPoints: safeJson<string[]>(s?.keyPoints, []),
    decisions: safeJson<string[]>(s?.decisions, []),
  };
}

/** "None" is the model's way of saying there were none — don't print a section. */
export const hasDecisions = (d: string[]) => d.length > 0 && d[0] !== 'None';

/** Filename stem shared by both exports. */
export function exportFilename(title: string): string {
  return title.replace(/[^a-z0-9 ]/gi, '_').trim() || 'meeting-notes';
}

/**
 * Documents are light surfaces, so they take the dark wordmark — the reversed
 * (white) mark the app uses on its dark UI is invisible on paper.
 * Falls back to the reversed mark if the dark artwork is ever missing.
 */
export async function readDocLogo(): Promise<Buffer | null> {
  const { readFile } = await import('fs/promises');
  const { join } = await import('path');
  for (const file of ['logo-dark.png', 'logo.png']) {
    try {
      return await readFile(join(process.cwd(), 'public', file));
    } catch { /* try the next candidate */ }
  }
  return null;
}
