// Platform matrix for meeting-audio capture.
//
// The rules encode what browsers actually deliver, which no feature test can
// discover before a recording is already running and silent:
//
//   Chromium on Windows : tab audio AND whole-screen system audio
//   Chromium on macOS   : tab audio only — a browser cannot reach a native
//                         Teams/Zoom window there at all
//   Safari, Firefox     : no audio from getDisplayMedia, ever
//   Mobile              : no getDisplayMedia at all
//
// Usage: npx tsx scripts/test-capture-support.ts

import {
  detectCaptureSupport,
  detectPlatform,
  providerFromDeviceLabels,
  providerFromTitle,
  validateDisplaySurface,
} from '../lib/capture-support';

const UA = {
  winChrome:  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  winEdge:    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 Edg/131.0.0.0',
  macChrome:  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  macSafari:  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.1 Safari/605.1.15',
  firefox:    'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:121.0) Gecko/20100101 Firefox/121.0',
  iphone:     'Mozilla/5.0 (iPhone; CPU iPhone OS 17_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.1 Mobile/15E148 Safari/604.1',
  ipad:       'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.1 Safari/605.1.15',
  android:    'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36',
};

function withUA<T>(ua: string, platform: string, touchPoints: number, fn: () => T): T {
  // Node exposes `navigator` as a getter-only global, so it has to be redefined
  // rather than assigned.
  Object.defineProperty(globalThis, 'navigator', {
    value: { userAgent: ua, platform, maxTouchPoints: touchPoints, mediaDevices: {} },
    configurable: true,
    writable: true,
  });
  return fn();
}

interface Case {
  name: string;
  ua: string;
  platform: string;
  touch: number;
  level: 'screen' | 'tab-only' | 'none';
  nativeApps: boolean;
  mobile: boolean;
}

const CASES: Case[] = [
  { name: 'Windows Chrome', ua: UA.winChrome, platform: 'Win32',   touch: 0, level: 'screen',   nativeApps: true,  mobile: false },
  { name: 'Windows Edge',   ua: UA.winEdge,   platform: 'Win32',   touch: 0, level: 'screen',   nativeApps: true,  mobile: false },
  { name: 'macOS Chrome',   ua: UA.macChrome, platform: 'MacIntel', touch: 0, level: 'tab-only', nativeApps: false, mobile: false },
  { name: 'macOS Safari',   ua: UA.macSafari, platform: 'MacIntel', touch: 0, level: 'none',    nativeApps: false, mobile: false },
  { name: 'Firefox',        ua: UA.firefox,   platform: 'Win32',   touch: 0, level: 'none',     nativeApps: false, mobile: false },
  { name: 'iPhone Safari',  ua: UA.iphone,    platform: 'iPhone',  touch: 5, level: 'none',     nativeApps: false, mobile: true  },
  { name: 'iPad Safari',    ua: UA.ipad,      platform: 'MacIntel', touch: 5, level: 'none',    nativeApps: false, mobile: true  },
  { name: 'Android Chrome', ua: UA.android,   platform: 'Linux armv8l', touch: 5, level: 'none', nativeApps: false, mobile: true },
];

let failures = 0;
const check = (ok: boolean, label: string, detail = '') => {
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
};

for (const c of CASES) {
  const { support, platform } = withUA(c.ua, c.platform, c.touch, () => ({
    support: detectCaptureSupport(),
    platform: detectPlatform(),
  }));
  check(support.level === c.level, `${c.name}: level`, `expected ${c.level}, got ${support.level}`);
  check(support.canCaptureNativeApps === c.nativeApps, `${c.name}: native app capture`, `expected ${c.nativeApps}`);
  check(platform.isMobile === c.mobile, `${c.name}: mobile detection`, `expected ${c.mobile}`);
  // Anything that cannot capture must explain itself, and anything that can
  // must tell the user what to pick. Silent failure is the bug being fixed.
  if (support.level === 'none') {
    check(!!support.blockedReason, `${c.name}: explains why it is unavailable`);
  } else {
    check(!!support.instruction, `${c.name}: gives picker instructions`);
  }
}

// Surface validation: on a tab-only platform, only a tab carries audio.
const macSupport = withUA(UA.macChrome, 'MacIntel', 0, detectCaptureSupport);
const winSupport = withUA(UA.winChrome, 'Win32', 0, detectCaptureSupport);
check(validateDisplaySurface('monitor', macSupport) !== null, 'macOS: whole-screen share is rejected up front');
check(validateDisplaySurface('window', macSupport) !== null, 'macOS: app-window share is rejected up front');
check(validateDisplaySurface('browser', macSupport) === null, 'macOS: tab share is accepted');
check(validateDisplaySurface('monitor', winSupport) === null, 'Windows: whole-screen share is accepted');
check(validateDisplaySurface(undefined, macSupport) === null, 'unknown surface defers to the audio-track check');

// Which conferencing service. The evidence is the title of the surface the
// user shared, which is the same evidence FTC Whisper works from on the
// desktop. A whole-screen share names nothing and must say so rather than
// guessing, because a wrong logo is worse than an honest "Online meeting".
const PROVIDER_CASES: Array<[string | undefined, string]> = [
  ['Meet - abc-defg-hij', 'meet'],
  ['Google Meet', 'meet'],
  ['meet.google.com/abc-defg-hij', 'meet'],
  ['Microsoft Teams', 'teams'],
  ['Chat | Microsoft Teams', 'teams'],
  ['Zoom Meeting', 'zoom'],
  ['Zoom Workplace', 'zoom'],
  ['Webex | Cisco', 'webex'],
  ['Slack huddle', 'slack'],
  // Named nothing: a monitor share, a blank tab, no label at all.
  ['screen:0:0', 'generic'],
  ['window:12345:0', 'generic'],
  ['Entire Screen', 'generic'],
  ['New Tab', 'generic'],
  ['', 'generic'],
  [undefined, 'generic'],
];
for (const [title, expected] of PROVIDER_CASES) {
  const got = providerFromTitle(title);
  check(got === expected, `title ${JSON.stringify(title)} -> ${expected}${got === expected ? '' : ` (got ${got})`}`);
}

// Device labels are the fallback when the surface named nothing. One installed
// conferencing app is a usable hint; two cannot say which meeting you are in.
check(
  providerFromDeviceLabels(['Microphone (Realtek)', 'Zoom Audio Device']) === 'zoom',
  'device labels: a single conferencing endpoint identifies the service',
);
check(
  providerFromDeviceLabels(['Teams Audio Device', 'Zoom Audio Device']) === 'generic',
  'device labels: two installed services stay generic',
);
check(
  providerFromDeviceLabels(['Microphone (Realtek)', 'Speakers (Realtek)']) === 'generic',
  'device labels: no conferencing endpoint stays generic',
);

console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
