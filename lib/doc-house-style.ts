// FTC house style for exported meeting documents (.docx and .pdf).
//
// Ported from Document Studio in the Contacts app (src/features/documents/lib/
// houseStyle.ts + reformat.ts), which learned these tokens from the approved
// FTC reference documents and the brand guidelines. Both exporters import from
// here so a .docx and a .pdf of the same meeting are the same document.
//
// The conventions carried over:
//   · charcoal masthead band with the product wordmark reversed out in white
//   · a 3px orange accent rule directly under the band
//   · h1 document title over a thin light rule
//   · section headings as full-width orange bars with white caps ("bar" style)
//   · sub-headings in bold charcoal over a 2px orange rule
//   · two-column data (timestamp + topic) as a zebra-striped spec table
//   · Avenir Black headings / Avenir Roman body, Arial-safe for Word

export const DOC = {
  /** FTC primary — matches the app's --c-brand so screen and paper agree. */
  orange: '#f39200',
  /** Masthead band. */
  header: '#3d3d3d',
  /** Headings. */
  heading: '#3e3e3e',
  /** Body copy. */
  text: '#3e3e3e',
  /** Secondary text: dates, due labels, footer. */
  soft: '#555555',
  /** Alternating spec-row background. */
  zebra: '#f2f2f2',
  /** Hairline rules under the title and above the footer. */
  rule: '#e0e0e0',
  /** Table outline — a touch darker than `rule` so the block reads as a table. */
  tableLine: '#d6d6d6',
  white: '#ffffff',
} as const;

/** Word/docx rejects the leading '#', and 8-char ARGB. Six chars, no hash. */
export const hex6 = (c: string) => c.replace('#', '').toLowerCase();

// FTC brand guide: Avenir Black for headings, Avenir Roman for body. Both are
// Word-safe names, so Word keeps them where Avenir is installed and substitutes
// gracefully where it isn't. @react-pdf has no Avenir, so the PDF uses the
// metric-similar built-in Helvetica for the same visual weight.
export const FONT_HEADING = 'Avenir Black';
export const FONT_BODY = 'Avenir Roman';

/** Masthead strapline, left of the document title. */
export const MASTHEAD = 'FTC TRANSCRIBE';

/**
 * Section order — single source of truth for both exporters.
 *
 * Matches the on-screen order of the AI Notes panel exactly
 * (app/recordings/[id]/EditableAINotes.tsx): a reader following the document
 * and a reader following the screen see the same sequence.
 *
 * The transcript is deliberately absent. These exports are the meeting's
 * notes; the full verbatim transcript stays in the app, where it is
 * searchable and click-to-seek.
 */
export const SECTION_ORDER = [
  'topics',
  'summary',
  'actionItems',
  'keyPoints',
  'decisions',
] as const;

export type SectionKey = (typeof SECTION_ORDER)[number];

export const SECTION_LABELS: Record<SectionKey, string> = {
  topics: 'Topics',
  summary: 'Summary',
  actionItems: 'Action Items',
  keyPoints: 'Key Points',
  decisions: 'Decisions',
};

/** m:ss for topic and transcript timestamps. */
export function formatClock(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds || 0));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

export function formatLongDate(date: Date): string {
  return date.toLocaleDateString('en-GB', {
    weekday: 'long', day: 'numeric', month: 'long', year: 'numeric',
  });
}

export function formatShortDate(date: Date): string {
  return date.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });
}

