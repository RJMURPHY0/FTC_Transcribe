'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';

const PHRASES = [
  'Hello everyone, thanks for joining the meeting today, let\'s get started with the agenda.',
  'The main action item from last week has been completed and the documents are ready for review.',
  'I\'ll follow up with the team on Thursday and send the updated schedule to everyone by email.',
  'Before we wrap up, does anyone have any questions or anything else they\'d like to raise?',
  'Safety inductions for the new starters need to be booked in before the end of the month.',
];

const MIN_SECONDS = 4;
const MAX_SECONDS = 20;

interface Person { name: string; samples: number; totalDurationS: number; learned?: boolean }

type PhraseState = { blob: Blob | null; seconds: number };

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

  const loadPeople = () => {
    fetch('/api/voice-profiles')
      .then(r => r.ok ? r.json() : { people: [] })
      .then(d => setPeople(d.people ?? []))
      .catch(() => {});
  };
  useEffect(loadPeople, []);

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
    try {
      const preferredMic = localStorage.getItem('preferredMicId');
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: preferredMic ? { deviceId: { ideal: preferredMic } } : true,
      });
      streamRef.current = stream;

      // Live level meter
      const ctx = new AudioContext();
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

      const mime = MediaRecorder.isTypeSupported('audio/webm;codecs=opus') ? 'audio/webm;codecs=opus'
        : MediaRecorder.isTypeSupported('audio/mp4') ? 'audio/mp4'
        : '';
      const mr = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
      mediaRef.current = mr;
      chunksRef.current = [];
      mr.ondataavailable = (e) => { if (e.data.size > 0) chunksRef.current.push(e.data); };
      mr.onstop = () => {
        const blob = new Blob(chunksRef.current, { type: mr.mimeType || 'audio/webm' });
        setPhrases(prev => {
          const next = [...prev];
          next[current] = { blob, seconds: elapsedRef.current };
          return next;
        });
        stopStream();
        setRecording(false);
        setLevel(0);
        // Auto-advance to the next un-recorded phrase
        setCurrent(c => {
          for (let i = c + 1; i < PHRASES.length; i++) return i;
          return c;
        });
      };

      mr.start(250);
      setRecording(true);
      setElapsed(0);
      elapsedRef.current = 0;
      timerRef.current = setInterval(() => {
        elapsedRef.current += 0.1;
        setElapsed(elapsedRef.current);
        if (elapsedRef.current >= MAX_SECONDS) stopRecording();
      }, 100);
    } catch {
      setMessage({ kind: 'err', text: 'Microphone access denied — allow mic access and try again.' });
    }
  }

  const elapsedRef = useRef(0);

  function stopRecording() {
    if (timerRef.current) clearInterval(timerRef.current);
    if (mediaRef.current && mediaRef.current.state !== 'inactive') mediaRef.current.stop();
  }

  const recordedCount = phrases.filter(p => p.blob && p.seconds >= MIN_SECONDS).length;
  const canSubmit = name.trim().length > 1 && recordedCount >= 3 && !submitting;

  async function submit() {
    if (!canSubmit) return;
    setSubmitting(true);
    setMessage(null);
    try {
      const form = new FormData();
      form.append('name', name.trim());
      phrases.forEach((p, i) => {
        if (p.blob && p.seconds >= MIN_SECONDS) {
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
              Read {PHRASES.length} short phrases aloud ({MIN_SECONDS}+ seconds each). The app learns the voice
              from the audio itself and will automatically name this person in future recordings.
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
              <span className="text-xs text-surface-muted">{recordedCount}/{PHRASES.length} phrases recorded (min 3)</span>
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
              <div key={p.name} className="flex items-center justify-between py-3 border-b border-surface-border last:border-0">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <p className="text-sm text-ftc-gray font-medium truncate">{p.name}</p>
                    {p.learned && (
                      <span className="flex-shrink-0 text-[10px] font-semibold px-1.5 py-0.5 rounded bg-brand/15 text-brand">
                        Auto-detected
                      </span>
                    )}
                  </div>
                  <p className="text-xs text-surface-muted">
                    {p.samples} sample{p.samples === 1 ? '' : 's'} · {Math.round(p.totalDurationS)}s of speech
                    {p.learned && ' · read the phrases above to strengthen it'}
                  </p>
                </div>
                <div className="flex items-center gap-2 flex-shrink-0">
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
