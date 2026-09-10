// One definition of "what is the list filtered to", shared by the dashboard
// list, its stat tiles and the search dropdown.
//
// Before this, the filter panel only ever narrowed the search popover: picking
// "This week" with an empty search box changed nothing on screen, which reads
// as a broken filter. Everything now travels in the URL, so the server-rendered
// list, the counts above it and the dropdown can never disagree, and a filtered
// view is a link you can share or reload.
//
// Dependency-free on purpose (no Prisma types, no React) so it can be unit
// tested and imported from both a server component and a route handler.

export type SourceFilter = 'web' | 'teams';
export type DateFilter   = 'today' | 'week' | 'month' | 'quarter' | 'year';
export type SortFilter   = 'newest' | 'oldest' | 'longest' | 'shortest';

export const MEETING_TYPES = ['general', 'standup', 'sales', 'interview', 'review'] as const;
export type MeetingTypeFilter = (typeof MEETING_TYPES)[number];

// A recording's lifecycle state, narrowed to the two a viewer actually wants to
// filter by. Drives the clickable "Complete" stat tile and a Status row in the
// filter panel. Kept exact (a single DB status each) so the where clause is a
// plain equality — "in progress" spans uploading/queued/processing and is left
// out rather than mapped imprecisely.
export const STATUS_FILTERS = ['completed', 'failed'] as const;
export type StatusFilter = (typeof STATUS_FILTERS)[number];

export const STATUS_LABELS: Record<StatusFilter, string> = {
  completed: 'Completed', failed: 'Failed',
};

export const MEETING_TYPE_LABELS: Record<MeetingTypeFilter, string> = {
  general: 'General', standup: 'Standup', sales: 'Sales', interview: 'Interview', review: 'Review',
};

// Rolling windows, not calendar boundaries — they match the "This week" stat
// tile, which has always counted the last 7 days.
export const DATE_LABELS: Record<DateFilter, string> = {
  today: 'Today', week: 'This week', month: 'This month', quarter: 'Last 3 months', year: 'This year',
};

export const DATE_DAYS: Record<DateFilter, number> = {
  today: 1, week: 7, month: 30, quarter: 90, year: 365,
};

export const MEETING_PROVIDERS = ['teams', 'meet', 'zoom', 'webex', 'slack', 'generic'] as const;
export type ProviderFilter = (typeof MEETING_PROVIDERS)[number];

export const PROVIDER_LABELS: Record<ProviderFilter, string> = {
  teams: 'Teams', meet: 'Google Meet', zoom: 'Zoom', webex: 'Webex', slack: 'Slack', generic: 'Other',
};

export interface RecordingFilters {
  source?:   SourceFilter;
  provider?: ProviderFilter;
  type?:     MeetingTypeFilter;
  status?:   StatusFilter;
  date?:     DateFilter;
  /** Explicit bounds, used by the AI filter for things like "in August". */
  from?:     string;   // ISO
  to?:       string;   // ISO
  /** Free-text terms ORed across title, AI notes and transcript. */
  terms:     string[];
  /** Only meetings whose summary lists at least one action item. */
  hasActions: boolean;
  minMinutes?: number;
  maxMinutes?: number;
  sort:      SortFilter;
  /** Human-readable name for an AI-built filter, shown as a chip. */
  label?:    string;
}

export const EMPTY_FILTERS: RecordingFilters = { terms: [], hasActions: false, sort: 'newest' };

/** Every URL key this module owns. Used when rebuilding links so a filtered
 *  view survives paging, folder navigation and the source tabs. */
export const FILTER_KEYS = [
  'source', 'provider', 'type', 'status', 'date', 'from', 'to', 'terms', 'has', 'minMin', 'maxMin', 'sort', 'label',
] as const;

type Params = { get(key: string): string | null };

function oneOf<T extends string>(value: string | null, allowed: readonly T[]): T | undefined {
  return value && (allowed as readonly string[]).includes(value) ? (value as T) : undefined;
}

/** A bare YYYY-MM-DD parses as midnight, which would exclude everything
 *  recorded on the day itself. As an upper bound it means end of that day. */
