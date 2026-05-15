'use client';

import { useState, useRef, useCallback, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';

type State = 'idle' | 'recording' | 'uploading' | 'queued' | 'error';

// Auto-rotate every 2 minutes — keeps each chunk well within file size & timeout limits
const CHUNK_MS = 2 * 60 * 1000;

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
  const [seconds,     setSeconds]     = useState(0);
  const [errorMsg,    setErrorMsg]    = useState('');
  const [chunksSaved, setChunksSaved] = useState(0);

  const router = useRouter();

  // Persistent refs (survive re-renders without causing them)
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
  const noSleepRef      = useRef<{ enable(): Promise<boolean>; disable(): void } | null>(null);
  // WebM EBML header bytes (before the first Cluster element) extracted from the first chunk.
  // Non-first chunks are cluster-only and need this header prepended to be valid WebM files.
  const webmHeaderRef   = useRef<ArrayBuffer | null>(null);

  // Timer — only runs during recording
  useEffect(() => {
    if (state === 'recording') {
      timerRef.current = setInterval(() => setSeconds((s) => s + 1), 1000);
    } else {
      if (timerRef.current) clearInterval(timerRef.current);
    }
    return () => { if (timerRef.current) clearInterval(timerRef.current); };
  }, [state]);

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
        return; // success
      } catch (err) {
        lastErr = err instanceof Error ? err : new Error('Upload failed');
      }
    }
    throw lastErr;
  }, []);

  // Snapshot current blobs and upload as a chunk WITHOUT stopping the recorder.
  // This avoids the iOS Safari bug where a new MediaRecorder on the same stream
  // silently stops capturing audio after the first stop/start cycle.
  const rotateChunk = useCallback(async () => {
    if (!isActiveRef.current) return;

    const blobs = [...chunkBlobsRef.current];
    const offset = timeOffsetRef.current;
    const duration = (Date.now() - chunkStartRef.current) / 1000;

    chunkBlobsRef.current = [];
    timeOffsetRef.current += duration;
    chunkStartRef.current = Date.now();

    // Schedule the next rotation before the async upload so the interval stays accurate
    chunkTimerRef.current = setTimeout(rotateChunk, CHUNK_MS);

    // MediaRecorder only includes the EBML/Segment/Tracks header in the very first
    // ondataavailable event. Subsequent chunks are cluster-only (header: 1f43b675)
    // and are rejected by Whisper as "invalid file format". Fix: extract the header
    // bytes from the first rotation and prepend them to all subsequent chunks.
    let blobsForUpload = blobs;
    if (offset === 0) {
      // First rotation — extract the EBML header bytes (everything before first Cluster)
      try {
        const raw = new Uint8Array(await new Blob(blobs, { type: mimeRef.current }).arrayBuffer());
        for (let i = 0; i < raw.length - 3; i++) {
          if (raw[i] === 0x1f && raw[i + 1] === 0x43 && raw[i + 2] === 0xb6 && raw[i + 3] === 0x75) {
            webmHeaderRef.current = raw.buffer.slice(0, i);
            break;
          }
        }
        // Fallback: if no cluster marker found (non-WebM format or unusual encoder),
        // use the first event's blob as the header — slight audio duplication but stays valid.
        if (!webmHeaderRef.current && blobs.length > 0) {
          webmHeaderRef.current = await blobs[0].arrayBuffer();
        }
      } catch (err) {
        console.warn('[rotateChunk] WebM header extraction failed — subsequent chunks may fail:', err);
      }
    } else if (webmHeaderRef.current) {
      // Non-first rotation — prepend the saved header so the upload is a valid WebM file
      blobsForUpload = [new Blob([webmHeaderRef.current], { type: mimeRef.current }), ...blobs];
    }

    const blob = new Blob(blobsForUpload, { type: mimeRef.current });
    if (blob.size >= 1000) {
      try {
        await uploadChunk(blob, offset);
        setChunksSaved((n) => n + 1);
      } catch (err) {
        // Upload failed but recording continues — the missed chunk will leave a gap
        console.warn('[rotate] chunk upload failed:', err instanceof Error ? err.message : err);
      }
    }
  }, [uploadChunk]);

  // Creates ONE MediaRecorder for the entire meeting — never stopped mid-session.
  // Chunk rotation is handled by rotateChunk() via a timer, not by stop/restart.
  const startRecorder = useCallback((stream: MediaStream, mime: string) => {
    const mr = new MediaRecorder(stream, { mimeType: mime });
    recorderRef.current = mr;
    chunkBlobsRef.current = [];
    chunkStartRef.current = Date.now();
    webmHeaderRef.current = null;

    mr.ondataavailable = (e) => {
      if (e.data.size > 0) chunkBlobsRef.current.push(e.data);
    };

    // onstop only fires when the user explicitly stops recording
    mr.onstop = async () => {
      const blobs = chunkBlobsRef.current;
      chunkBlobsRef.current = [];
      const offset = timeOffsetRef.current;

      try {
        // Apply the same header prepend as rotateChunk — the final segment is also cluster-only
        let blobsForUpload = blobs;
        if (offset > 0 && webmHeaderRef.current) {
          blobsForUpload = [new Blob([webmHeaderRef.current], { type: mime }), ...blobs];
        }
        const blob = new Blob(blobsForUpload, { type: mime });
        if (blob.size >= 1000) {
          await uploadChunk(blob, offset);
        }
        setChunksSaved((n) => n + 1);
        setState('queued');

        const id = recordingIdRef.current;
        if (!id) return;
        fetch(`/api/recordings/${id}/finalize`, { method: 'POST', keepalive: true }).catch(() => {});
        router.push(`/recordings/${id}`);
      } catch (err) {
        isActiveRef.current = false;
        setErrorMsg(err instanceof Error ? err.message : 'Upload failed. Please try again.');
        setState('error');
      }
    };

    mr.start(500);
  }, [uploadChunk, router]);

  const start = useCallback(async () => {
    setErrorMsg('');
    setSeconds(0);
    setChunksSaved(0);

    try {
      const createRes = await fetch('/api/recordings/create', { method: 'POST' });
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

      startRecorder(stream, mime);
      chunkTimerRef.current = setTimeout(rotateChunk, CHUNK_MS);
      setState('recording');
    } catch (err) {
      releaseWakeLock();
      setErrorMsg(err instanceof Error ? err.message : 'Microphone access denied. Allow mic access and try again.');
      setState('error');
    }
  }, [startRecorder, rotateChunk, requestWakeLock, releaseWakeLock]);

  const stop = useCallback(() => {
    if (state !== 'recording') return;

    isActiveRef.current = false;
    setState('uploading');

    if (chunkTimerRef.current) {
      clearTimeout(chunkTimerRef.current);
      chunkTimerRef.current = null;
    }

    if (recorderRef.current?.state === 'recording') {
      recorderRef.current.stop();
    }

    // Release mic
    streamRef.current?.getTracks().forEach((t) => t.stop());
    void releaseWakeLock();
  }, [state, releaseWakeLock]);

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
      <main className="flex-1 flex flex-col items-center justify-center gap-10 px-6 pb-safe">

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

        {/* Waveform */}
        <div className="flex items-end justify-center gap-1 h-10">
          {[...Array(13)].map((_, i) =>
            state === 'recording' ? (
              <div
                key={i}
                className="w-1.5 h-full wave-bar-dynamic bg-brand"
              />
            ) : (
              <div key={i} className="w-1.5 h-1 rounded-full bg-surface-border" />
            )
          )}
        </div>

        {/* Record button */}
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

        {/* Status */}
        <div className="text-center space-y-1.5 max-w-xs">
          <p className="font-medium text-ftc-gray">
            {state === 'idle'      && 'Tap to start recording'}
            {state === 'recording' && 'Recording — tap to stop'}
            {state === 'uploading' && 'Saving final segment…'}
            {state === 'queued'    && 'Sending for analysis…'}
            {state === 'error'     && 'Something went wrong'}
          </p>

          {state === 'recording' && chunksSaved > 0 && (
            <p className="text-sm text-ftc-mid">
              {chunksSaved} segment{chunksSaved !== 1 ? 's' : ''} saved safely
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
          <p className="text-xs text-center max-w-xs text-surface-muted">
            Keep screen on while recording. Once you stop, audio is saved on our servers — you can lock your phone and transcription will complete automatically.
          </p>
        )}
      </main>
    </div>
  );
}
