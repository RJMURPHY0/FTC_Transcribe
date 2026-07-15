'use client';

import { useEffect, useState, useCallback } from 'react';
import Link from 'next/link';

interface MicDevice { deviceId: string; label: string; }
interface Health { db: boolean; openai: boolean; anthropic: boolean; groq: boolean; airtable: boolean; }

function StatusDot({ ok, optional = false }: { ok: boolean; optional?: boolean }) {
  if (ok) return <span className="flex items-center gap-1.5 text-emerald-400 text-sm font-medium">
    <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={2.5} viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
    </svg>
    Connected
  </span>;
  return <span className={`flex items-center gap-1.5 text-sm font-medium ${optional ? 'text-ftc-mid' : 'text-red-400'}`}>
    <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={2.5} viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
    </svg>
    {optional ? 'Not configured (optional)' : 'Not configured'}
  </span>;
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between py-3 border-b border-surface-border last:border-0">
      <span className="text-sm text-ftc-gray">{label}</span>
      {children}
    </div>
  );
}

export default function SettingsPage() {
  const [mics, setMics]           = useState<MicDevice[]>([]);
  const [selectedMic, setSelected] = useState<string>('');
  const [micGranted, setGranted]  = useState(false);
  const [health, setHealth]       = useState<Health | null>(null);
  const [healthLoading, setHL]    = useState(true);
  const [testResult, setTestResult] = useState('');

  // Load saved mic preference
  useEffect(() => {
    const saved = localStorage.getItem('preferredMicId') ?? '';
    setSelected(saved);
  }, []);

  // Fetch health status
  useEffect(() => {
    fetch('/api/health')
      .then(r => r.json())
      .then((d: Health) => setHealth(d))
      .catch(() => setHealth(null))
      .finally(() => setHL(false));
  }, []);

  const loadMics = useCallback(async (requestPermission = false) => {
    try {
      if (requestPermission) {
        // Request permission so we get device labels
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        stream.getTracks().forEach(t => t.stop());
        setGranted(true);
      }
      const devices = await navigator.mediaDevices.enumerateDevices();
      const audioIn = devices
        .filter(d => d.kind === 'audioinput')
        .map((d, i) => ({
          deviceId: d.deviceId,
          label: d.label || `Microphone ${i + 1}`,
        }));
      setMics(audioIn);
    } catch {
      setTestResult('Microphone access denied. Please allow mic access in your browser settings.');
    }
  }, []);

  useEffect(() => {
    // Try to load mics without prompting — will show labels if already granted
    void loadMics(false);
  }, [loadMics]);

  const saveMic = (deviceId: string) => {
    setSelected(deviceId);
    if (deviceId) localStorage.setItem('preferredMicId', deviceId);
    else localStorage.removeItem('preferredMicId');
  };

  const testMic = async () => {
    setTestResult('Testing…');
    try {
      const constraints: MediaStreamConstraints = {
        audio: selectedMic ? { deviceId: { exact: selectedMic } } : true,
      };
      const stream = await navigator.mediaDevices.getUserMedia(constraints);
      setGranted(true);
      await loadMics(false);
      stream.getTracks().forEach(t => t.stop());
      setTestResult('✓ Microphone working');
      setTimeout(() => setTestResult(''), 3000);
    } catch (e) {
      setTestResult(e instanceof Error ? e.message : 'Microphone test failed');
    }
  };

  const selectedLabel = mics.find(m => m.deviceId === selectedMic)?.label ?? 'System default';

  const needsAction = health && (!health.db || (!health.openai && !health.groq) || !health.anthropic);

  return (
    <div className="min-h-screen flex flex-col bg-surface">
      {/* Header */}
      <header className="sticky top-0 z-20 border-b border-surface-border bg-surface/80 backdrop-blur-md">
        <div className="max-w-2xl mx-auto px-4 py-3 flex items-center gap-3">
          <Link
            href="/"
            className="flex items-center gap-1.5 text-sm font-medium text-ftc-mid hover:text-ftc-gray transition-colors p-2 -ml-2 rounded-xl touch-manipulation"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" d="M15 19l-7-7 7-7" />
            </svg>
            Back
          </Link>
          <h1 className="font-semibold text-sm text-ftc-gray">Settings</h1>
          {needsAction && (
            <span className="ml-auto text-xs px-2 py-0.5 rounded-full bg-red-500/10 text-red-400 font-medium">
              Action needed
            </span>
          )}
        </div>
      </header>

      <main className="max-w-2xl mx-auto w-full px-4 py-8 space-y-8">

        {/* ── Microphone ── */}
        <section>
          <h2 className="text-xs font-semibold uppercase tracking-widest text-ftc-mid mb-3">
            Microphone
          </h2>
          <div className="rounded-2xl border border-surface-border bg-surface-card p-5 space-y-4">

            {!micGranted && mics.every(m => !m.label || m.label.startsWith('Microphone')) ? (
              <div className="text-sm text-ftc-mid">
                Allow microphone access to see your available devices.
                <button
                  onClick={() => void loadMics(true)}
                  className="ml-2 text-brand underline underline-offset-2 touch-manipulation"
                >
                  Grant access
                </button>
              </div>
            ) : (
              <div>
                <label className="block text-xs text-ftc-mid mb-2">Default microphone</label>
                <select
                  value={selectedMic}
                  onChange={e => saveMic(e.target.value)}
                  className="w-full bg-surface-raised border border-surface-border rounded-xl px-3 py-2.5 text-sm text-ftc-gray outline-none focus:border-brand/50 transition-colors"
                >
                  <option value="">System default</option>
                  {mics.map(m => (
                    <option key={m.deviceId} value={m.deviceId}>{m.label}</option>
                  ))}
                </select>
                <p className="text-xs text-surface-muted mt-2">
                  Currently selected: <span className="text-ftc-mid">{selectedLabel}</span>
                </p>
              </div>
            )}

            <div className="flex items-center gap-3">
              <button
                onClick={testMic}
                className="flex items-center gap-1.5 text-xs px-3 py-2 rounded-xl border border-surface-border text-ftc-mid hover:text-ftc-gray hover:border-surface-muted transition-colors touch-manipulation"
              >
                <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M19 10v2a7 7 0 0 1-14 0v-2H3v2a9 9 0 0 0 8 8.94V22H9v2h6v-2h-2v-1.06A9 9 0 0 0 21 12v-2h-2z"/>
                </svg>
                Test microphone
              </button>
              {testResult && (
                <span className={`text-xs ${testResult.startsWith('✓') ? 'text-emerald-400' : 'text-red-400'}`}>
                  {testResult}
                </span>
              )}
            </div>

            <p className="text-xs text-surface-muted">
              This setting is saved on this device only and applies to all new recordings.
            </p>
          </div>
        </section>

        {/* ── System Status ── */}
        <section>
          <h2 className="text-xs font-semibold uppercase tracking-widest text-ftc-mid mb-3">
            System Status
          </h2>
          <div className="rounded-2xl border border-surface-border bg-surface-card px-5">
            {healthLoading ? (
              <div className="py-8 flex justify-center">
                <div className="w-5 h-5 rounded-full border-2 border-surface-border border-t-brand animate-spin" />
              </div>
            ) : !health ? (
              <p className="py-4 text-sm text-red-400">Could not reach server. Check your internet connection.</p>
            ) : (
              <>
                <Row label="Database">
                  <StatusDot ok={health.db} />
                </Row>
                <Row label="Transcription (Groq / OpenAI Whisper)">
                  <StatusDot ok={health.groq || health.openai} />
                </Row>
                <Row label="AI Analysis (Claude / Anthropic)">
                  <StatusDot ok={health.anthropic} />
                </Row>
                <Row label="Airtable Backup">
                  <StatusDot ok={health.airtable} optional />
                </Row>

                {needsAction && (
                  <div className="py-4 mt-1 border-t border-surface-border">
                    <p className="text-sm text-red-400 font-medium mb-1">Setup required</p>
                    <p className="text-xs text-ftc-mid leading-relaxed">
                      {!health.db && 'Database is not connected — add DATABASE_URL to your environment. '}
                      {(!health.openai && !health.groq) && 'No transcription key found — add GROQ_API_KEY (free at console.groq.com) or OPENAI_API_KEY. '}
                      {!health.anthropic && 'No AI analysis key — add ANTHROPIC_API_KEY. '}
                    </p>
                    <p className="text-xs text-surface-muted mt-2">
                      On Vercel: Dashboard → Project → Settings → Environment Variables.
                      Locally: add to <code className="bg-surface-raised px-1 rounded">.env.local</code> and restart.
                    </p>
                  </div>
                )}
              </>
            )}
          </div>
        </section>

        {/* ── Voice Profiles ── */}
        <section>
          <h2 className="text-xs font-semibold uppercase tracking-widest text-ftc-mid mb-3">
            Voice Identification
          </h2>
          <Link
            href="/voice-setup"
            className="flex items-center justify-between rounded-2xl border border-surface-border bg-surface-card p-5 hover:border-brand/40 transition-colors touch-manipulation"
          >
            <div>
              <p className="text-sm text-ftc-gray font-medium">Voice profiles</p>
              <p className="text-xs text-ftc-mid mt-1">
                Teach the app who's who — enrolled voices are named automatically in every recording.
              </p>
            </div>
            <svg className="w-4 h-4 text-ftc-mid shrink-0" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
            </svg>
          </Link>
        </section>

        {/* ── Audio Quality ── */}
        <section>
          <h2 className="text-xs font-semibold uppercase tracking-widest text-ftc-mid mb-3">
            Recording
          </h2>
          <div className="rounded-2xl border border-surface-border bg-surface-card px-5">
            <Row label="Chunk duration">
              <span className="text-sm text-ftc-mid">2 minutes (auto-saves progress)</span>
            </Row>
            <Row label="Format">
              <span className="text-sm text-ftc-mid">WebM / Opus (browser default)</span>
            </Row>
            <Row label="Background processing">
              <span className="text-sm text-emerald-400">Always on</span>
            </Row>
          </div>
        </section>

        {/* ── About ── */}
        <section>
          <h2 className="text-xs font-semibold uppercase tracking-widest text-ftc-mid mb-3">
            About
          </h2>
          <div className="rounded-2xl border border-surface-border bg-surface-card px-5">
            <Row label="App">
              <span className="text-sm text-ftc-mid">FTC Transcribe</span>
            </Row>
            <Row label="Backend">
              <span className="text-sm text-ftc-mid truncate max-w-[200px]">{typeof window !== 'undefined' ? window.location.hostname : '—'}</span>
            </Row>
            <Row label="Browser">
              <span className="text-sm text-ftc-mid">{typeof window !== 'undefined' ? (navigator.userAgent.includes('Safari') && !navigator.userAgent.includes('Chrome') ? 'Safari' : navigator.userAgent.includes('Firefox') ? 'Firefox' : 'Chrome / Edge') : '—'}</span>
            </Row>
          </div>
        </section>

      </main>
    </div>
  );
}