export function isoOrUndefined(value: string | null, endOfDay = false): string | undefined {
  if (!value) return undefined;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return undefined;
  if (endOfDay && /^\d{4}-\d{2}-\d{2}$/.test(value.trim())) d.setUTCHours(23, 59, 59, 999);
  return d.toISOString();
}

function positiveNumber(value: string | null): number | undefined {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

/** Read filters out of a URLSearchParams (route handler) or a plain
 *  searchParams object (server component). Anything unrecognised is dropped,
 *  so a hand-edited URL can't produce a query we didn't intend. */
export function parseFilters(input: Params | Record<string, string | string[] | undefined>): RecordingFilters {
  const params: Params = typeof (input as Params).get === 'function'
    ? (input as Params)
    : { get: (k: string) => {
        const v = (input as Record<string, string | string[] | undefined>)[k];
        return Array.isArray(v) ? v[0] ?? null : v ?? null;
      } };

  const terms = (params.get('terms') ?? '')
    .split(',')
    .map((t) => t.trim())
    .filter((t) => t.length > 1)
    .slice(0, 8);

  return {
    source:     oneOf(params.get('source'), ['web', 'teams'] as const),
    provider:   oneOf(params.get('provider'), MEETING_PROVIDERS),
    type:       oneOf(params.get('type'), MEETING_TYPES),
    status:     oneOf(params.get('status'), STATUS_FILTERS),
    date:       oneOf(params.get('date'), ['today', 'week', 'month', 'quarter', 'year'] as const),
    from:       isoOrUndefined(params.get('from')),
    to:         isoOrUndefined(params.get('to'), true),
    terms,
    hasActions: (params.get('has') ?? '').split(',').includes('actions'),
    minMinutes: positiveNumber(params.get('minMin')),
    maxMinutes: positiveNumber(params.get('maxMin')),
    sort:       oneOf(params.get('sort'), ['newest', 'oldest', 'longest', 'shortest'] as const) ?? 'newest',
    label:      params.get('label')?.slice(0, 80) || undefined,
  };
}

/** Back to URL params — the inverse of parseFilters, so the panel, the chips
 *  and every in-page link round-trip through the same shape. */
export function filtersToParams(f: RecordingFilters): Record<string, string> {
  const out: Record<string, string> = {};
  if (f.source)     out.source   = f.source;
  if (f.provider)   out.provider = f.provider;
  if (f.type)       out.type     = f.type;
  if (f.status)     out.status   = f.status;
  if (f.date)       out.date     = f.date;
  if (f.from)       out.from     = f.from;
  if (f.to)         out.to       = f.to;
  if (f.terms.length) out.terms  = f.terms.join(',');
  if (f.hasActions) out.has      = 'actions';
  if (f.minMinutes) out.minMin   = String(f.minMinutes);
  if (f.maxMinutes) out.maxMin   = String(f.maxMinutes);
  if (f.sort !== 'newest') out.sort = f.sort;
  if (f.label)      out.label    = f.label;
  return out;
}

export function hasAnyFilter(f: RecordingFilters): boolean {
  return Object.keys(filtersToParams(f)).length > 0;
}

/** The lower bound a `date` window implies, resolved against a clock passed in
 *  so tests don't depend on the current time. */
export function dateFloor(date: DateFilter | undefined, now: Date = new Date()): Date | undefined {
  if (!date) return undefined;
  return new Date(now.getTime() - DATE_DAYS[date] * 86_400_000);
}

/** A Prisma `where` fragment. Typed loosely (Record) so this file stays free of
 *  Prisma imports; every caller spreads it into a properly typed where. */
export function filtersToWhere(f: RecordingFilters, now: Date = new Date()): Record<string, unknown> {
  const where: Record<string, unknown> = {};

  if (f.source)   where.source = f.source;
  if (f.provider) where.meetingProvider = f.provider;
  if (f.type)     where.meetingType = f.type;
  if (f.status)   where.status = f.status;

  // `date` is the panel's rolling window; `from`/`to` are explicit bounds the
  // AI filter produces. Both can be present — the tighter floor wins.
  const floor = dateFloor(f.date, now);
  const from  = f.from ? new Date(f.from) : undefined;
  const gte   = floor && from ? new Date(Math.max(floor.getTime(), from.getTime())) : (floor ?? from);
  const lte   = f.to ? new Date(f.to) : undefined;
  if (gte || lte) where.createdAt = { ...(gte ? { gte } : {}), ...(lte ? { lte } : {}) };

  if (f.minMinutes || f.maxMinutes) {
    where.duration = {
      ...(f.minMinutes ? { gte: Math.round(f.minMinutes * 60) } : {}),
      ...(f.maxMinutes ? { lte: Math.round(f.maxMinutes * 60) } : {}),
    };
  }

  // "Has actions" means the summary's actionItems JSON holds something other
  // than an empty array. Stored as a JSON string, so a length test is the
  // cheapest honest check.
  if (f.hasActions) {
    where.summary = { is: { actionItems: { notIn: ['', '[]'] } } };
  }

  // Terms are ORed with each other and, within a term, across the places a
  // meeting carries words: its title, its AI notes and its transcript.
  if (f.terms.length > 0) {
    where.OR = f.terms.map((term) => {
      const like = { contains: term, mode: 'insensitive' as const };
      return {
        OR: [
          { title: like },
          { summary: { is: { OR: [
            { overview: like }, { keyPoints: like }, { actionItems: like },
            { decisions: like }, { topics: like },
          ] } } },
          { transcript: { is: { fullText: like } } },
        ],
      };
    });
  }

  return where;
}

export function filtersToOrderBy(f: RecordingFilters): Record<string, 'asc' | 'desc'> {
  switch (f.sort) {
    case 'oldest':   return { createdAt: 'asc' };
    case 'longest':  return { duration: 'desc' };
    case 'shortest': return { duration: 'asc' };
    default:         return { createdAt: 'desc' };
  }
}

export interface FilterChip {
  key:   string;   // which URL params this chip clears
  keys:  string[];
  label: string;
}

/** What to show above the list, one removable chip per active filter. */
export function describeFilters(f: RecordingFilters): FilterChip[] {
  const chips: FilterChip[] = [];
  if (f.label)    chips.push({ key: 'label', keys: [...FILTER_KEYS], label: f.label });
  if (f.source)   chips.push({ key: 'source', keys: ['source'], label: f.source === 'web' ? 'In person' : 'Online' });
  if (f.provider) chips.push({ key: 'provider', keys: ['provider'], label: PROVIDER_LABELS[f.provider] });
  if (f.type)     chips.push({ key: 'type', keys: ['type'], label: MEETING_TYPE_LABELS[f.type] });
  if (f.status)   chips.push({ key: 'status', keys: ['status'], label: STATUS_LABELS[f.status] });
  if (f.date)     chips.push({ key: 'date', keys: ['date'], label: DATE_LABELS[f.date] });
  if (!f.date && (f.from || f.to)) {
    const fmt = (iso: string) => new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
    chips.push({
      key: 'range', keys: ['from', 'to'],
      label: f.from && f.to ? `${fmt(f.from)} – ${fmt(f.to)}` : f.from ? `After ${fmt(f.from)}` : `Before ${fmt(f.to!)}`,
    });
  }
  for (const term of f.terms) chips.push({ key: `term:${term}`, keys: ['terms'], label: `“${term}”` });
  if (f.hasActions) chips.push({ key: 'has', keys: ['has'], label: 'Has action items' });
  if (f.minMinutes) chips.push({ key: 'minMin', keys: ['minMin'], label: `Over ${f.minMinutes} min` });
  if (f.maxMinutes) chips.push({ key: 'maxMin', keys: ['maxMin'], label: `Under ${f.maxMinutes} min` });
  if (f.sort !== 'newest') {
    const sortLabels: Record<SortFilter, string> = {
      newest: 'Newest first', oldest: 'Oldest first', longest: 'Longest first', shortest: 'Shortest first',
    };
    chips.push({ key: 'sort', keys: ['sort'], label: sortLabels[f.sort] });
  }
  return chips;
}
