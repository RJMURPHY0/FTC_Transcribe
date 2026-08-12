// What system-audio capture a browser can ACTUALLY deliver, per platform.
//
// `getDisplayMedia` exists almost everywhere, so feature-detecting it tells you
// nothing useful. The real question is whether an audio track comes back, and
// that varies by operating system in a way nothing can probe until the user has
// already picked a surface and the recording has started:
//
//   Chromium on Windows / ChromeOS : whole-screen system audio AND tab audio
//   Chromium on macOS / Linux      : tab audio only, never system or window audio
//   Safari (desktop and iOS)       : no audio in getDisplayMedia, ever
//   Firefox                        : no audio in getDisplayMedia, ever
//   Any mobile browser             : no getDisplayMedia at all
//
// Getting this wrong is expensive rather than merely untidy. Telling a Mac user
// to "share your whole screen" yields a recording of pure silence, and nobody
// finds out until the meeting is over and the transcript is empty.

export type CaptureLevel = 'screen' | 'tab-only' | 'none';

export interface CaptureSupport {
  level: CaptureLevel;
  /** One line for the UI explaining what this browser can do. */
  instruction: string;
  /** Set when the mode cannot work at all, so the UI can say why. */
  blockedReason?: string;
  /**
   * Whether the Teams/Zoom DESKTOP apps can be captured. False on macOS: a
   * browser there can only reach into another browser tab, never a native
   * window. That is a platform limit, not something to work around.
   */
  canCaptureNativeApps: boolean;
}

interface Platform {
  isMobile: boolean;
  isMac: boolean;
  isWindows: boolean;
  isSafari: boolean;
  isFirefox: boolean;
  isChromium: boolean;
}

export function detectPlatform(): Platform {
  if (typeof navigator === 'undefined') {
    return { isMobile: false, isMac: false, isWindows: false, isSafari: false, isFirefox: false, isChromium: false };
  }
  const ua = navigator.userAgent;
  // iPadOS 13+ reports a desktop Mac UA. Touch points are the only reliable
  // separator, and getting it wrong would offer meeting capture on an iPad
  // where it cannot work.
  const isIpad = /Macintosh/.test(ua) && (navigator.maxTouchPoints ?? 0) > 1;
  const isMobile = /Android|iPhone|iPad|iPod/i.test(ua) || isIpad;
  const isFirefox = /Firefox|FxiOS/i.test(ua);
  // Every iOS browser is Safari underneath, so Chrome on iOS has Safari's
  // limits, not Chrome's.
  const isSafari = !isFirefox && /Safari/i.test(ua) && !/Chrome|Chromium|Edg\//i.test(ua)
    || /iPhone|iPad|iPod/i.test(ua) || isIpad;
  const isChromium = !isFirefox && !isSafari && /Chrome|Chromium|Edg\//i.test(ua);

  const uaPlatform = (navigator as Navigator & {
    userAgentData?: { platform?: string };
  }).userAgentData?.platform;
  const platformStr = (uaPlatform || navigator.platform || '').toLowerCase();
  const isMac = !isMobile && (platformStr.includes('mac') || /Macintosh/.test(ua));
  const isWindows = platformStr.includes('win') || /Windows/i.test(ua);

  return { isMobile, isMac, isWindows, isSafari, isFirefox, isChromium };
}

export function detectCaptureSupport(): CaptureSupport {
  const p = detectPlatform();

  if (p.isMobile) {
    return {
      level: 'none',
      instruction: '',
      blockedReason: 'Phones and tablets cannot capture call audio. Join the meeting on a computer, or use In Person to record the room.',
      canCaptureNativeApps: false,
    };
  }

  if (p.isSafari || p.isFirefox) {
    return {
      level: 'none',
      instruction: '',
      blockedReason: `${p.isSafari ? 'Safari' : 'Firefox'} cannot capture call audio. Open this page in Chrome or Edge to record an online meeting.`,
      canCaptureNativeApps: false,
    };
  }

  if (!p.isChromium) {
    return {
      level: 'none',
      instruction: '',
      blockedReason: 'This browser cannot capture call audio. Use Chrome or Edge to record an online meeting.',
      canCaptureNativeApps: false,
    };
  }

  // Chromium on macOS and Linux gets tab audio only. Sharing a whole screen or
  // an app window returns a video track with no audio, so the Teams and Zoom
  // desktop apps are simply out of reach there.
  if (p.isMac) {
    return {
      level: 'tab-only',
      instruction: 'Join the meeting in a browser tab, then pick that tab and tick “Also share tab audio”. On a Mac, sharing a whole screen or the Teams/Zoom app captures no sound.',
      canCaptureNativeApps: false,
    };
  }

  if (!p.isWindows) {
    return {
      level: 'tab-only',
      instruction: 'Join the meeting in a browser tab, then pick that tab and tick “Also share tab audio”.',
      canCaptureNativeApps: false,
    };
  }

  return {
    level: 'screen',
    instruction: 'Pick the meeting tab and tick “Also share tab audio”, or pick Entire Screen and tick “Share system audio” for the Teams or Zoom app.',
    canCaptureNativeApps: true,
  };
}

// Whether the surface the user actually chose will produce audio. Chrome hands
// back the display surface on the video track, so a doomed pick can be rejected
// in the first second instead of silently recording nothing for an hour.
export function validateDisplaySurface(
  surface: string | undefined,
  support: CaptureSupport,
): string | null {
  if (!surface) return null; // Nothing reported — let the audio-track check decide.
  if (support.level === 'screen') return null;
  if (surface === 'browser') return null;
  return 'On a Mac, only a browser tab carries audio. Open the meeting in a tab, then start again and choose that tab with “Also share tab audio” ticked.';
}

// ── Meeting context ──────────────────────────────────────────────────────────

export type MeetingContext = 'likely' | 'unlikely' | 'unknown';

/**
 * Best-effort guess at whether the user is in an online meeting, based on the
 * conferencing virtual audio endpoints those apps install.
 *
 * Deliberately a suggestion and never an action. A web page cannot see other
 * tabs or running processes, and browsers block that on purpose, so anything
 * stronger than "default the toggle" would be claiming a certainty we do not
 * have. Device labels are also empty until mic permission has been granted at
 * least once, hence 'unknown'.
 */
export async function detectMeetingContext(): Promise<MeetingContext> {
  if (typeof navigator === 'undefined' || !navigator.mediaDevices?.enumerateDevices) return 'unknown';
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    const audio = devices.filter((d) => d.kind === 'audioinput' || d.kind === 'audiooutput');
    if (!audio.length || audio.every((d) => !d.label)) return 'unknown';
    const hit = audio.some((d) => {
      const n = d.label.toLowerCase();
      return CONFERENCING_HINTS.some((h) => n.includes(h));
    });
    return hit ? 'likely' : 'unlikely';
  } catch {
    return 'unknown';
  }
}

// Virtual audio endpoints installed by conferencing apps. Shared with
// lib/mic-select.ts, which must never pick one as a microphone (they hear the
// speakers, not the user) while this module treats their presence as a hint
// that a meeting app is installed. Two copies of this list would drift.
export const CONFERENCING_HINTS = [
  'teams audio', 'zoom audio', 'zoomaudiodevice', 'google meet', 'webex',
  'goto meeting', 'gotomeeting', 'discord', 'slack huddle',
];
