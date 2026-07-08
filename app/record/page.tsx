'use client';

import { useState, useRef, useCallback, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';

type State = 'idle' | 'recording' | 'uploading' | 'queued' | 'error';
type Source = 'web' | 'teams';
export type MeetingType = 'general' | 'standup' | 'sales' | 'interview' | 'review';

const CHUNK_MS = 2 * 60 * 1000;
const SILENCE_RMS = 0.01;
const SKIP_SPEECH_RATIO = 0.04; // skip upload if < 4% of chunk is speech

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

  const router = useRouter();

  const streamRef       = useRef<MediaStream | null>(null);
  const recorderRef     = useRef<MediaRecorder | null>(null);
  const chunkBlobsRef   = useRef<Blob[]>([]);
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
  const noSleepRef      = useRef<{ enable(): Promise<boolean>; disable(): void } | null>(null);
  const webmHeaderRef   = useRef<ArrayBuffer | null>(null);

  // Deepgram live-captions WebSocket
  const dgWsRef         = useRef<WebSocket | null>(null);

  // VAD refs — energy-based, no WASM dependencies, works on every device
  const analyserRef     = useRef<AnalyserNode | null>(null);
  const audioCtxRef     = useRef<AudioContext | null>(null);
  const vadIntervalRef  = useRef<ReturnType<typeof setInterval> | null>(null);
  const speechMsRef     = useRef(0); // ms of detected speech in current 2-min window

  // Timer — runs only while actively recording (frozen while paused)
  useEffect(() => {
    if (state === 'recording' && !isPaused) {
      timerRef.current = setInterval(() => setSeconds((s) => s + 1), 1000);
    }
    return () => { if (timerRef.current) { clearInterval(timerRef.current); timerRef.current = null; } };
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

  const releaseWakeLock = useCallback(() => {
    noSleepRef.current?.disable();
  }, []);

  const requestWakeLock = useCallback(async () => {
    if (typeof window === 'undefined') return;
    try {
      if (!noSleepRef.current) {
        const { default: NoSleep } = await import('nosleep.js');
        noSleepRef.current = new NoSleep();
      }
      await noSleepRef.current.enable();
    } catch {
      // Low Power Mode or unsupported — recording continues regardless
    }
  }, []);

  useEffect(() => {
    const onVisibility = () => {
      if (document.visibilityState === 'visible' && state === 'recording') {
        void requestWakeLock();
      }
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      releaseWakeLock();
    };
  }, [state, requestWakeLock, releaseWakeLock]);

  useEffect(() => {
    return () => {
      if (chunkTimerRef.current) clearTimeout(chunkTimerRef.current);
      streamRef.current?.getTracks().forEach((t) => t.stop());
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

    chunkTimerRef.current = setTimeout(rotateChunk, CHUNK_MS);

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
      } catch (err) {
        console.warn('[rotate] chunk upload failed:', err instanceof Error ? err.message : err);
        setChunksFailed((n) => n + 1);
      }
    }
  }, [uploadChunk]);

  const startRecorder = useCallback((stream: MediaStream, mime: string) => {
    const mr = new MediaRecorder(stream, { mimeType: mime });
    recorderRef.current = mr;
    chunkBlobsRef.current = [];
    chunkStartRef.current = Date.now();
    webmHeaderRef.current = null;

    mr.ondataavailable = (e) => {
      if (e.data.size > 0) {
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

        setState('queued');
        const id = recordingIdRef.current;
        if (!id) return;
        fetch(`/api/recordings/${id}/finalize`, { method: 'POST', keepalive: true }).catch(() => {});
        router.push(`/recordings/${id}`);
      } catch (err) {
        if (pausing) { setChunksFailed((n) => n + 1); return; }
        isActiveRef.current = false;
        setErrorMsg(err instanceof Error ? err.message : 'Upload failed. Please try again.');
        setState('error');
      }
    };

    mr.start(500);
  }, [uploadChunk, router]);

  const start = useCallback(async () => {
    if (isStartingRef.current) return;
    isStartingRef.current = true;

    setErrorMsg('');
    setSeconds(0);
    setChunksSaved(0);
    setChunksFailed(0);

    try {
      const createRes = await fetch('/api/recordings/create', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ source, meetingType }),
      });
      const createData = await createRes.json() as { id?: string; error?: string };
      if (!createRes.ok || !createData.id) throw new Error(createData.error ?? 'Could not create recording');
      recordingIdRef.current = createData.id;

      const preferredMicId = localStorage.getItem('preferredMicId');
      const audioConstraint: MediaTrackConstraints | boolean = preferredMicId
        ? { deviceId: { ideal: preferredMicId } }
        : true;
      const stream = await navigator.mediaDevices.getUserMedia({ audio: audioConstraint });
      streamRef.current = stream;
      await requestWakeLock();

      const mime = getBestMime();
      mimeRef.current = mime;
      timeOffsetRef.current = 0;
      isActiveRef.current = true;

      startVAD(stream);
      startRecorder(stream, mime);
      chunkTimerRef.current = setTimeout(rotateChunk, CHUNK_MS);
      setState('recording');
      // Fire-and-forget — if Deepgram isn't configured it returns silently
      void startLiveCaptions(createData.id);
    } catch (err) {
      if (recordingIdRef.current) {
        fetch(`/api/recordings/${recordingIdRef.current}`, { method: 'DELETE' }).catch(() => {});
        recordingIdRef.current = null;
      }
      releaseWakeLock();
      setErrorMsg(err instanceof Error ? err.message : 'Microphone access denied. Allow mic access and try again.');
      setState('error');
    } finally {
      isStartingRef.current = false;
    }
  }, [startRecorder, startVAD, startLiveCaptions, rotateChunk, requestWakeLock, releaseWakeLock, source, meetingType]);

  const pause = useCallback(() => {
    if (state !== 'recording' || isPaused) return;
    const mr = recorderRef.current;
    if (!mr || mr.state === 'inactive') return;

    setIsPaused(true);              // freezes the timer via the effect
    isPausingRef.current = true;    // onstop: flush this segment, don't finalize

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
      const preferredMicId = localStorage.getItem('preferredMicId');
      const audioConstraint: MediaTrackConstraints | boolean = preferredMicId
        ? { deviceId: { ideal: preferredMicId } }
        : true;
      const stream = await navigator.mediaDevices.getUserMedia({ audio: audioConstraint });
      streamRef.current = stream;

      startVAD(stream);
      startRecorder(stream, mimeRef.current);          // fresh segment; timeOffsetRef carries over
      chunkTimerRef.current = setTimeout(rotateChunk, CHUNK_MS);
      if (recordingIdRef.current) void startLiveCaptions(recordingIdRef.current);

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
      // Nothing left to record — just finalize and go.
      setState('queued');
      streamRef.current?.getTracks().forEach((t) => t.stop());
      void releaseWakeLock();
      const id = recordingIdRef.current;
      if (id) {
        fetch(`/api/recordings/${id}/finalize`, { method: 'POST', keepalive: true }).catch(() => {});
        router.push(`/recordings/${id}`);
      }
      return;
    }

    setState('uploading');
    if (recorderRef.current && recorderRef.current.state !== 'inactive') {
      recorderRef.current.stop(); // onstop uploads the tail → finalize → navigate
    }
    streamRef.current?.getTracks().forEach((t) => t.stop());
    void releaseWakeLock();
  }, [state, isPaused, stopVAD, stopLiveCaptions, releaseWakeLock, router]);

  const handleClick = () => {
    if (state === 'recording') stop();
    else if (state === 'idle') start();
  };

  const btnClass =
    state === 'recording' ? 'btn-record-active' :
    state === 'uploading' || state === 'queued' ? 'btn-record-processing' :
    'btn-record-idle';

  const isProcessing = state === 'uploading' || state === 'queued';

  return (
    <div className="min-h-screen flex flex-col bg-surface">
      {/* Header */}
      <header className="border-b border-surface-border bg-surface/80 backdrop-blur-md">
        <div className="max-w-5xl mx-auto px-4 py-3 flex items-center gap-3">
          <Link
            href="/"
            className="flex items-center gap-1.5 text-sm font-medium text-ftc-mid hover:text-ftc-gray transition-colors p-2 -ml-2 rounded-xl touch-manipulation"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" d="M15 19l-7-7 7-7" />
            </svg>
            Back
          </Link>
          <div className="flex items-center gap-2">
            <img src="/logo.png" alt="FTC Transcribe" className="h-6 object-contain" />
            <span className="font-semibold text-sm text-ftc-gray border-l border-surface-border pl-2">New Recording</span>
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
                <div className="absolute rounded-full w-36 h-36 pulse-ring bg-red-500/15" />
                <div className="absolute rounded-full w-36 h-36 pulse-ring-delay bg-red-500/15" />
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

          {/* Pause/Resume — sits directly beneath the stop button */}
          {state === 'recording' && (
            <div className="animate-in fade-in-50 slide-in-from-top-1 duration-300">
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

            {/* Source toggle */}
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
                className={`flex items-center gap-2 px-4 py-2.5 text-sm font-medium transition-colors touch-manipulation border-l border-surface-border ${
                  source === 'teams'
                    ? 'bg-brand text-white'
                    : 'text-ftc-mid hover:text-ftc-gray hover:bg-surface-raised'
                }`}
              >
                <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 24 24">
                  <path d="M12.5 2C11.1 2 10 3.1 10 4.5S11.1 7 12.5 7 15 5.9 15 4.5 13.9 2 12.5 2zm5 3c-.8 0-1.5.7-1.5 1.5S16.7 8 17.5 8 19 7.3 19 6.5 18.3 5 17.5 5zM3 9v10h2v-4h1.5c.3 1.2 1.3 2 2.5 2s2.2-.8 2.5-2H13v4h2V9H3zm8 4H5v-2h6v2z"/>
                </svg>
                Teams Call
              </button>
            </div>
            <p className="text-xs text-center max-w-xs text-surface-muted">
              Keep screen on while recording. Once you stop, audio is saved on our servers — you can lock your phone and transcription will complete automatically.
            </p>
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
