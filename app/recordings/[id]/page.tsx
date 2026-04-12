import Link from 'next/link';
import { notFound } from 'next/navigation';
import { prisma } from '@/lib/db';
import DeleteButton from './DeleteButton';
import EditableTitle from './EditableTitle';
import ChatPanel from './ChatPanel';
import type { TranscriptSegment } from '@/lib/ai';

export const dynamic = 'force-dynamic';

function formatDate(date: Date) {
  return new Intl.DateTimeFormat('en-GB', {
    weekday: 'short', day: 'numeric', month: 'long',
    year: 'numeric', hour: '2-digit', minute: '2-digit',
  }).format(new Date(date));
}

// Colours cycle through speakers consistently
const SPEAKER_COLOURS = [
  { label: 'text-blue-400',   dot: 'bg-blue-400',   border: 'border-blue-400/20',   bg: 'bg-blue-400/5'   },
  { label: 'text-violet-400', dot: 'bg-violet-400', border: 'border-violet-400/20', bg: 'bg-violet-400/5' },
  { label: 'text-emerald-400',dot: 'bg-emerald-400',border: 'border-emerald-400/20',bg: 'bg-emerald-400/5' },
  { label: 'text-amber-400',  dot: 'bg-amber-400',  border: 'border-amber-400/20',  bg: 'bg-amber-400/5'  },
  { label: 'text-rose-400',   dot: 'bg-rose-400',   border: 'border-rose-400/20',   bg: 'bg-rose-400/5'   },
];

function speakerIndex(speaker: string): number {
  const match = speaker.match(/\d+/);
  return match ? (parseInt(match[0], 10) - 1) % SPEAKER_COLOURS.length : 0;
}

