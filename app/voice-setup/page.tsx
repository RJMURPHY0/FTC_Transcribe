'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';

// Longer, phonetically varied passages produce far stronger voiceprints than
// short sentences — total enrollment speech should exceed ~60 seconds. The
// final prompt captures SPONTANEOUS speech, which matches how people actually
// talk in meetings much better than read sentences do.
const PHRASES = [
  'Hello everyone, thanks for joining the meeting today. Let\'s get started with the agenda. The main action item from last week has been completed, the documents are ready for review, and I\'ll walk everyone through the changes once we\'ve covered the safety items.',
  'When the sunlight strikes raindrops in the air, they act as a prism and form a rainbow. The rainbow is a division of white light into many beautiful colours. These take the shape of a long round arch, with its path high above, and its two ends apparently beyond the horizon.',
  'I\'ll follow up with the team on Thursday and send the updated schedule to everyone by email. Safety inductions for the new starters need to be booked in before the end of the month, and the scaffolding inspection is due first thing on Monday morning.',
  'Before we wrap up, does anyone have any questions or anything else they\'d like to raise? Quick reminders: keep your certificates up to date, check the notice board for the July rota, and flag any near misses straight away — even the small stuff matters.',
  'For this last one, don\'t read anything — just talk naturally for about twenty seconds in your own words. Describe what you did at work yesterday, or what your plans are for the rest of the week. Speak the way you would in a normal meeting.',
];

const MIN_SECONDS = 4;
const MAX_SECONDS = 20;
// Minimum phrases needed to save. The server stores every usable sample, so one
// clear 4s+ phrase is enough to create a working voiceprint — more just improves
// accuracy. Keeping this at 1 avoids the "Save stays greyed out" trap.
const MIN_PHRASES = 1;
const RECOMMENDED_PHRASES = 3;

interface Person { name: string; samples: number; totalDurationS: number; learned?: boolean }

type PhraseState = { blob: Blob | null; seconds: number };

type VoiceSample = {
  id: string;
  source: string;
  durationS: number;
  deviceLabel: string;
  createdAt: string;
  recordingId: string | null;
  recordingTitle: string | null;
  excerpt: string;
  consistency: number | null;
  confidencePct: number | null;
  legacyModel: boolean;
  usedForMatching: boolean;
  clipUrl: string | null;
  clipStart: number | null;
  clipEnd: number | null;
};

