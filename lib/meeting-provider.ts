// How each conferencing service is presented. One table, so the recordings
// list and the recording page can never disagree about what a Zoom call looks
// like.
//
// Service brand colours are used deliberately here rather than the house green.
// A provider badge is an identity marker, the same job FTC Whisper's app icons
// do in its history list, and a recognisable Teams purple or Meet green is read
// faster than any amount of text.
import type { MeetingProvider } from '@/lib/capture-support';
import { PROVIDER_LABELS } from '@/lib/capture-support';

export type { MeetingProvider };
export { PROVIDER_LABELS };

export interface ProviderBadge {
  label: string;
  /** Tailwind classes for the pill: background + text. */
  className: string;
  /** Tailwind classes for the icon tile behind the mic/meeting glyph. */
  tileClassName: string;
  iconClassName: string;
}

const BADGES: Record<MeetingProvider, ProviderBadge> = {
  teams: {
    label: 'Teams',
    className: 'bg-[#4b53bc]/15 text-[#6264A7]',
    tileClassName: 'bg-[#4b53bc]/15',
    iconClassName: 'text-[#6264A7]',
  },
  meet: {
    label: 'Google Meet',
    className: 'bg-[#00832d]/15 text-[#34a853]',
    tileClassName: 'bg-[#00832d]/15',
    iconClassName: 'text-[#34a853]',
  },
  zoom: {
    label: 'Zoom',
    className: 'bg-[#2d8cff]/15 text-[#4a9eff]',
    tileClassName: 'bg-[#2d8cff]/15',
    iconClassName: 'text-[#4a9eff]',
  },
  webex: {
    label: 'Webex',
    className: 'bg-[#00bceb]/15 text-[#22c5ec]',
    tileClassName: 'bg-[#00bceb]/15',
    iconClassName: 'text-[#22c5ec]',
  },
  slack: {
    label: 'Slack',
    className: 'bg-[#611f69]/20 text-[#a97bb0]',
    tileClassName: 'bg-[#611f69]/20',
    iconClassName: 'text-[#a97bb0]',
  },
  generic: {
    label: 'Online meeting',
    className: 'bg-[#4b53bc]/15 text-[#8b8fd6]',
    tileClassName: 'bg-[#4b53bc]/15',
    iconClassName: 'text-[#8b8fd6]',
  },
};

/**
 * Badge for a recording. `provider` is null on everything captured before
 * detection existed, which is the whole back catalogue — those fall back to the
 * neutral badge rather than claiming a service nobody recorded.
 */
export function providerBadge(
  source: string,
  provider: string | null | undefined,
): ProviderBadge | null {
  if (source !== 'teams') return null;
  const key = (provider ?? 'generic') as MeetingProvider;
  return BADGES[key] ?? BADGES.generic;
}