function formatTimestamp(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

function SpeakerBlock({ seg }: { seg: { speaker: string; start: number; end: number; text: string } }) {
  const idx = speakerIndex(seg.speaker);
  const c = SPEAKER_COLOURS[idx];
  return (
    <div className={`rounded-xl border ${c.border} ${c.bg} px-4 py-3`}>
      <div className="flex items-center gap-2 mb-1.5">
        <span className={`w-2 h-2 rounded-full flex-shrink-0 ${c.dot}`} />
        <span className={`text-xs font-semibold ${c.label}`}>{seg.speaker}</span>
        <span className="text-[10px] text-ftc-mid ml-auto tabular-nums">
          {formatTimestamp(seg.start)}
        </span>
      </div>
      <p className="text-sm text-ftc-gray leading-relaxed">{seg.text.trim()}</p>
    </div>
  );
}

function SectionCard({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-2xl border border-surface-border bg-surface-card p-5">
      <h2 className="text-xs font-semibold uppercase tracking-widest text-ftc-mid mb-4">{title}</h2>
      {children}
    </div>
  );
}

export default async function RecordingPage({ params }: { params: { id: string } }) {
  const recording = await prisma.recording
    .findUnique({ where: { id: params.id }, include: { transcript: true, summary: true } })
    .catch(() => null);

  if (!recording) notFound();

  const actions:   string[] = recording.summary ? JSON.parse(recording.summary.actionItems) : [];
  const points:    string[] = recording.summary ? JSON.parse(recording.summary.keyPoints)   : [];
  const decisions: string[] = recording.summary ? JSON.parse(recording.summary.decisions)   : [];

  const rawSegments: TranscriptSegment[] = recording.transcript?.segments
    ? JSON.parse(recording.transcript.segments as string)
    : [];
  const hasSpeakers = rawSegments.length > 0;
  const isComplete = recording.status === 'completed';
  const isFailed   = recording.status === 'failed';

  return (
    <div className="min-h-screen flex flex-col bg-surface">
      {/* Sticky header */}
      <header className="sticky top-0 z-20 border-b border-surface-border bg-surface/80 backdrop-blur-md">
        <div className="max-w-6xl mx-auto px-4 py-3 flex items-center gap-3">
          <Link
            href="/"
            className="flex items-center gap-1.5 text-sm font-medium text-ftc-mid hover:text-ftc-gray transition-colors p-2 -ml-2 rounded-xl touch-manipulation flex-shrink-0"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" d="M15 19l-7-7 7-7" />
            </svg>
            Back
          </Link>

          {/* Breadcrumb */}
          <div className="hidden sm:flex items-center gap-1.5 text-xs text-surface-muted">
            <span>Recordings</span>
            <span>/</span>
          </div>

          <div className="flex-1 min-w-0">
            <EditableTitle id={recording.id} initial={recording.title} />
            <p className="text-xs text-ftc-mid truncate hidden sm:block">{formatDate(recording.createdAt)}</p>
          </div>

          <span className={`text-xs px-2.5 py-1 rounded-full font-medium flex-shrink-0 ${
            isComplete ? 'bg-emerald-500/10 text-emerald-400'
            : isFailed  ? 'bg-red-500/10 text-red-400'
            : 'bg-amber-500/10 text-amber-400'
          }`}>
            {recording.status}
          </span>

          {/* Delete — tucked in header, requires 2 clicks */}
          <DeleteButton id={recording.id} />
        </div>
      </header>

      <main className="max-w-6xl mx-auto w-full px-4 py-6 flex-1">
        {/* Status banners */}
        {isFailed && (
          <div className="flex items-start gap-3 rounded-2xl border border-red-500/20 bg-red-500/5 p-4 mb-4 text-red-300 text-sm">
            <svg className="w-4 h-4 mt-0.5 flex-shrink-0" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
              <circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/>
            </svg>
            <span>Processing failed — likely an API key issue. Delete this recording and try again once the API key is fixed.</span>
          </div>
        )}
        {!isComplete && !isFailed && (
          <div className="flex items-center gap-3 rounded-2xl border border-amber-500/20 bg-amber-500/5 p-4 mb-4 text-amber-300 text-sm">
            <div className="w-4 h-4 rounded-full border-2 border-amber-400/30 border-t-amber-400 animate-spin flex-shrink-0" />
            Still processing — refresh in a moment to see your transcript and summary.
          </div>
        )}

        {/* Three-column grid: Chat | AI Notes | Transcript */}
        <div className="detail-grid">

          {/* ── LEFT: Chat ── */}
          <div className="chat-panel-col space-y-3">
            <p className="text-xs font-semibold uppercase tracking-widest text-ftc-mid flex items-center gap-2">
              <svg className="w-3.5 h-3.5 text-brand" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z" />
              </svg>
              Ask About This Meeting
            </p>
            <ChatPanel recordingId={recording.id} />
          </div>

          {/* ── MIDDLE: AI Notes ── */}
          <div className="space-y-4">
            <p className="text-xs font-semibold uppercase tracking-widest text-ftc-mid flex items-center gap-2">
              <svg className="w-3.5 h-3.5 text-brand" fill="currentColor" viewBox="0 0 24 24">
                <path d="M12 2a10 10 0 1 0 0 20A10 10 0 0 0 12 2zm-1 5h2v6h-2zm0 8h2v2h-2z"/>
              </svg>
              AI Notes
            </p>

            {recording.summary ? (
              <>
                <SectionCard title="Summary">
                  <p className="text-sm text-ftc-gray leading-7">{recording.summary.overview}</p>
                </SectionCard>

                {actions.length > 0 && (
                  <SectionCard title="Action Items">
                    <ul className="space-y-3">
                      {actions.map((item, i) => (
                        <li key={i} className="flex items-start gap-3">
                          <span className="mt-0.5 w-5 h-5 rounded border border-surface-muted flex items-center justify-center text-xs text-ftc-mid flex-shrink-0">
                            {i + 1}
                          </span>
                          <span className="text-sm text-ftc-gray leading-relaxed">{item}</span>
                        </li>
                      ))}
                    </ul>
                  </SectionCard>
                )}

                {points.length > 0 && (
                  <SectionCard title="Key Points">
                    <ul className="space-y-2.5">
                      {points.map((p, i) => (
                        <li key={i} className="flex items-start gap-2.5">
                          <span className="mt-2 w-1.5 h-1.5 rounded-full bg-brand flex-shrink-0" />
                          <span className="text-sm text-ftc-gray leading-relaxed">{p}</span>
                        </li>
                      ))}
                    </ul>
                  </SectionCard>
                )}

                {decisions.length > 0 && decisions[0] !== 'None' && (
                  <SectionCard title="Decisions">
                    <ul className="space-y-2.5">
                      {decisions.map((d, i) => (
                        <li key={i} className="flex items-start gap-2.5">
                          <svg className="w-4 h-4 mt-0.5 text-emerald-500 flex-shrink-0" fill="none" stroke="currentColor" strokeWidth={2.5} viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                          </svg>
                          <span className="text-sm text-ftc-gray leading-relaxed">{d}</span>
                        </li>
                      ))}
                    </ul>
                  </SectionCard>
                )}
              </>
            ) : isComplete ? (
              <div className="rounded-2xl border border-surface-border bg-surface-card p-8 text-center text-ftc-mid text-sm">
                No AI notes generated for this recording.
              </div>
            ) : null}

          </div>

          {/* ── RIGHT: Transcript ── */}
          <div className="transcript-panel">
            <p className="text-xs font-semibold uppercase tracking-widest text-ftc-mid flex items-center gap-2 mb-4">
              <svg className="w-3.5 h-3.5 text-brand" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
              </svg>
              Transcript
            </p>

            {recording.transcript ? (
              <div className="rounded-2xl border border-surface-border bg-surface-card p-5 space-y-4">
                {hasSpeakers ? (
                  rawSegments.map((seg, i) => (
                    <SpeakerBlock key={i} seg={seg} />
                  ))
                ) : (
                  <p className="text-sm text-ftc-gray leading-8 whitespace-pre-wrap">
                    {recording.transcript.fullText}
                  </p>
                )}
              </div>
            ) : (
              <div className="rounded-2xl border border-surface-border bg-surface-card p-8 text-center text-ftc-mid text-sm">
                {isComplete ? 'No transcript available.' : 'Transcript will appear here once processing is complete.'}
              </div>
            )}
          </div>

        </div>
      </main>
    </div>
  );
}
