import Link from 'next/link';
import { notFound } from 'next/navigation';
import { prisma } from '@/lib/db';
import DeleteButton from './DeleteButton';
import RetryButton from './RetryButton';
import EditableTitle from './EditableTitle';
import ChatPanel from './ChatPanel';
import EditableAINotes from './EditableAINotes';
import type { TranscriptSegment, TopicSection } from '@/lib/ai';

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


export default async function RecordingPage({ params }: { params: { id: string } }) {
  const recording = await prisma.recording
    .findUnique({ where: { id: params.id }, include: { transcript: true, summary: true } })
    .catch(() => null);

  if (!recording) notFound();

  const actions:   string[]       = recording.summary ? JSON.parse(recording.summary.actionItems) : [];
  const points:    string[]       = recording.summary ? JSON.parse(recording.summary.keyPoints)   : [];
  const decisions: string[]       = recording.summary ? JSON.parse(recording.summary.decisions)   : [];
  const topics:    TopicSection[] = recording.summary ? JSON.parse(recording.summary.topics ?? '[]') : [];

  const rawSegments: TranscriptSegment[] = recording.transcript?.segments
    ? JSON.parse(recording.transcript.segments as string)
    : [];
  const hasSpeakers = rawSegments.length > 0;
  const isComplete   = recording.status === 'completed';
  const isFailed     = recording.status === 'failed';
  const isUploading  = recording.status === 'uploading' || recording.status === 'queued';
  const isProcessing = recording.status === 'processing';

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
            <span className="hidden sm:inline">Back</span>
          </Link>

          {/* Breadcrumb */}
          <div className="hidden sm:flex items-center gap-1.5 text-xs text-surface-muted">
            <span>Recordings</span>
            <span>/</span>
          </div>

          <div className="flex-1 min-w-0 pr-1">
            <EditableTitle id={recording.id} initial={recording.title} />
            <p className="text-xs text-ftc-mid truncate hidden sm:block">{formatDate(recording.createdAt)}</p>
          </div>

          <span className={`text-xs px-2.5 py-1 rounded-full font-medium flex-shrink-0 whitespace-nowrap ${
            isComplete   ? 'bg-emerald-500/10 text-emerald-400'
            : isFailed   ? 'bg-red-500/10 text-red-400'
            : isUploading ? 'bg-blue-500/10 text-blue-400'
            : 'bg-amber-500/10 text-amber-400'
          }`}>
            {isUploading ? 'queued' : recording.status === 'processing' ? 'analysing' : recording.status}
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
            <div className="flex-1 space-y-3">
              <span>Analysis failed — you can retry below. If it keeps failing, check your API keys.</span>
              <RetryButton id={recording.id} />
            </div>
          </div>
        )}
        {isUploading && (
          <div className="flex items-center gap-3 rounded-2xl border border-blue-500/20 bg-blue-500/5 p-4 mb-4 text-blue-300 text-sm">
            <div className="w-4 h-4 rounded-full border-2 border-blue-400/30 border-t-blue-400 animate-spin flex-shrink-0" />
            <div className="flex-1">
              Your recording is queued for transcription. This page will update automatically — no need to stay here.
            </div>
          </div>
        )}
        {isProcessing && (
          <div className="flex items-center gap-3 rounded-2xl border border-amber-500/20 bg-amber-500/5 p-4 mb-4 text-amber-300 text-sm">
            <div className="w-4 h-4 rounded-full border-2 border-amber-400/30 border-t-amber-400 animate-spin flex-shrink-0" />
            <div className="flex-1">
              Analysing your recording — this may take a minute or two for long meetings. Refresh to check progress.
            </div>
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
          <div>
            {recording.summary ? (
              <EditableAINotes
                recordingId={recording.id}
                recordingTitle={recording.title}
                initialSummary={{
                  overview:    recording.summary.overview,
                  keyPoints:   points,
                  actionItems: actions,
                  decisions,
                  topics,
                }}
              />
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
