'use client';

import { useState, useRef, useCallback, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { getAudioConstraint } from '@/lib/mic-select';
import { KeepAwake, preloadKeepAwake } from '@/lib/keep-awake';
import {
  detectCaptureSupport,
  detectMeetingContext,
  detectMeetingProvider,
  detectPlatform,
  validateDisplaySurface,
  type CaptureSupport,
  type MeetingProvider,
} from '@/lib/capture-support';

type State = 'idle' | 'recording' | 'uploading' | 'queued' | 'error';
type Source = 'web' | 'teams';
export type MeetingType = 'general' | 'standup' | 'sales' | 'interview' | 'review';

// A chunk only reaches the server when it rotates, so a freeze costs everything
// buffered since the last rotation. Phones are where freezes happen, so they
// rotate far more often: worst-case loss drops from two minutes to 45 seconds,
// paid for with more, smaller uploads.
const CHUNK_MS_DESKTOP = 2 * 60 * 1000;
const CHUNK_MS_MOBILE  = 45 * 1000;
const SILENCE_RMS = 0.01;
const SKIP_SPEECH_RATIO = 0.04; // skip upload if < 4% of chunk is speech
// MediaRecorder is asked for data every 500 ms. If nothing arrives for this
// long the recorder is wedged or the page was frozen by the OS (screen lock,
// app switch, Low Power Mode) — audio for that window is already lost, so the
// job is to notice, tell the user, and restart cleanly rather than sit there
// showing a running timer over a dead recorder.
const STALL_MS = 12_000;
const STALL_POLL_MS = 3_000;

const MEETING_TYPES: { id: MeetingType; label: string; icon: string }[] = [
  { id: 'general',   label: 'General',   icon: '💬' },
  { id: 'standup',   label: 'Standup',   icon: '🗓' },
  { id: 'sales',     label: 'Sales',     icon: '📈' },
  { id: 'interview', label: 'Interview', icon: '🎯' },
  { id: 'review',    label: 'Review',    icon: '📋' },
];

function formatTime(s: number) {
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  return h > 0
    ? `${h}:${String(m).padStart(2, '0')}:${String(ss).padStart(2, '0')}`
    : `${String(m).padStart(2, '0')}:${String(ss).padStart(2, '0')}`;
}

function getBestMime() {
  const types = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg'];
  if (typeof MediaRecorder === 'undefined') return 'audio/webm';
  return types.find((t) => MediaRecorder.isTypeSupported(t)) ?? 'audio/webm';
}

export default function RecordPage() {
  const [state, setState] = useState<State>('idle');
  const [source, setSource] = useState<Source>('web');
  const [meetingType, setMeetingType] = useState<MeetingType>('general');
  const [seconds,       setSeconds]       = useState(0);
  const [errorMsg,      setErrorMsg]      = useState('');
  const [chunksSaved,   setChunksSaved]   = useState(0);
  const [chunksFailed,  setChunksFailed]  = useState(0);
  const [voiceLevel,    setVoiceLevel]    = useState(0);
  const [captions,      setCaptions]      = useState<string[]>([]);
  const [captionsOpen,  setCaptionsOpen]  = useState(false);
  const [isPaused,      setIsPaused]      = useState(false);
  // null = not asked yet. false means the OS refused to keep the screen awake
  // (iOS Low Power Mode is the common cause) and the user needs to know, since
  // a locked screen suspends the page and loses audio.
  const [wakeLockHeld,  setWakeLockHeld]  = useState<boolean | null>(null);
  const [stalled,       setStalled]       = useState(false);
  // What this browser/OS can actually capture, and whether a meeting app looks
  // to be installed. Resolved on mount because both need `navigator`.
  const [capture,       setCapture]       = useState<CaptureSupport | null>(null);
  const [isMobile,      setIsMobile]      = useState(false);
  // Pre-flight answer to "can this device stay awake at all", probed on mount
  // so the warning lands before the meeting instead of during it.
  const [wakeLockPossible, setWakeLockPossible] = useState<boolean | null>(null);

  const router = useRouter();

  const streamRef       = useRef<MediaStream | null>(null);
  const recorderRef     = useRef<MediaRecorder | null>(null);
  const chunkBlobsRef   = useRef<Blob[]>([]);
  // Chunks whose upload failed after all in-request retries. Kept here and re-sent
  // (on reconnect, after the next successful upload, and at stop) instead of being
  // dropped — otherwise a brief network blip loses 2 minutes of the meeting.
  const failedChunksRef = useRef<{ blob: Blob; offset: number }[]>([]);
  // Meeting-capture mode ('teams'): the source display + mic streams being mixed,
  // plus the mixing AudioContext — tracked so we can fully release them on stop.
  const extraStreamsRef = useRef<MediaStream[]>([]);
  // Which conferencing service the shared surface turned out to be. Read once
  // at capture time, because a tab title changes as the meeting goes on.
  const providerRef     = useRef<MeetingProvider>('generic');
  const mixCtxRef       = useRef<AudioContext | null>(null);
  const timerRef        = useRef<ReturnType<typeof setInterval> | null>(null);
  const chunkTimerRef   = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mimeRef         = useRef('audio/webm');
  const recordingIdRef  = useRef<string | null>(null);
  const timeOffsetRef   = useRef(0);
  const chunkStartRef   = useRef(0);
  const isActiveRef     = useRef(false);
  const isStartingRef   = useRef(false);
  const isPausingRef    = useRef(false);                    // onstop is flushing a pause, not a final stop
  const pauseOffsetRef  = useRef(0);                        // frozen upload offset for the flushed tail
  const pauseHeaderRef  = useRef<ArrayBuffer | null>(null); // frozen WebM header for the flushed tail
  const keepAwakeRef    = useRef<KeepAwake | null>(null);
  // Rotation interval for this device — see CHUNK_MS_* above.
  const chunkMsRef      = useRef(CHUNK_MS_DESKTOP);
  const webmHeaderRef   = useRef<ArrayBuffer | null>(null);
  // Watchdog: when MediaRecorder last handed us audio, and a ref-held recovery
  // fn so the visibilitychange listener can call it without depending on
  // callbacks declared further down.
  const lastDataAtRef   = useRef(Date.now());
  const recoverRef      = useRef<(() => Promise<void>) | null>(null);
  // Same trick for the chunk flush, so the backgrounding listeners can force an
  // upload without depending on callbacks declared further down.
  const flushRef        = useRef<(() => Promise<void>) | null>(null);
  const isRecoveringRef = useRef(false);
  // Wall-clock timing. A per-second counter under-reports badly when the OS
  // freezes the page (the very case this screen has to survive), so the
  // displayed duration is derived from real timestamps instead.
  const runStartedAtRef = useRef(0);
  const bankedSecsRef   = useRef(0);

  // Deepgram live-captions WebSocket
  const dgWsRef         = useRef<WebSocket | null>(null);

  // VAD refs — energy-based, no WASM dependencies, works on every device
  const analyserRef     = useRef<AnalyserNode | null>(null);
  const audioCtxRef     = useRef<AudioContext | null>(null);
  const vadIntervalRef  = useRef<ReturnType<typeof setInterval> | null>(null);
  const speechMsRef     = useRef(0); // ms of detected speech in current 2-min window

  // Timer — runs only while actively recording (frozen while paused).
  // Derived from wall-clock timestamps rather than counting ticks: when the OS
  // freezes the page the interval stops firing, and a tick counter would then
  // under-report the meeting length by however long the screen was off.
  useEffect(() => {
    if (state !== 'recording' || isPaused) return;
    const tick = () => setSeconds(
      Math.floor(bankedSecsRef.current + (Date.now() - runStartedAtRef.current) / 1000),
    );
    tick();
    timerRef.current = setInterval(tick, 1000);
    return () => { if (timerRef.current) { clearInterval(timerRef.current); timerRef.current = null; } };
  }, [state, isPaused]);

  // Stall watchdog. MediaRecorder is asked for data every 500 ms; a long gap
  // means the recorder is wedged or the page was frozen. Surfacing it matters
  // more than the recovery: the previous behaviour showed a happily ticking
  // timer over a dead recorder, so users only discovered the loss afterwards.
  useEffect(() => {
    if (state !== 'recording' || isPaused) { setStalled(false); return; }
    const id = setInterval(() => {
      setStalled(Date.now() - lastDataAtRef.current > STALL_MS);
    }, STALL_POLL_MS);
    return () => clearInterval(id);
  }, [state, isPaused]);

  const startVAD = useCallback((stream: MediaStream) => {
    try {
      const ctx = new AudioContext();
      const src = ctx.createMediaStreamSource(stream);
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 1024;
      src.connect(analyser);
      audioCtxRef.current = ctx;
      analyserRef.current = analyser;
      speechMsRef.current = 0;

      vadIntervalRef.current = setInterval(() => {
        const a = analyserRef.current;
        if (!a) return;
        const buf = new Float32Array(a.fftSize);
        a.getFloatTimeDomainData(buf);
        let sum = 0;
        for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
        const rms = Math.sqrt(sum / buf.length);
        if (rms > SILENCE_RMS) speechMsRef.current += 100;
        setVoiceLevel(Math.min(1, rms / 0.06));
      }, 100);
    } catch {
      // VAD not critical — recording continues without it
    }
  }, []);

  const stopVAD = useCallback(() => {
    if (vadIntervalRef.current) { clearInterval(vadIntervalRef.current); vadIntervalRef.current = null; }
    analyserRef.current = null;
    audioCtxRef.current?.close().catch(() => {});
    audioCtxRef.current = null;
    setVoiceLevel(0);
    speechMsRef.current = 0;
  }, []);

  // Release the display + mic source streams and the mixing context used by
  // meeting-capture mode (the recorder only sees the mixed output stream).
  const stopMeetingCapture = useCallback(() => {
    extraStreamsRef.current.forEach((s) => s.getTracks().forEach((t) => t.stop()));
    extraStreamsRef.current = [];
    mixCtxRef.current?.close().catch(() => {});
    mixCtxRef.current = null;
  }, []);

  // Capture the meeting itself: the browser's screen/tab picker provides the
  // system audio (the other participants), mixed with your microphone (your
  // side) into a single stream the existing recorder pipeline can consume.
  // Works in desktop Chrome/Edge; the installable desktop app will cover the
  // rest. Returns the mixed stream; sources are stashed for cleanup.
  const getMeetingStream = useCallback(async (): Promise<MediaStream> => {
    const support = capture ?? detectCaptureSupport();
    if (support.level === 'none' || typeof navigator === 'undefined' || !navigator.mediaDevices?.getDisplayMedia) {
      throw new Error(support.blockedReason
        ?? 'This browser cannot capture call audio. Use Chrome or Edge on a computer.');
    }
    // Video is requested only because getDisplayMedia requires it; we immediately
    // drop the video track and keep just the audio.
    const display = await navigator.mediaDevices.getDisplayMedia({
      video: true,
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
    });

    // Reject a doomed pick straight away rather than recording an hour of
    // silence. On macOS only a browser tab carries audio, so a whole-screen or
    // window share is known-bad before a single sample arrives.
    const surface = (display.getVideoTracks()[0]?.getSettings() as
      MediaTrackSettings & { displaySurface?: string } | undefined)?.displaySurface;
    const surfaceError = validateDisplaySurface(surface, support);
    if (surfaceError) {
      display.getTracks().forEach((t) => t.stop());
      throw new Error(surfaceError);
    }

    // Read the service off the surface BEFORE dropping the video track — the
    // title lives on that track and disappears with it.
    providerRef.current = await detectMeetingProvider(display);

    display.getVideoTracks().forEach((t) => t.stop());
    const sysAudio = display.getAudioTracks();
    if (sysAudio.length === 0) {
      display.getTracks().forEach((t) => t.stop());
      throw new Error(`No call audio was shared. ${support.instruction}`);
    }

    let mic: MediaStream;
    try {
      const base = await getAudioConstraint();
      mic = await navigator.mediaDevices.getUserMedia({
        audio: {
          ...(typeof base === 'object' ? base : {}),
          // The browser's echo canceller uses what is playing (the call) as its
          // reference and subtracts it from the mic. First line of defence
          // against remote voices coming out of the speakers, back into the
          // mic, and being labelled as you. The server-side leakage gate in
          // lib/voice-id.ts is the second.
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });
    } catch (e) {
      display.getTracks().forEach((t) => t.stop()); // don't leak the display capture
      throw e;
    }

    extraStreamsRef.current = [display, mic];

    // Two channels, not a blend: your mic on the left, the call on the right.
    //
    // Blending them into one mono track threw away the one piece of information
    // that makes meeting diarisation tractable — which audio is yours. Kept
    // apart, your channel is provably a single speaker, and the remote channel
    // is diarised on its own without your voice or your room in it. Each merger
    // input is mono by spec, so a stereo tab source is downmixed per side,
    // which is what we want.
    const ctx = new AudioContext();
    mixCtxRef.current = ctx;
    const dest = ctx.createMediaStreamDestination();
    dest.channelCount = 2;
    dest.channelCountMode = 'explicit';
    dest.channelInterpretation = 'discrete';
    const merger = ctx.createChannelMerger(2);
    ctx.createMediaStreamSource(mic).connect(merger, 0, 0);
    ctx.createMediaStreamSource(new MediaStream(sysAudio)).connect(merger, 0, 1);
    merger.connect(dest);
    return dest.stream;
  }, [capture]);

  const startLiveCaptions = useCallback(async (recordingId: string) => {
    try {
      const res  = await fetch(`/api/recordings/${recordingId}/stream-token`);
      if (!res.ok) return; // Deepgram not configured — silent no-op
      const { token } = await res.json() as { token?: string };
      if (!token) return;

      const url = 'wss://api.deepgram.com/v1/listen'
        + '?model=nova-2&language=en&encoding=opus&container=webm'
        + '&sample_rate=48000&channels=1&interim_results=true&punctuate=true';

      const ws = new WebSocket(url, ['token', token]);
      ws.binaryType = 'arraybuffer';

      ws.onmessage = (e) => {
        try {
          const msg = JSON.parse(e.data as string) as {
            type: string;
            channel?: { alternatives?: Array<{ transcript?: string }> };
            is_final?: boolean;
          };
          if (msg.type !== 'Results') return;
          const text = msg.channel?.alternatives?.[0]?.transcript ?? '';
          if (!text.trim()) return;
          setCaptions(prev => {
            if (!msg.is_final) {
              // Replace last line if it's interim
              return prev.length > 0 ? [...prev.slice(0, -1), text] : [text];
            }
            return [...prev.slice(-9), text]; // keep last 10 final lines
          });
        } catch { /* ignore malformed messages */ }
      };

      ws.onerror = () => ws.close();
      dgWsRef.current = ws;
      setCaptionsOpen(true);
    } catch { /* no captions — recording still works */ }
  }, []);

  const stopLiveCaptions = useCallback(() => {
    if (dgWsRef.current) {
      if (dgWsRef.current.readyState === WebSocket.OPEN) dgWsRef.current.close();
      dgWsRef.current = null;
    }
  }, []);

  // Layering, ordering and the honest limits all live in lib/keep-awake.ts.
  const ensureKeepAwake = useCallback((): KeepAwake => {
    if (!keepAwakeRef.current) keepAwakeRef.current = new KeepAwake(setWakeLockHeld);
    return keepAwakeRef.current;
  }, []);

  const releaseWakeLock = useCallback(() => {
    keepAwakeRef.current?.release();
    keepAwakeRef.current = null;
  }, []);

  // Upgrade to the native OS lock. The gesture-sensitive layers (the nosleep
  // video, the silent audio session) are already running by this point —
  // primeFromGesture() fires synchronously from the tap in handleClick, because
  // iOS only honours them inside a live user-gesture token and every await
  // before them spends it.
  const requestWakeLock = useCallback(async () => {
    if (typeof window === 'undefined') return;
    await ensureKeepAwake().engage();
  }, [ensureKeepAwake]);

  // Detect what this device can capture, and warm the keep-awake fallback so a
  // tap can start it without awaiting an import.
  useEffect(() => {
    setCapture(detectCaptureSupport());
    setIsMobile(detectPlatform().isMobile);
    chunkMsRef.current = detectPlatform().isMobile ? CHUNK_MS_MOBILE : CHUNK_MS_DESKTOP;
    void preloadKeepAwake();
  }, []);

  // Probe the wake lock now rather than discovering it failed mid-meeting.
  // The API needs only a visible document, not a user gesture, so taking it and
  // immediately releasing it is a free and honest capability test. iOS refuses
  // outright in Low Power Mode, which is the case actually worth catching.
  useEffect(() => {
    if (typeof navigator === 'undefined') return;
    const nav = navigator as Navigator & {
      wakeLock?: { request(type: 'screen'): Promise<{ release(): Promise<void> }> };
    };
    if (!nav.wakeLock) { setWakeLockPossible(false); return; }
    let cancelled = false;
    nav.wakeLock.request('screen')
      .then((sentinel) => {
        void sentinel.release().catch(() => {});
        if (!cancelled) setWakeLockPossible(true);
      })
      .catch(() => { if (!cancelled) setWakeLockPossible(false); });
    return () => { cancelled = true; };
  }, []);

  // Default to Online Meeting when a conferencing app's audio device is present
  // and this platform can actually capture it. Only a default: a page cannot
  // see other tabs or running apps, so anything stronger would be a guess
  // dressed up as a fact.
  useEffect(() => {
    if (!capture || capture.level === 'none') return;
    let cancelled = false;
    void detectMeetingContext().then((ctx) => {
      if (!cancelled && ctx === 'likely') setSource('teams');
    });
    return () => { cancelled = true; };
  }, [capture]);

  // The lock can lapse while the page is still visible, so polling backs up the
  // visibilitychange handler below.
  useEffect(() => {
    if (state !== 'recording' || isPaused) return;
    const id = setInterval(() => { void keepAwakeRef.current?.reacquire(); }, 15_000);
    return () => clearInterval(id);
  }, [state, isPaused]);

  useEffect(() => {
    // The page is about to be backgrounded or frozen (screen lock, app switch).
    // Everything buffered since the last rotation only exists in this tab, so
    // push it to the server NOW, while the page is still alive. Waiting for
    // `pagehide` is too late on iOS, and a keepalive fetch cannot carry a chunk
    // this size anyway, so an ordinary upload issued a moment earlier is the
    // one thing that reliably saves the audio.
    const flushNow = () => {
      if (!isActiveRef.current || isPausingRef.current) return;
      // Nudge MediaRecorder to hand over anything held internally (it emits
      // every 500 ms, so this is a sub-second gain) before the buffer is taken.
      try { recorderRef.current?.requestData(); } catch { /* wedged; rotate anyway */ }
      if (chunkTimerRef.current) { clearTimeout(chunkTimerRef.current); chunkTimerRef.current = null; }
      void flushRef.current?.();
    };

    const onVisibility = () => {
      if (state !== 'recording') return;
      if (document.visibilityState === 'hidden') { flushNow(); return; }
      void keepAwakeRef.current?.reacquire();
      // The page may have been frozen while hidden (screen lock, app switch),
      // in which case MediaRecorder stopped producing data and the audio for
      // that window is simply gone. We cannot prevent it, but we can notice it
      // and heal instead of silently "recording" nothing.
      // Called through a ref: recovery needs startRecorder/rotateChunk, which
      // are declared further down, and a ref keeps this listener stable.
      if (Date.now() - lastDataAtRef.current > STALL_MS) void recoverRef.current?.();
    };

    const onPageHide = () => { if (state === 'recording') flushNow(); };

    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('pagehide', onPageHide);
    // Chromium freezes backgrounded tabs; this fires just before it happens.
    document.addEventListener('freeze', onPageHide);
    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('pagehide', onPageHide);
      document.removeEventListener('freeze', onPageHide);
    };
  }, [state]);

  // Release the lock only when the page actually goes away.
  //
  // This used to sit in the cleanup of the visibilitychange effect above, whose
  // dependencies include `state`. So the idle → recording transition ran that
  // cleanup and dropped the wake lock milliseconds after start() had acquired
  // it, leaving the screen free to sleep on its normal timer and take the
  // recorder with it. Nothing re-took the lock unless the user happened to
  // switch away and back. Its own effect with a stable callback keeps the lock
  // alive for the whole session.
  useEffect(() => releaseWakeLock, [releaseWakeLock]);

  useEffect(() => {
    return () => {
      if (chunkTimerRef.current) clearTimeout(chunkTimerRef.current);
      streamRef.current?.getTracks().forEach((t) => t.stop());
      extraStreamsRef.current.forEach((s) => s.getTracks().forEach((t) => t.stop()));
      mixCtxRef.current?.close().catch(() => {});
      isActiveRef.current = false;
      if (vadIntervalRef.current) clearInterval(vadIntervalRef.current);
      audioCtxRef.current?.close().catch(() => {});
    };
  }, []);

  const uploadChunk = useCallback(async (blob: Blob, offset: number) => {
    const id = recordingIdRef.current;
    if (!id) throw new Error('No recording ID');

    const ext = mimeRef.current.includes('mp4') ? 'mp4' : 'webm';

    let lastErr: Error = new Error('Upload failed');
    for (let attempt = 0; attempt < 4; attempt++) {
      if (attempt > 0) await new Promise((r) => setTimeout(r, 1500 * attempt));
      try {
        const fd = new FormData();
        fd.append('audio', blob, `chunk.${ext}`);
        fd.append('offset', String(offset));

        const res = await fetch(`/api/recordings/${id}/append-chunk`, { method: 'POST', body: fd });
        if (!res.ok) {
          const data = await res.json().catch(() => ({})) as { error?: string };
          throw new Error(data.error ?? `Server error ${res.status}`);
        }
        return;
      } catch (err) {
        lastErr = err instanceof Error ? err : new Error('Upload failed');
      }
    }
    throw lastErr;
  }, []);

  // Retry any chunks that failed earlier. Each success corrects the failed count.
  const flushFailedChunks = useCallback(async () => {
    if (!failedChunksRef.current.length) return;
    const pending = failedChunksRef.current;
    failedChunksRef.current = [];
    const stillFailed: { blob: Blob; offset: number }[] = [];
    for (const item of pending) {
      try {
        await uploadChunk(item.blob, item.offset);
        setChunksSaved((n) => n + 1);
        setChunksFailed((n) => Math.max(0, n - 1));
      } catch {
        stillFailed.push(item);
      }
    }
    failedChunksRef.current = stillFailed;
  }, [uploadChunk]);

  // Re-send queued chunks the moment the network comes back.
  useEffect(() => {
    const onOnline = () => { void flushFailedChunks(); };
    window.addEventListener('online', onOnline);
    return () => window.removeEventListener('online', onOnline);
  }, [flushFailedChunks]);

  const rotateChunk = useCallback(async () => {
    if (!isActiveRef.current) return;

    const blobs = [...chunkBlobsRef.current];
    const offset = timeOffsetRef.current;
    const duration = (Date.now() - chunkStartRef.current) / 1000;

    // Capture and reset speech tracking for this window
    const speechMs = speechMsRef.current;
    speechMsRef.current = 0;
    const speechRatio = duration > 0 ? speechMs / (duration * 1000) : 1;

    chunkBlobsRef.current = [];
    timeOffsetRef.current += duration;
    chunkStartRef.current = Date.now();

    chunkTimerRef.current = setTimeout(rotateChunk, chunkMsRef.current);

    let blobsForUpload = blobs;
    if (!webmHeaderRef.current) {
      // First chunk of this recorder segment — it already carries the WebM
      // header. Capture it so later chunks of the SAME segment decode standalone.
      // (Keying on the header ref, not offset===0, keeps post-resume segments valid.)
      try {
        const raw = new Uint8Array(await new Blob(blobs, { type: mimeRef.current }).arrayBuffer());
        for (let i = 0; i < raw.length - 3; i++) {
          if (raw[i] === 0x1f && raw[i + 1] === 0x43 && raw[i + 2] === 0xb6 && raw[i + 3] === 0x75) {
            webmHeaderRef.current = raw.buffer.slice(0, i);
            break;
          }
        }
        if (!webmHeaderRef.current && blobs.length > 0) {
          webmHeaderRef.current = await blobs[0].arrayBuffer();
        }
      } catch (err) {
        console.warn('[rotateChunk] WebM header extraction failed:', err);
      }
    } else {
      blobsForUpload = [new Blob([webmHeaderRef.current], { type: mimeRef.current }), ...blobs];
    }

    const blob = new Blob(blobsForUpload, { type: mimeRef.current });
    if (blob.size >= 1000) {
      // Skip silent chunks — saves Whisper/Deepgram API cost
      if (speechRatio < SKIP_SPEECH_RATIO) {
        return;
      }
      try {
        await uploadChunk(blob, offset);
        setChunksSaved((n) => n + 1);
        void flushFailedChunks(); // a success means we're online — clear any backlog
      } catch (err) {
        console.warn('[rotate] chunk upload failed, queued for retry:', err instanceof Error ? err.message : err);
        failedChunksRef.current.push({ blob, offset });
        setChunksFailed((n) => n + 1);
      }
    }
  }, [uploadChunk, flushFailedChunks]);

  const startRecorder = useCallback((stream: MediaStream, mime: string) => {
    const mr = new MediaRecorder(stream, { mimeType: mime });
    recorderRef.current = mr;
    chunkBlobsRef.current = [];
    chunkStartRef.current = Date.now();
    webmHeaderRef.current = null;

    mr.ondataavailable = (e) => {
      if (e.data.size > 0) {
        lastDataAtRef.current = Date.now(); // watchdog heartbeat
        chunkBlobsRef.current.push(e.data);
        // Stream to Deepgram for live captions
        if (dgWsRef.current?.readyState === WebSocket.OPEN) {
          e.data.arrayBuffer().then(buf => dgWsRef.current?.send(buf)).catch(() => {});
        }
      }
    };

    mr.onstop = async () => {
      const pausing = isPausingRef.current;
      isPausingRef.current = false;
      const blobs = chunkBlobsRef.current;
      chunkBlobsRef.current = [];
      // Pause froze its own upload offset + header; a final stop uses the live refs.
      const offset = pausing ? pauseOffsetRef.current : timeOffsetRef.current;
      const header = pausing ? pauseHeaderRef.current : webmHeaderRef.current;

      try {
        let blobsForUpload = blobs;
        if (offset > 0 && header) {
          blobsForUpload = [new Blob([header], { type: mime }), ...blobs];
        }
        const blob = new Blob(blobsForUpload, { type: mime });
        if (blob.size >= 1000) {
          await uploadChunk(blob, offset);
          setChunksSaved((n) => n + 1);
        }

        // Paused: this segment is safely uploaded — stay paused, keep recording alive.
        if (pausing) return;

        // Last chance to re-send anything that failed mid-session before finalize.
        await flushFailedChunks();

        setState('queued');
        const id = recordingIdRef.current;
        if (!id) return;
        fetch(`/api/recordings/${id}/finalize`, { method: 'POST', keepalive: true }).catch(() => {});
        router.push(`/recordings/${id}`);
      } catch (err) {
        if (pausing) {
          // Keep the flushed tail (with its header) for retry rather than dropping it.
          const retryBlobs = offset > 0 && header ? [new Blob([header], { type: mime }), ...blobs] : blobs;
          failedChunksRef.current.push({ blob: new Blob(retryBlobs, { type: mime }), offset });
          setChunksFailed((n) => n + 1);
          return;
        }
        isActiveRef.current = false;
        setErrorMsg(err instanceof Error ? err.message : 'Upload failed. Please try again.');
        setState('error');
      }
    };

    mr.start(500);
    lastDataAtRef.current = Date.now();
  }, [uploadChunk, router, flushFailedChunks]);

  // Heal a wedged recorder after the OS froze the page (screen lock, app
  // switch). The audio for the frozen window is already gone — no web API can
  // recover it — so the goal is to flush what we DID capture, restart cleanly,
  // and keep the timeline offsets truthful so later chunks still line up.
  //
  // Meeting-capture mode can be healed too, but only while its source tracks
  // are still live: the recorder is then restarted on the existing mixed
  // stream, needing no picker. Once the user has stopped sharing there is no
  // way back without silently reopening a screen-share prompt, which is worse
  // than the stall, so that case still bails out.
  const recoverRecorder = useCallback(async () => {
    if (!isActiveRef.current || isPausingRef.current || isRecoveringRef.current) return;
    const meetingSourcesLive =
      extraStreamsRef.current.length > 0 &&
      extraStreamsRef.current.every((s) =>
        s.getAudioTracks().some((t) => t.readyState === 'live'));
    if (source === 'teams' && (!meetingSourcesLive || !streamRef.current)) return;
    isRecoveringRef.current = true;
    try {
      // Flush the existing segment through the pause path so onstop uploads it
      // and does NOT finalize/navigate.
      const mr = recorderRef.current;
      if (mr && mr.state !== 'inactive') {
        isPausingRef.current = true;
        pauseOffsetRef.current = timeOffsetRef.current;
        pauseHeaderRef.current = webmHeaderRef.current;
        // Wait for the stop event before restarting. onstop captures
        // chunkBlobsRef synchronously, and startRecorder reassigns that same
        // ref — restarting without waiting drops the last buffered audio.
        // The timeout means a genuinely wedged recorder cannot block recovery.
        const flushed = new Promise<void>((resolve) => {
          const done = () => resolve();
          mr.addEventListener('stop', done, { once: true });
          setTimeout(done, 2000);
        });
        try {
          mr.stop();
          await flushed;
        } catch {
          isPausingRef.current = false;
        }
      }
      // Advance past the dead air so subsequent chunk offsets stay honest.
      timeOffsetRef.current += (Date.now() - chunkStartRef.current) / 1000;

      if (chunkTimerRef.current) { clearTimeout(chunkTimerRef.current); chunkTimerRef.current = null; }

      let stream: MediaStream;
      if (source === 'teams') {
        // Sources are still live (checked above), so the mixed stream and its
        // VAD stay exactly as they are and only the recorder is restarted.
        stream = streamRef.current!;
      } else {
        streamRef.current?.getTracks().forEach((t) => t.stop());
        stopVAD();
        stream = await navigator.mediaDevices.getUserMedia({ audio: await getAudioConstraint() });
        streamRef.current = stream;
        startVAD(stream);
      }
      startRecorder(stream, mimeRef.current);
      chunkTimerRef.current = setTimeout(rotateChunk, chunkMsRef.current);
      setStalled(false);
    } catch (err) {
      console.warn('[recover] could not restart recorder:', err instanceof Error ? err.message : err);
      // Leave `stalled` set so the banner keeps warning the user.
    } finally {
      isRecoveringRef.current = false;
    }
  }, [source, startVAD, stopVAD, startRecorder, rotateChunk]);

  useEffect(() => { recoverRef.current = recoverRecorder; }, [recoverRecorder]);
  useEffect(() => { flushRef.current = rotateChunk; }, [rotateChunk]);

  const start = useCallback(async () => {
    if (isStartingRef.current) return;
    isStartingRef.current = true;

    setErrorMsg('');
    setSeconds(0);
    setChunksSaved(0);
    setChunksFailed(0);

    try {
      // Take the OS lock first. It used to be requested after the create call
      // and the mic prompt, which on a slow connection left a window where the
      // screen could sleep before anything was holding it awake.
      void requestWakeLock();

      // Audio is acquired BEFORE the row is created, for two reasons: the
      // display picker wants the user gesture that is still live at this
      // point, and it is what tells us which conferencing service this is, so
      // the recording can be created already knowing. A cancelled picker or a
      // denied microphone now also leaves no orphan recording behind.
      // 'teams' = capture the meeting's system audio (+ mic); 'web' = mic only.
      const stream = source === 'teams'
        ? await getMeetingStream()
        : await navigator.mediaDevices.getUserMedia({ audio: await getAudioConstraint() });
      streamRef.current = stream;

      const createRes = await fetch('/api/recordings/create', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          source,
          meetingType,
          // Which conferencing service, read off the shared surface itself.
          meetingProvider: source === 'teams' ? providerRef.current : undefined,
          // Debug metadata only. The server detects the real layout from the
          // audio itself, so a stale or lying client cannot misroute anything.
          channelLayout: source === 'teams' ? 'mic-sys' : 'mono',
        }),
      });
      const createData = await createRes.json() as { id?: string; error?: string };
      if (!createRes.ok || !createData.id) throw new Error(createData.error ?? 'Could not create recording');
      recordingIdRef.current = createData.id;

      const mime = getBestMime();
      mimeRef.current = mime;
      timeOffsetRef.current = 0;
      isActiveRef.current = true;

      startVAD(stream);
      startRecorder(stream, mime);
      chunkTimerRef.current = setTimeout(rotateChunk, chunkMsRef.current);
      bankedSecsRef.current = 0;
      runStartedAtRef.current = Date.now();
      setState('recording');
      // Fire-and-forget — if Deepgram isn't configured it returns silently
      void startLiveCaptions(createData.id);
    } catch (err) {
      if (recordingIdRef.current) {
        fetch(`/api/recordings/${recordingIdRef.current}`, { method: 'DELETE' }).catch(() => {});
        recordingIdRef.current = null;
      }
      stopMeetingCapture(); // release any display/mic streams acquired before failure
      releaseWakeLock();
      setErrorMsg(err instanceof Error ? err.message : 'Microphone access denied. Allow mic access and try again.');
      setState('error');
    } finally {
      isStartingRef.current = false;
    }
  }, [startRecorder, startVAD, startLiveCaptions, rotateChunk, requestWakeLock, releaseWakeLock, source, meetingType, getMeetingStream, stopMeetingCapture]);

  const pause = useCallback(() => {
    if (state !== 'recording' || isPaused) return;
    const mr = recorderRef.current;
    if (!mr || mr.state === 'inactive') return;

    setIsPaused(true);              // freezes the timer via the effect
    isPausingRef.current = true;    // onstop: flush this segment, don't finalize
    bankedSecsRef.current += (Date.now() - runStartedAtRef.current) / 1000;

    // Freeze the upload offset + header for the flushed tail, then advance the
    // audio timeline synchronously so a fast resume starts the next segment cleanly.
    // (Freezing guards against resume's startRecorder resetting these mid-flush.)
    pauseOffsetRef.current = timeOffsetRef.current;
    pauseHeaderRef.current = webmHeaderRef.current;
    timeOffsetRef.current += (Date.now() - chunkStartRef.current) / 1000;

    if (chunkTimerRef.current) { clearTimeout(chunkTimerRef.current); chunkTimerRef.current = null; }

    mr.stop(); // flushes buffered audio → onstop uploads it as a self-contained chunk

    // Fully release the microphone so iOS shows the mic-off indicator and plays
    // its tone. Permission persists for the session, so resume won't re-prompt.
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    stopVAD();
    stopLiveCaptions();
  }, [state, isPaused, stopVAD, stopLiveCaptions]);

  const resume = useCallback(async () => {
    if (state !== 'recording' || !isPaused) return;
    try {
      // Re-acquire the mic. The browser already granted permission this session,
      // so no dialog appears — iOS just reactivates the mic.
      const stream = await navigator.mediaDevices.getUserMedia({ audio: await getAudioConstraint() });
      streamRef.current = stream;

      startVAD(stream);
      startRecorder(stream, mimeRef.current);          // fresh segment; timeOffsetRef carries over
      chunkTimerRef.current = setTimeout(rotateChunk, chunkMsRef.current);
      if (recordingIdRef.current) void startLiveCaptions(recordingIdRef.current);

      runStartedAtRef.current = Date.now();
      setIsPaused(false);            // restarts the timer via the effect
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Could not access the microphone to resume.');
      // Stay paused so the user can tap Resume again.
    }
  }, [state, isPaused, startVAD, startRecorder, rotateChunk, startLiveCaptions]);

  const stop = useCallback(() => {
    if (state !== 'recording') return;

    const wasPaused = isPaused;
    isActiveRef.current = false;
    stopVAD();
    stopLiveCaptions();
    setIsPaused(false);

    if (chunkTimerRef.current) {
      clearTimeout(chunkTimerRef.current);
      chunkTimerRef.current = null;
    }

    if (wasPaused) {
      // Paused: the segment was already flushed and the mic already released.
      // Nothing left to record — retry any queued chunks, then finalize and go.
      setState('queued');
      streamRef.current?.getTracks().forEach((t) => t.stop());
      void releaseWakeLock();
      const id = recordingIdRef.current;
      if (id) {
        flushFailedChunks().finally(() => {
          fetch(`/api/recordings/${id}/finalize`, { method: 'POST', keepalive: true }).catch(() => {});
          router.push(`/recordings/${id}`);
        });
      }
      return;
    }

    setState('uploading');
    if (recorderRef.current && recorderRef.current.state !== 'inactive') {
      recorderRef.current.stop(); // onstop uploads the tail → finalize → navigate
    }
    streamRef.current?.getTracks().forEach((t) => t.stop());
    stopMeetingCapture();
    void releaseWakeLock();
  }, [state, isPaused, stopVAD, stopLiveCaptions, releaseWakeLock, router, flushFailedChunks, stopMeetingCapture]);

  const handleClick = () => {
    if (state === 'recording') { stop(); return; }
    if (state !== 'idle') return;
    // Synchronously, before anything async: iOS only lets the nosleep video and
    // the silent audio session start inside a live user-gesture token, and the
    // first await in start() spends it. This one line is the difference between
    // the fallback working on a phone and failing silently on it.
    ensureKeepAwake().primeFromGesture();
    void start();
  };

  const btnClass =
    state === 'recording' ? 'btn-record-active' :
    state === 'uploading' || state === 'queued' ? 'btn-record-processing' :
    'btn-record-idle';

  const isProcessing = state === 'uploading' || state === 'queued';

  return (
    <div className="min-h-screen flex flex-col bg-surface">
      {/* Header — sticky + stacked above the (flex-centered) body so its taps
          are never swallowed by overflowing content or the iOS mic pill. */}
      <header className="sticky top-0 z-30 border-b border-surface-border bg-surface/95 backdrop-blur-md">
        <div className="max-w-5xl mx-auto px-2 py-2 flex items-center gap-2">
          <Link
            href="/"
            aria-label="Back"
            className="flex items-center gap-1.5 text-sm font-medium text-ftc-mid hover:text-ftc-gray active:bg-surface-raised transition-colors px-3 py-2.5 rounded-xl touch-manipulation shrink-0"
          >
            <svg className="w-5 h-5" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" d="M15 19l-7-7 7-7" />
            </svg>
            Back
          </Link>
          <div className="flex items-center gap-2 min-w-0">
            <img src="/logo.png" alt="FTC Transcribe" className="h-6 object-contain shrink-0" />
            <span className="font-semibold text-sm text-ftc-gray border-l border-surface-border pl-2 truncate">New Recording</span>
          </div>
        </div>
      </header>

      {/* Body */}
      <main className="flex-1 flex flex-col items-center justify-center gap-8 px-6 pb-safe">

        {/* Timer */}
        <div className="text-center">
          <p className={`timer-display text-7xl font-mono font-bold tabular-nums transition-colors duration-300 ${
            state === 'recording' ? 'text-ftc-gray' : 'text-surface-border'
          }`}>
            {formatTime(seconds)}
          </p>
          {state === 'recording' && (
            <div className="flex items-center justify-center gap-1.5 mt-2">
              <div className="w-2 h-2 rounded-full bg-red-500 animate-pulse" />
              <span className="text-xs font-semibold text-red-400 tracking-widest">REC</span>
            </div>
          )}
        </div>

        {/* Reactive voice waveform */}
        <div className="flex items-end justify-center gap-1 h-10">
          {[...Array(13)].map((_, i) => {
            if (state !== 'recording') {
              return <div key={i} className="w-1.5 h-1 rounded-full bg-surface-border" />;
            }
            const centerDist = Math.abs(i - 6) / 6;
            const shapeFactor = 1 - centerDist * 0.4;
            const heightPct = Math.max(10, Math.round(voiceLevel * 100 * shapeFactor));
            return (
              <div
                key={i}
                className="w-1.5 rounded-full bg-brand transition-all duration-75"
                style={{ height: `${heightPct}%` }}
              />
            );
          })}
        </div>

        {/* Record button & Pause/Resume controls */}
        <div className="flex flex-col items-center gap-6">
          <div className="relative flex items-center justify-center">
            {state === 'recording' && (
              <>
                <div className="absolute rounded-full w-36 h-36 pulse-ring bg-red-500/15 pointer-events-none" />
                <div className="absolute rounded-full w-36 h-36 pulse-ring-delay bg-red-500/15 pointer-events-none" />
              </>
            )}
            <button
              type="button"
              onClick={handleClick}
              disabled={isProcessing}
              aria-label={state === 'recording' ? 'Stop recording' : 'Start recording'}
              className={`relative w-32 h-32 rounded-full flex items-center justify-center transition-all duration-200 touch-manipulation select-none ${btnClass}`}
            >
              {state === 'recording' ? (
                <div className="w-10 h-10 rounded-2xl bg-white" />
              ) : isProcessing ? (
                <div className="w-9 h-9 rounded-full border-[3px] border-surface-border border-t-brand animate-spin" />
              ) : (
                <svg className="w-14 h-14 text-white" fill="currentColor" viewBox="0 0 24 24">
                  <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z" />
                  <path d="M19 10v2a7 7 0 0 1-14 0v-2H3v2a9 9 0 0 0 8 8.94V22H9v2h6v-2h-2v-1.06A9 9 0 0 0 21 12v-2h-2z" />
                </svg>
              )}
            </button>
          </div>

          {/* Pause/Resume — sits directly beneath the stop button.
              relative z-10 keeps it above the (decorative) pulse rings so a tap
              during their expansion always lands on the button.
              Hidden in meeting-capture mode: resuming would re-open the browser's
              screen-share picker, so meeting capture is a single start→stop. */}
          {state === 'recording' && source !== 'teams' && (
            <div className="relative z-10 animate-in fade-in-50 slide-in-from-top-1 duration-300">
              {isPaused ? (
                <button
                  type="button"
                  onClick={resume}
                  aria-label="Resume recording"
                  className="flex items-center gap-2 px-5 py-2.5 rounded-xl text-sm font-semibold bg-emerald-500 hover:bg-emerald-600 text-white transition-colors touch-manipulation"
                  title="Resume recording"
                >
                  <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 24 24">
                    <path d="M8 5v14l11-7z" />
                  </svg>
                  Resume
                </button>
              ) : (
                <button
                  type="button"
                  onClick={pause}
                  aria-label="Pause recording"
                  className="flex items-center gap-2 px-5 py-2.5 rounded-xl text-sm font-semibold bg-amber-500 hover:bg-amber-600 text-white transition-colors touch-manipulation"
                  title="Pause recording"
                >
                  <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 24 24">
                    <path d="M6 4h4v16H6V4zm8 0h4v16h-4V4z" />
                  </svg>
                  Pause
                </button>
              )}
            </div>
          )}
        </div>

        {/* Status */}
        <div className="text-center space-y-1.5 max-w-xs">
          <p className="font-medium text-ftc-gray">
            {state === 'idle'      && 'Tap to start recording'}
            {state === 'recording' && (isPaused ? 'Paused — tap Resume to continue' : 'Recording — tap to stop')}
            {state === 'uploading' && 'Saving final segment…'}
            {state === 'queued'    && 'Sending for analysis…'}
            {state === 'error'     && 'Something went wrong'}
          </p>

          {state === 'recording' && chunksSaved > 0 && (
            <p className="text-sm text-ftc-mid">
              {chunksSaved} segment{chunksSaved !== 1 ? 's' : ''} saved safely
            </p>
          )}

          {state === 'recording' && chunksFailed > 0 && (
            <p className="text-sm text-amber-500">
              {chunksFailed} segment{chunksFailed !== 1 ? 's' : ''} failed to save — check your connection
            </p>
          )}

          {/* The recorder has gone quiet. Say so loudly: the old behaviour was a
              cheerfully ticking timer over a dead recorder, so people only found
              out audio was missing once the meeting was over. */}
          {state === 'recording' && !isPaused && stalled && (
            <p className="text-sm font-medium text-red-500">
              Recording paused by your phone. Keep this screen on and open — tap the screen to resume capture.
            </p>
          )}

          {/* Best-effort only: no web page can override the OS. If the lock was
              refused (Low Power Mode is the usual reason) the user needs to know
              their screen will sleep and take the recording with it. */}
          {state === 'recording' && !isPaused && wakeLockHeld === false && (
            <p className="text-sm text-amber-500">
              Your phone may lock the screen and pause recording. Turn off Low Power Mode, or set Auto-Lock to Never.
            </p>
          )}

          {(state === 'uploading' || state === 'queued') && (
            <p className="text-sm text-ftc-mid">
              Audio saved to server — transcription will finish even if you lock your phone.
            </p>
          )}

          {state === 'error' && errorMsg && (
            <p className="text-sm text-red-400">{errorMsg}</p>
          )}
          {state === 'error' && (
            <button type="button" onClick={() => setState('idle')} className="mt-1 text-sm text-brand underline underline-offset-2 touch-manipulation">
              Try again
            </button>
          )}
        </div>

        {state === 'idle' && (
          <div className="flex flex-col items-center gap-5 w-full max-w-sm">
            {/* Meeting type selector */}
            <div className="w-full space-y-2">
              <p className="text-xs font-semibold uppercase tracking-widest text-ftc-mid text-center">Meeting Type</p>
              <div className="flex flex-wrap justify-center gap-2">
                {MEETING_TYPES.map(({ id, label, icon }) => (
                  <button
                    key={id}
                    type="button"
                    onClick={() => setMeetingType(id)}
                    className={`flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-sm font-medium transition-colors touch-manipulation ${
                      meetingType === id
                        ? 'bg-brand text-white'
                        : 'border border-surface-border text-ftc-mid hover:text-ftc-gray hover:bg-surface-raised'
                    }`}
                  >
                    <span>{icon}</span>
                    {label}
                  </button>
                ))}
              </div>
            </div>

            {/* Source toggle. Online Meeting is disabled outright where the
                platform cannot deliver call audio, with the reason shown below,
                rather than letting someone record an hour of silence. */}
            <div className="flex rounded-xl border border-surface-border overflow-hidden">
              <button
                type="button"
                onClick={() => setSource('web')}
                className={`flex items-center gap-2 px-4 py-2.5 text-sm font-medium transition-colors touch-manipulation ${
                  source === 'web'
                    ? 'bg-brand text-white'
                    : 'text-ftc-mid hover:text-ftc-gray hover:bg-surface-raised'
                }`}
              >
                <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M17.982 18.725A7.488 7.488 0 0012 15.75a7.488 7.488 0 00-5.982 2.975m11.963 0a9 9 0 10-11.963 0m11.963 0A8.966 8.966 0 0112 21a8.966 8.966 0 01-5.982-2.275M15 9.75a3 3 0 11-6 0 3 3 0 016 0z" />
                </svg>
                In Person
              </button>
              <button
                type="button"
                onClick={() => setSource('teams')}
                disabled={capture?.level === 'none'}
                title={capture?.blockedReason}
                className={`flex items-center gap-2 px-4 py-2.5 text-sm font-medium transition-colors touch-manipulation border-l border-surface-border ${
                  capture?.level === 'none'
                    ? 'text-surface-muted cursor-not-allowed opacity-60'
                    : source === 'teams'
                    ? 'bg-brand text-white'
                    : 'text-ftc-mid hover:text-ftc-gray hover:bg-surface-raised'
                }`}
              >
                <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 24 24">
                  <path d="M12.5 2C11.1 2 10 3.1 10 4.5S11.1 7 12.5 7 15 5.9 15 4.5 13.9 2 12.5 2zm5 3c-.8 0-1.5.7-1.5 1.5S16.7 8 17.5 8 19 7.3 19 6.5 18.3 5 17.5 5zM3 9v10h2v-4h1.5c.3 1.2 1.3 2 2.5 2s2.2-.8 2.5-2H13v4h2V9H3zm8 4H5v-2h6v2z"/>
                </svg>
                Online Meeting
              </button>
            </div>

            {/* Guidance comes from the detected platform, never a fixed string.
                The old copy told everyone to share their whole screen, which on
                a Mac captures no audio at all. */}
            <p className="text-xs text-center max-w-xs text-surface-muted">
              {source === 'teams'
                ? `Records the call (Teams, Zoom, Meet, anyone) and your mic as separate tracks, so everyone is labelled correctly. ${capture?.instruction ?? ''}`
                : 'Records your microphone. Keep the screen on while recording. Once you stop, audio is saved on our servers and transcription completes automatically even if you lock your phone.'}
            </p>

            {capture?.blockedReason && (
              <p className="text-xs text-center max-w-xs text-amber-500">
                {capture.blockedReason}
              </p>
            )}

            {/* Warn BEFORE the meeting, not after it. This used to appear only
                once recording was under way, by which point the useful advice
                had arrived too late to act on. */}
            {isMobile && wakeLockPossible === false && (
              <p className="text-xs text-center max-w-xs text-amber-500">
                Your phone refused to stay awake, usually because Low Power Mode is on. Turn it off, or set Auto-Lock to Never, before you start. A locked screen stops the recording.
              </p>
            )}
          </div>
        )}

        {/* Live captions panel — only shown when Deepgram is streaming */}
        {state === 'recording' && captions.length > 0 && (
          <div className="w-full max-w-sm">
            <button
              type="button"
              onClick={() => setCaptionsOpen(o => !o)}
              className="flex items-center gap-2 text-xs text-ftc-mid hover:text-ftc-gray transition-colors mb-2 w-full justify-center"
            >
              <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
              Live captions {captionsOpen ? '↓' : '↑'}
            </button>
            {captionsOpen && (
              <div className="rounded-2xl border border-surface-border bg-surface-card p-4 space-y-1.5 max-h-40 overflow-y-auto">
                {captions.map((line, i) => (
                  <p key={i} className={`text-sm leading-relaxed ${i === captions.length - 1 ? 'text-ftc-gray' : 'text-ftc-mid'}`}>
                    {line}
                  </p>
                ))}
              </div>
            )}
          </div>
        )}
      </main>
    </div>
  );
}
