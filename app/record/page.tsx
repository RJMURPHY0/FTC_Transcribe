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

  // Timer — only runs during recording
  useEffect(() => {
    if (state === 'recording') {
      timerRef.current = setInterval(() => setSeconds((s) => s + 1), 1000);
    } else {
      if (timerRef.current) clearInterval(timerRef.current);
    }
    return () => { if (timerRef.current) clearInterval(timerRef.current); };
  }, [state]);

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

  // Starts (or restarts) a MediaRecorder on the existing stream
  const startRecorder = useCallback((stream: MediaStream, mime: string) => {
    const mr = new MediaRecorder(stream, { mimeType: mime });
    recorderRef.current = mr;
    chunkBlobsRef.current = [];
    chunkStartRef.current = Date.now();

    mr.ondataavailable = (e) => {
      if (e.data.size > 0) chunkBlobsRef.current.push(e.data);
    };

    mr.onstop = async () => {
      const blob = new Blob(chunkBlobsRef.current, { type: mime });
      chunkBlobsRef.current = [];
      const offset = timeOffsetRef.current;
      const chunkDuration = (Date.now() - chunkStartRef.current) / 1000;
      timeOffsetRef.current += chunkDuration;

      try {
        await uploadChunk(blob, offset);

        if (isActiveRef.current) {
          // Still recording — rotate to next chunk
          setChunksSaved((n) => n + 1);
          startRecorder(stream, mime);
          chunkTimerRef.current = setTimeout(() => {
            if (recorderRef.current?.state === 'recording') {
              recorderRef.current.stop();
            }
          }, CHUNK_MS);
        } else {
          // User stopped — final chunk uploaded successfully.
          // Update state to show "queued" so user knows processing will happen.
          setChunksSaved((n) => n + 1);
          setState('queued');

          // Fire-and-forget finalize — the recording page will poll for status.
          // We navigate immediately so the user can see progress there.
          const id = recordingIdRef.current;
          if (!id) return;

          // Kick off finalize in the background (no await — server does the work)
          fetch(`/api/recordings/${id}/finalize`, { method: 'POST' }).catch(() => {});

          // Navigate to the recording page — it will show "processing" status
          // and automatically reflect completion when the user refreshes.
          router.push(`/recordings/${id}`);
        }
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

      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;

      const mime = getBestMime();
      mimeRef.current = mime;
      timeOffsetRef.current = 0;
      isActiveRef.current = true;

      startRecorder(stream, mime);

      chunkTimerRef.current = setTimeout(() => {
        if (recorderRef.current?.state === 'recording') {
          recorderRef.current.stop();
        }
      }, CHUNK_MS);

      setState('recording');
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Microphone access denied. Allow mic access and try again.');
      setState('error');
    }
  }, [startRecorder]);

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
  }, [state]);

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
              Redirecting you to your recording…
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
            Works for meetings of any length. Audio is saved in 2-minute segments as you record, then transcribed when you stop.
          </p>
        )}
      </main>
    </div>
  );
}