function fmtClock(s: number): string {
  return `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
}

const SOURCE_LABEL: Record<string, string> = {
  enrollment: 'Enrolled',
  match: 'Auto-learned',
  relabel: 'From rename',
  auto: 'Self-intro',
};

export default function VoiceSetupPage() {
  const [people, setPeople] = useState<Person[]>([]);
  const [name, setName] = useState('');
  const [phrases, setPhrases] = useState<PhraseState[]>(PHRASES.map(() => ({ blob: null, seconds: 0 })));
  const [current, setCurrent] = useState(0);
  const [recording, setRecording] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [level, setLevel] = useState(0);
  const [submitting, setSubmitting] = useState(false);
  const [message, setMessage] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);

  const mediaRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const rafRef = useRef<number>(0);
  // Wall-clock start time — reliable on mobile where setInterval throttles/drifts.
  const startTsRef = useRef(0);
  const elapsedRef = useRef(0);

  const loadPeople = () => {
    fetch('/api/voice-profiles')
      .then(r => r.ok ? r.json() : { people: [] })
      .then(d => setPeople(d.people ?? []))
      .catch(() => {});
  };
  useEffect(loadPeople, []);

  // Per-person training-sample inspector
  const [expanded, setExpanded] = useState<string | null>(null);
  const [samples, setSamples] = useState<VoiceSample[]>([]);
  const [samplesLoading, setSamplesLoading] = useState(false);
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  async function toggleSamples(personName: string) {
    if (expanded === personName) { setExpanded(null); return; }
    setExpanded(personName);
    setSamples([]);
    setConfirmId(null);
    setSamplesLoading(true);
    try {
      const r = await fetch(`/api/voice-profiles/samples?name=${encodeURIComponent(personName)}`);
      const d = r.ok ? await r.json() : { samples: [] };
      setSamples(d.samples ?? []);
    } catch {
      setSamples([]);
    }
    setSamplesLoading(false);
  }

  // Per-sample clip playback — one shared <audio>, seeks into meeting audio
  // for learned samples, streams the stored clip for enrolled ones.
  const [playingId, setPlayingId] = useState<string | null>(null);
  const clipAudioRef = useRef<HTMLAudioElement | null>(null);
  const clipEndAtRef = useRef<number | null>(null);

  function stopClip() {
    const a = clipAudioRef.current;
    if (a) { a.pause(); a.removeAttribute('src'); }
    setPlayingId(null);
  }

  function playClip(s: VoiceSample) {
    if (!s.clipUrl) return;
    if (playingId === s.id) { stopClip(); return; }
    stopClip();
    const a = clipAudioRef.current ?? new Audio();
    clipAudioRef.current = a;
    clipEndAtRef.current = s.clipEnd;
    a.src = s.clipUrl;
    a.onloadedmetadata = () => { if (s.clipStart) a.currentTime = s.clipStart; };
    a.ontimeupdate = () => {
      if (clipEndAtRef.current !== null && a.currentTime >= clipEndAtRef.current) stopClip();
    };
    a.onended = () => setPlayingId(null);
    a.onerror = () => setPlayingId(null);
    void a.play().then(() => setPlayingId(s.id)).catch(() => setPlayingId(null));
  }

  useEffect(() => () => { clipAudioRef.current?.pause(); }, []);

  async function deleteSample(id: string) {
    setDeletingId(id);
    try {
      const r = await fetch(`/api/voice-profiles/samples?id=${encodeURIComponent(id)}`, { method: 'DELETE' });
      if (r.ok) {
        setSamples(prev => prev.filter(s => s.id !== id));
        loadPeople(); // sample counts changed; person disappears if none left
      }
    } catch { /* leave the row; user can retry */ }
    setDeletingId(null);
    setConfirmId(null);
  }

  useEffect(() => () => { stopStream(); }, []);

  function stopStream() {
    if (timerRef.current) clearInterval(timerRef.current);
    cancelAnimationFrame(rafRef.current);
    audioCtxRef.current?.close().catch(() => {});
    audioCtxRef.current = null;
    streamRef.current?.getTracks().forEach(t => t.stop());
    streamRef.current = null;
  }

  async function startRecording() {
    setMessage(null);

    if (typeof MediaRecorder === 'undefined') {
      setMessage({ kind: 'err', text: 'This browser can\'t record audio. Try Safari or Chrome, or record on another device.' });
      return;
    }

    let stream: MediaStream;
    try {
      const preferredMic = localStorage.getItem('preferredMicId');
      stream = await navigator.mediaDevices.getUserMedia({
        audio: preferredMic ? { deviceId: { ideal: preferredMic } } : true,
      });
      streamRef.current = stream;
    } catch {
      setMessage({ kind: 'err', text: 'Microphone access denied — allow mic access in your browser and try again.' });
      return;
    }

    // Live level meter — best-effort only. AudioContext can throw on some
    // mobile browsers; it must NEVER prevent recording, so it's isolated.
    try {
      const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (Ctx) {
        const ctx = new Ctx();
        audioCtxRef.current = ctx;
        const analyser = ctx.createAnalyser();
        analyser.fftSize = 512;
        ctx.createMediaStreamSource(stream).connect(analyser);
        const buf = new Uint8Array(analyser.frequencyBinCount);
        const tick = () => {
          analyser.getByteTimeDomainData(buf);
          let sum = 0;
          for (let i = 0; i < buf.length; i++) { const v = (buf[i] - 128) / 128; sum += v * v; }
          setLevel(Math.min(1, Math.sqrt(sum / buf.length) * 4));
          rafRef.current = requestAnimationFrame(tick);
        };
        tick();
      }
    } catch { /* meter is cosmetic — ignore */ }

    try {
      const mime = MediaRecorder.isTypeSupported('audio/webm;codecs=opus') ? 'audio/webm;codecs=opus'
        : MediaRecorder.isTypeSupported('audio/webm') ? 'audio/webm'
        : MediaRecorder.isTypeSupported('audio/mp4') ? 'audio/mp4'
        : '';
      const mr = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
      mediaRef.current = mr;
      chunksRef.current = [];
      mr.ondataavailable = (e) => { if (e.data && e.data.size > 0) chunksRef.current.push(e.data); };
      mr.onstop = () => {
        const blob = new Blob(chunksRef.current, { type: mr.mimeType || 'audio/webm' });
        // Measure from wall-clock, not the drifting timer — accurate even if the
        // interval was throttled while recording on a phone.
        const seconds = startTsRef.current ? (Date.now() - startTsRef.current) / 1000 : elapsedRef.current;
        stopStream();
        setRecording(false);
        setLevel(0);

        // If the device handed back no audio, say so plainly instead of leaving
        // Save silently greyed out. Don't record an empty blob.
        if (blob.size === 0) {
          setMessage({ kind: 'err', text: 'No audio was captured — check your mic isn\'t muted and record again.' });
          return;
        }

        setPhrases(prev => {
          const next = [...prev];
          next[current] = { blob, seconds: Math.round(seconds * 10) / 10 };
          return next;
        });
        // Auto-advance to the next un-recorded phrase
        setCurrent(c => {
          for (let i = c + 1; i < PHRASES.length; i++) return i;
          return c;
        });
      };

      // No timeslice: iOS Safari records audio/mp4 and, when given a timeslice,
      // emits fragmented chunks that concatenate into an empty/unplayable blob —
      // which left `blob` unset and Save greyed out forever. A single dataavailable
      // on stop gives one complete, valid clip on every platform.
      mr.start();
      setRecording(true);
      setElapsed(0);
      elapsedRef.current = 0;
      startTsRef.current = Date.now();
      timerRef.current = setInterval(() => {
        elapsedRef.current = (Date.now() - startTsRef.current) / 1000;
        setElapsed(elapsedRef.current);
        if (elapsedRef.current >= MAX_SECONDS) stopRecording();
      }, 100);
    } catch {
      stopStream();
      setRecording(false);
      setMessage({ kind: 'err', text: 'Couldn\'t start the recorder on this device. Try reloading the page.' });
    }
  }

  function stopRecording() {
    if (timerRef.current) clearInterval(timerRef.current);
    if (mediaRef.current && mediaRef.current.state !== 'inactive') mediaRef.current.stop();
  }

  // Any recording the user captured. The server is the source of truth on whether
  // a sample is long/clear enough (it needs ≥2s of speech and returns a clear
  // error otherwise), so we never block Save on a client-side duration figure —
  // that measurement is unreliable on mobile and was the real "stays greyed" trap.
  const capturedCount = phrases.filter(p => p.blob && p.blob.size > 0).length;
  const goodCount = phrases.filter(p => p.blob && p.blob.size > 0 && p.seconds >= MIN_SECONDS).length;
  const canSubmit = name.trim().length > 1 && capturedCount >= MIN_PHRASES && !submitting;
  const disabledReason = name.trim().length <= 1
    ? 'Enter whose voice this is first.'
    : capturedCount < MIN_PHRASES
    ? 'Record at least one phrase.'
    : '';

  async function submit() {
    if (!canSubmit) return;
    setSubmitting(true);
    setMessage(null);
    try {
      const form = new FormData();
      form.append('name', name.trim());
      phrases.forEach((p, i) => {
        if (p.blob) {
          const ext = p.blob.type.includes('mp4') ? 'mp4' : 'webm';
          form.append('samples', p.blob, `phrase-${i + 1}.${ext}`);
        }
      });
      const res = await fetch('/api/voice-profiles', { method: 'POST', body: form });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? 'Enrollment failed');
      setMessage({
        kind: 'ok',
        text: `Voice saved for ${name.trim()} (${data.saved} samples). Future recordings will label this voice automatically — accuracy improves every time you correct a speaker name.`,
      });
      setPhrases(PHRASES.map(() => ({ blob: null, seconds: 0 })));
      setCurrent(0);
      setName('');
      loadPeople();
    } catch (e) {
      setMessage({ kind: 'err', text: e instanceof Error ? e.message : 'Enrollment failed.' });
    } finally {
      setSubmitting(false);
    }
  }

  async function removePerson(personName: string) {
    if (!confirm(`Remove all voice samples for ${personName}?`)) return;
    await fetch(`/api/voice-profiles?name=${encodeURIComponent(personName)}`, { method: 'DELETE' }).catch(() => {});
    loadPeople();
  }

  return (
    <div className="min-h-screen flex flex-col bg-surface">
      <header className="sticky top-0 z-20 border-b border-surface-border bg-surface/80 backdrop-blur-md">
        <div className="max-w-2xl mx-auto px-4 py-3 flex items-center gap-3">
          <Link
            href="/settings"
            className="flex items-center gap-1.5 text-sm font-medium text-ftc-mid hover:text-ftc-gray transition-colors p-2 -ml-2 rounded-xl touch-manipulation"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" d="M15 19l-7-7 7-7" />
            </svg>
            Back
          </Link>
          <h1 className="font-semibold text-sm text-ftc-gray">Voice Profiles</h1>
        </div>
      </header>

      <main className="max-w-2xl mx-auto w-full px-4 py-8 space-y-8">

        {/* ── Enroll ── */}
        <section>
          <h2 className="text-xs font-semibold uppercase tracking-widest text-ftc-mid mb-3">
            Teach the app a voice
          </h2>
          <div className="rounded-2xl border border-surface-border bg-surface-card p-5 space-y-5">
            <p className="text-xs text-ftc-mid leading-relaxed">
              Record at least one passage aloud ({MIN_SECONDS}+ seconds) — recording all {PHRASES.length} gives the
              best accuracy. The app learns the voice from the audio itself and will automatically name this
              person in future recordings. For best results: use the same device you record meetings with,
              sit at a normal speaking distance, and talk at your natural pace.
            </p>

            <div>
              <label className="block text-xs text-ftc-mid mb-2">Whose voice is this?</label>
              <input
                value={name}
                onChange={e => setName(e.target.value)}
                list="voice-people"
                placeholder="e.g. Ryan Murphy"
                className="w-full bg-surface-raised border border-surface-border rounded-xl px-3 py-2.5 text-sm text-ftc-gray outline-none focus:border-brand/50 transition-colors"
              />
              <datalist id="voice-people">
                {people.map(p => <option key={p.name} value={p.name} />)}
              </datalist>
            </div>

            {/* Phrase chips */}
            <div className="flex flex-wrap gap-2">
              {PHRASES.map((_, i) => {
                const done = !!phrases[i].blob && phrases[i].seconds >= MIN_SECONDS;
                return (
                  <button
                    key={i}
                    onClick={() => !recording && setCurrent(i)}
                    className={`w-9 h-9 rounded-xl text-xs font-semibold border transition-colors touch-manipulation ${
                      i === current
                        ? 'border-brand text-brand bg-brand/10'
                        : done
                        ? 'border-emerald-500/40 text-emerald-400 bg-emerald-500/10'
                        : 'border-surface-border text-ftc-mid'
                    }`}
                  >
                    {done ? '✓' : i + 1}
                  </button>
                );
              })}
            </div>

            {/* Current phrase */}
            <div className="rounded-xl bg-surface-raised border border-surface-border p-4">
              <p className="text-[11px] uppercase tracking-widest text-surface-muted mb-2">
                Phrase {current + 1} of {PHRASES.length} — read aloud
              </p>
              <p className="text-base text-ftc-gray leading-relaxed">“{PHRASES[current]}”</p>
            </div>

            {/* Record controls */}
            <div className="flex items-center gap-4">
              {!recording ? (
                <button
                  onClick={() => void startRecording()}
                  className="flex items-center gap-2 px-4 py-2.5 rounded-xl bg-brand text-white text-sm font-semibold touch-manipulation active:scale-95 transition-transform"
                >
                  <span className="w-2.5 h-2.5 rounded-full bg-red-400" />
                  {phrases[current].blob ? 'Re-record' : 'Record'}
                </button>
              ) : (
                <button
                  onClick={stopRecording}
                  className="flex items-center gap-2 px-4 py-2.5 rounded-xl bg-red-500 text-white text-sm font-semibold touch-manipulation active:scale-95 transition-transform"
                >
                  <span className="w-2.5 h-2.5 rounded-sm bg-white" />
                  Stop ({elapsed.toFixed(0)}s)
                </button>
              )}

              {recording && (
                <div className="flex-1 h-2 rounded-full bg-surface-raised overflow-hidden">
                  <div
                    className="h-full bg-emerald-400 transition-[width] duration-100"
                    style={{ width: `${Math.round(level * 100)}%` }}
                  />
                </div>
              )}
              {!recording && phrases[current].blob && (
                <span className={`text-xs ${phrases[current].seconds >= MIN_SECONDS ? 'text-emerald-400' : 'text-red-400'}`}>
                  {phrases[current].seconds >= MIN_SECONDS
                    ? `✓ ${phrases[current].seconds.toFixed(0)}s captured`
                    : `Too short (${phrases[current].seconds.toFixed(0)}s) — record at least ${MIN_SECONDS}s`}
                </span>
              )}
            </div>

            <div className="flex items-center justify-between pt-1">
              <span className="text-xs text-surface-muted">
                {capturedCount}/{PHRASES.length} phrases recorded
                {goodCount < RECOMMENDED_PHRASES && ` (${RECOMMENDED_PHRASES}+ of ${MIN_SECONDS}s+ recommended)`}
              </span>
              <button
                onClick={() => void submit()}
                disabled={!canSubmit}
                className={`px-4 py-2.5 rounded-xl text-sm font-semibold touch-manipulation transition-colors ${
                  canSubmit ? 'bg-emerald-500 text-white active:scale-95' : 'bg-surface-raised text-surface-muted cursor-not-allowed'
                }`}
              >
                {submitting ? 'Saving voice…' : 'Save voice profile'}
              </button>
            </div>

            {!canSubmit && !submitting && disabledReason && (
              <p className="text-xs text-surface-muted text-right -mt-3">{disabledReason}</p>
            )}

            {message && (
              <p className={`text-xs leading-relaxed ${message.kind === 'ok' ? 'text-emerald-400' : 'text-red-400'}`}>
                {message.text}
              </p>
            )}
          </div>
        </section>

        {/* ── Enrolled voices ── */}
        <section>
          <h2 className="text-xs font-semibold uppercase tracking-widest text-ftc-mid mb-3">
            Enrolled voices
          </h2>
          <div className="rounded-2xl border border-surface-border bg-surface-card px-5">
            {people.length === 0 ? (
              <p className="py-4 text-sm text-ftc-mid">No voices enrolled yet.</p>
            ) : people.map(p => (
              <div key={p.name} className="border-b border-surface-border last:border-0">
                <div className="flex items-center justify-between py-3">
                  <button
                    onClick={() => void toggleSamples(p.name)}
                    className="min-w-0 text-left flex-1 touch-manipulation"
                  >
                    <div className="flex items-center gap-2">
                      <p className="text-sm text-ftc-gray font-medium truncate">{p.name}</p>
                      {p.learned && (
                        <span className="flex-shrink-0 text-[10px] font-semibold px-1.5 py-0.5 rounded bg-brand/15 text-brand">
                          Auto-detected
                        </span>
                      )}
                      <svg
                        className={`w-3 h-3 flex-shrink-0 text-surface-muted transition-transform ${expanded === p.name ? 'rotate-180' : ''}`}
                        viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5"
                      >
                        <path d="M2 4.5 6 8.5 10 4.5" />
                      </svg>
                    </div>
                    <p className="text-xs text-ftc-mid">
                      {p.samples} sample{p.samples === 1 ? '' : 's'} · {Math.round(p.totalDurationS)}s of speech
                      {p.learned && ' · read the phrases above to strengthen it'}
                    </p>
                  </button>
                  <div className="flex items-center gap-2 flex-shrink-0 ml-2">
                    {p.learned && (
                      <button
                        onClick={() => { setName(p.name); window.scrollTo({ top: 0, behavior: 'smooth' }); }}
                        className="text-xs px-3 py-1.5 rounded-xl border border-brand/30 text-brand hover:bg-brand/10 transition-colors touch-manipulation"
                      >
                        Improve
                      </button>
                    )}
                    <button
                      onClick={() => void removePerson(p.name)}
                      className="text-xs px-3 py-1.5 rounded-xl border border-surface-border text-red-400 hover:border-red-400/40 transition-colors touch-manipulation"
                    >
                      Remove
                    </button>
                  </div>
                </div>

                {/* Training samples for this person */}
                {expanded === p.name && (
                  <div className="pb-3 space-y-2">
                    {samplesLoading ? (
                      <p className="text-xs text-ftc-mid py-1">Loading samples…</p>
                    ) : samples.length === 0 ? (
                      <p className="text-xs text-ftc-mid py-1">No samples found.</p>
                    ) : samples.map(s => (
                      <div key={s.id} className="rounded-xl bg-surface-raised border border-surface-border p-3">
                        <div className="flex items-center justify-between gap-2">
                          <div className="flex items-center gap-x-2 gap-y-1 flex-wrap min-w-0 text-xs text-ftc-gray">
                            <span className="font-semibold px-1.5 py-0.5 rounded bg-brand/15 text-brand text-[11px]">
                              {SOURCE_LABEL[s.source] ?? s.source}
                            </span>
                            <span>{new Date(s.createdAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}</span>
                            <span className="text-ftc-mid">·</span>
                            <span>{Math.round(s.durationS)}s</span>
                            {s.deviceLabel && (
                              <>
                                <span className="text-ftc-mid">·</span>
                                <span>{s.deviceLabel}</span>
                              </>
                            )}
                            {s.confidencePct !== null && (
                              <>
                                <span className="text-ftc-mid">·</span>
                                <span className={
                                  s.confidencePct >= 60 ? 'text-emerald-400 font-semibold'
                                    : s.confidencePct >= 50 ? 'text-amber-400 font-semibold'
                                    : 'text-red-500 font-semibold'
                                }>
                                  {s.confidencePct}% voice confidence
                                </span>
                              </>
                            )}
                            {!s.usedForMatching && (
                              <>
                                <span className="text-ftc-mid">·</span>
                                <span className={`px-1.5 py-0.5 rounded text-[11px] font-semibold ${
                                  s.legacyModel ? 'bg-amber-500/15 text-amber-400' : 'bg-red-500/15 text-red-400'
                                }`}>
                                  {s.legacyModel
                                    ? 'Old voice model — re-record to keep recognition'
                                    : 'Excluded from training — likely someone else'}
                                </span>
                              </>
                            )}
                          </div>
                          <div className="flex items-center gap-1.5 flex-shrink-0">
                            {s.clipUrl && (
                              <button
                                onClick={() => playClip(s)}
                                aria-label={playingId === s.id ? 'Stop clip' : 'Play voice clip'}
                                title={playingId === s.id ? 'Stop' : 'Listen to this sample'}
                                className={`w-8 h-8 flex items-center justify-center rounded-lg border transition-colors touch-manipulation ${
                                  playingId === s.id
                                    ? 'bg-brand text-white border-brand'
                                    : 'bg-brand/15 text-brand border-brand/30 hover:bg-brand/25'
                                }`}
                              >
                                {playingId === s.id ? (
                                  <svg className="w-3 h-3" fill="currentColor" viewBox="0 0 16 16">
                                    <rect x="3" y="3" width="10" height="10" rx="1.5" />
                                  </svg>
                                ) : (
                                  <svg className="w-3.5 h-3.5" fill="currentColor" viewBox="0 0 16 16">
                                    <path d="M5 3.5v9l8-4.5-8-4.5z" />
                                  </svg>
                                )}
                              </button>
                            )}
                            {confirmId === s.id ? (
                              <div className="flex items-center gap-2 text-xs">
                                <span className="text-ftc-gray">Delete?</span>
                                <button
                                  onClick={() => void deleteSample(s.id)}
                                  disabled={deletingId === s.id}
                                  className="px-2.5 py-1 rounded-lg bg-red-500 text-white font-semibold touch-manipulation disabled:opacity-50"
                                >
                                  {deletingId === s.id ? '…' : 'Yes'}
                                </button>
                                <button
                                  onClick={() => setConfirmId(null)}
                                  className="px-2.5 py-1 rounded-lg border border-surface-border text-ftc-gray touch-manipulation"
                                >
                                  No
                                </button>
                              </div>
                            ) : (
                              <button
                                onClick={() => setConfirmId(s.id)}
                                aria-label="Delete sample"
                                title="Delete this sample"
                                className="w-8 h-8 flex items-center justify-center rounded-lg border border-red-500/30 text-red-500 hover:bg-red-500/10 hover:border-red-500/60 transition-colors touch-manipulation"
                              >
                                <svg className="w-3.5 h-3.5" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
                                  <path d="M2.5 4h11M6.5 4V2.8a.8.8 0 0 1 .8-.8h1.4a.8.8 0 0 1 .8.8V4m2.7 0-.5 9.2a1 1 0 0 1-1 .95H5.3a1 1 0 0 1-1-.95L3.8 4M6.5 7v4M9.5 7v4" />
                                </svg>
                              </button>
                            )}
                          </div>
                        </div>
                        {s.excerpt && (
                          <p className="mt-2 text-xs text-ftc-gray leading-relaxed">
                            <span className="text-ftc-mid">Trained on:</span> “{s.excerpt}”
                          </p>
                        )}
                        {s.recordingId && (
                          <Link
                            href={`/recordings/${s.recordingId}`}
                            className="inline-block mt-1.5 text-[11px] text-brand hover:underline"
                          >
                            From: {s.recordingTitle ?? 'meeting recording'}
                            {s.clipStart !== null && s.clipEnd !== null && ` · at ${fmtClock(s.clipStart)}`} →
                          </Link>
                        )}
                        {!s.recordingId && s.source === 'enrollment' && (
                          <p className="mt-1.5 text-[11px] text-ftc-mid">
                            Recorded at enrollment{s.clipUrl ? ' — tap play to hear it.' : '.'}
                          </p>
                        )}
                      </div>
                    ))}
                    {!samplesLoading && samples.length > 0 && (
                      <p className="text-[11px] text-ftc-mid leading-relaxed">
                        Deleting a bad sample (wrong person, noisy room) improves matching. A low
                        “voice match” score usually means the sample caught someone else&apos;s voice.
                      </p>
                    )}
                  </div>
                )}
              </div>
            ))}
          </div>
          <p className="text-xs text-surface-muted mt-3 leading-relaxed">
            Voices also get learned automatically: whenever you rename a speaker on a finished recording,
            that voice is saved under the new name for future meetings.
          </p>
        </section>
      </main>
    </div>
  );
}
