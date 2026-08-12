// Keeping a phone awake for the length of a meeting.
//
// Three layers, because no single one is reliable:
//
//   1. Screen Wake Lock API — a real OS-level lock (iOS Safari 16.4+, Chrome
//      84+). Stops the auto-lock timer. The browser drops it whenever the page
//      is hidden, and iOS refuses it outright in Low Power Mode.
//   2. nosleep.js — a hidden looping video, for browsers without the API.
//      MUST be started inside a user gesture on iOS.
//   3. A silent audio track plus a Media Session — iOS treats the page as
//      actively playing media, which extends how long it survives a lock or an
//      app switch.
//
// None of these can override the OS. Nothing on the web stops someone pressing
// the power button, and iOS Safari cannot record with the screen locked no
// matter what this module does. The honest goal is: lock less often, lose less
// when it happens, and always know whether we actually hold the lock so the UI
// can say so rather than showing a ticking timer over a dead recorder.

interface WakeSentinel {
  release(): Promise<void>;
  addEventListener?(type: 'release', listener: () => void): void;
}

interface NoSleepLike {
  enable(): Promise<void> | void;
  disable(): void;
}

type NoSleepCtor = new () => NoSleepLike;

let noSleepCtor: NoSleepCtor | null = null;

/**
 * Resolve the nosleep.js module ahead of time.
 *
 * This exists purely so priming can be synchronous. iOS only honours
 * `video.play()` inside a live user-gesture token, and `await import(...)`
 * spends it. Previously the fallback was imported after two other awaits, so
 * it silently failed on exactly the devices that needed it. Call this on mount;
 * by the time anyone taps record the constructor is already in hand.
 */
export async function preloadKeepAwake(): Promise<void> {
  if (noSleepCtor) return;
  try {
    const mod = await import('nosleep.js');
    noSleepCtor = (mod.default ?? mod) as unknown as NoSleepCtor;
  } catch {
    // Fallback unavailable; the native lock is still tried.
  }
}

function isIOS(): boolean {
  if (typeof navigator === 'undefined') return false;
  const ua = navigator.userAgent;
  return /iPhone|iPad|iPod/i.test(ua)
    || (/Macintosh/.test(ua) && (navigator.maxTouchPoints ?? 0) > 1);
}

// One second of digital silence as a WAV. Built rather than embedded as a
// base64 blob so it is obvious what it is and there is no chance of a truncated
// data URI that fails to loop.
function silentWavUrl(): string {
  const sampleRate = 8000;
  const samples = sampleRate; // 1s, looped
  const dataBytes = samples * 2;
  const buf = new ArrayBuffer(44 + dataBytes);
  const view = new DataView(buf);
  const ascii = (offset: number, text: string) => {
    for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i));
  };
  ascii(0, 'RIFF');
  view.setUint32(4, 36 + dataBytes, true);
  ascii(8, 'WAVE');
  ascii(12, 'fmt ');
  view.setUint32(16, 16, true);      // PCM header size
  view.setUint16(20, 1, true);       // PCM
  view.setUint16(22, 1, true);       // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);       // block align
  view.setUint16(34, 16, true);      // bits per sample
  ascii(36, 'data');
  view.setUint32(40, dataBytes, true);
  // Samples are left at zero: silent by content, not muted. A muted element
  // does not count as playing media to iOS, which defeats the point.
  return URL.createObjectURL(new Blob([buf], { type: 'audio/wav' }));
}

export class KeepAwake {
  private sentinel: WakeSentinel | null = null;
  private noSleep: NoSleepLike | null = null;
  private audio: HTMLAudioElement | null = null;
  private audioUrl: string | null = null;
  private engaged = false;
  private onChange: (held: boolean) => void;

  constructor(onChange: (held: boolean) => void = () => {}) {
    this.onChange = onChange;
  }

  get held(): boolean {
    return this.sentinel !== null || this.noSleep !== null;
  }

  /**
   * Start everything that needs a user gesture. Call this SYNCHRONOUSLY from a
   * click handler, before any await. Both the nosleep video and the silent
   * audio need the gesture token; anything awaited first has already lost it.
   */
  primeFromGesture(): void {
    this.engaged = true;

    if (!this.noSleep && noSleepCtor) {
      try {
        const ns = new noSleepCtor();
        // enable() may return a promise; the play() call inside it has already
        // been issued synchronously, which is the part that needs the gesture.
        void Promise.resolve(ns.enable()).catch(() => {});
        this.noSleep = ns;
      } catch {
        this.noSleep = null;
      }
    }

    // The audio session only helps where the page gets frozen on lock, and it
    // is the one layer with a plausible downside (it shares the audio session
    // with the mic capture). Restrict it to iOS, where it is both needed and
    // the recorder is otherwise lost within seconds of the screen going off.
    if (isIOS() && !this.audio) {
      try {
        const url = silentWavUrl();
        const el = new Audio(url);
        el.loop = true;
        el.setAttribute('playsinline', '');
        void el.play().catch(() => {});
        this.audio = el;
        this.audioUrl = url;
      } catch {
        this.audio = null;
      }
    }
  }

  /**
   * Upgrade to the native lock. Safe to await; the gesture-sensitive work has
   * already happened in primeFromGesture.
   */
  async engage(): Promise<boolean> {
    this.engaged = true;
    await this.acquireNative();
    this.setMediaSession();
    const held = this.held;
    this.onChange(held);
    return held;
  }

  /**
   * Re-take the native lock if it was dropped. The browser releases it whenever
   * the page is hidden, and it can also lapse while the page is still visible,
   * so this runs on a timer as well as on visibilitychange.
   */
  async reacquire(): Promise<void> {
    if (!this.engaged) return;
    if (typeof document !== 'undefined' && document.visibilityState !== 'visible') return;
    if (this.sentinel) return;
    await this.acquireNative();
    // The silent track can be stopped by an interruption (a phone call, another
    // app taking the session). Restarting needs no gesture once it has played.
    if (this.audio?.paused) void this.audio.play().catch(() => {});
    this.onChange(this.held);
  }

  private async acquireNative(): Promise<void> {
    if (typeof navigator === 'undefined' || this.sentinel) return;
    try {
      const nav = navigator as Navigator & {
        wakeLock?: { request(type: 'screen'): Promise<WakeSentinel> };
      };
      if (!nav.wakeLock) return;
      const sentinel = await nav.wakeLock.request('screen');
      sentinel.addEventListener?.('release', () => {
        this.sentinel = null;
        this.onChange(this.held);
      });
      this.sentinel = sentinel;
    } catch {
      // Refused: Low Power Mode is the usual cause. The nosleep video and the
      // caller's warning banner are what is left.
    }
  }

  private setMediaSession(): void {
    if (typeof navigator === 'undefined' || !('mediaSession' in navigator)) return;
    const ms = navigator.mediaSession;
    try {
      if (typeof MediaMetadata !== 'undefined') {
        ms.metadata = new MediaMetadata({
          title: 'Recording in progress',
          artist: 'FTC Transcribe',
        });
      }
      ms.playbackState = 'playing';
      // Swallow the transport controls. Without handlers a headphone button or
      // a lock-screen pause stops the silent track and takes the keepalive with
      // it, which is precisely the failure this is meant to prevent.
      const actions: MediaSessionAction[] = ['play', 'pause', 'stop', 'previoustrack', 'nexttrack'];
      for (const action of actions) {
        try { ms.setActionHandler(action, () => {}); } catch { /* unsupported action */ }
      }
    } catch {
      // Media Session is decoration here, never load-bearing.
    }
  }

  release(): void {
    this.engaged = false;
    this.sentinel?.release().catch(() => {});
    this.sentinel = null;
    try { this.noSleep?.disable(); } catch { /* already gone */ }
    this.noSleep = null;
    if (this.audio) {
      try { this.audio.pause(); this.audio.src = ''; } catch { /* already gone */ }
      this.audio = null;
    }
    if (this.audioUrl) {
      URL.revokeObjectURL(this.audioUrl);
      this.audioUrl = null;
    }
    if (typeof navigator !== 'undefined' && 'mediaSession' in navigator) {
      try { navigator.mediaSession.playbackState = 'none'; } catch { /* ignore */ }
    }
    this.onChange(false);
  }
}
