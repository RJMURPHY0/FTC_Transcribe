import Link from 'next/link';
import { notFound } from 'next/navigation';
import { prisma } from '@/lib/db';
import { estimateSeconds } from '@/lib/estimate';
import DeleteButton from './DeleteButton';
import RetryButton from './RetryButton';
import ProcessingPoller from './ProcessingPoller';
import EditableTitle from './EditableTitle';
import ChatPanel from './ChatPanel';
import EditableAINotes from './EditableAINotes';
import { ActionItemsProvider } from './ActionItemsContext';
import SpeakerPanel from './SpeakerPanel';
import TranscriptPlayer from './TranscriptPlayer';
import ResizableColumns from './ResizableColumns';
import type { TranscriptSegment, TopicSection } from '@/lib/ai';
import { ensureSchema } from '@/lib/ensure-schema';
import { getAuthUser } from '@/lib/auth';

export const dynamic = 'force-dynamic';

const MEETING_TYPE_LABELS: Record<string, string> = {
  general: '💬 General', standup: '🗓 Standup', sales: '📈 Sales',
  interview: '🎯 Interview', review: '📋 Review',
};

function formatDate(date: Date) {
  return new Intl.DateTimeFormat('en-GB', {
    weekday: 'short', day: 'numeric', month: 'long',
    year: 'numeric', hour: '2-digit', minute: '2-digit',
  }).format(new Date(date));
}



export default async function RecordingPage({ params }: { params: { id: string } }) {
  await ensureSchema();
  const [recording, authUser] = await Promise.all([
    prisma.recording
      .findUnique({ where: { id: params.id }, include: { transcript: true, summary: true, _count: { select: { chunks: true } } } })
      .catch(() => null),
    getAuthUser().catch(() => null),
  ]);

  if (!recording || recording.deletedAt) notFound();

  function safeJson<T>(value: string | null | undefined, fallback: T): T {
    if (!value) return fallback;
    try {
      const parsed = JSON.parse(value) as unknown;
      return (parsed !== null && parsed !== undefined) ? (parsed as T) : fallback;
    } catch { return fallback; }
  }

  const actions:         string[]       = recording.summary ? safeJson<string[]>(recording.summary.actionItems,         []) : [];
  const points:          string[]       = recording.summary ? safeJson<string[]>(recording.summary.keyPoints,           []) : [];
  const decisions:       string[]       = recording.summary ? safeJson<string[]>(recording.summary.decisions,           []) : [];
  const topics:          TopicSection[] = recording.summary ? safeJson<TopicSection[]>(recording.summary.topics,        []) : [];
  const checkedIndices:  number[]       = recording.summary ? safeJson<number[]>((recording.summary as Record<string, unknown>).actionItemsChecked as string, []) : [];
  const actionDue:       (string|null)[]= recording.summary ? safeJson<(string|null)[]>((recording.summary as Record<string, unknown>).actionItemsDue as string, []) : [];

  const rawSegmentsParsed = safeJson<TranscriptSegment[]>(
    recording.transcript?.segments as string | undefined,
    [],
  );
  const rawSegments: TranscriptSegment[] = Array.isArray(rawSegmentsParsed) ? rawSegmentsParsed : [];

  // Unique speakers in order of first appearance — used for stable colour assignment.
  // Force to string: Deepgram stores speaker as number (0,1,2…) which breaks Object.fromEntries in Safari.
  const speakerOrder = Array.from(new Set(rawSegments.map(s => String(s.speaker))));

  const hasSpeakers = rawSegments.length > 0;
  const isComplete   = recording.status === 'completed';
  const isFailed     = recording.status === 'failed';
  const isUploading  = recording.status === 'uploading' || recording.status === 'queued';
  const isProcessing = recording.status === 'processing';

  const etaSecs = (isUploading || isProcessing) ? estimateSeconds(recording._count.chunks) : 0;
  const etaLabel = etaSecs > 0
    ? (etaSecs < 60 ? 'less than a minute' : `about ${Math.ceil(etaSecs / 60)} min`)
    : null;

  return (
    <div className="min-h-screen flex flex-col bg-surface">
      {/* Sticky header */}
      <header className="sticky top-0 z-20 border-b border-surface-border bg-surface/80 backdrop-blur-md">
        <div className="max-w-[1800px] mx-auto px-4 py-3 flex items-center gap-3">
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
            <div className="flex items-center gap-2">
            <p className="text-xs text-ftc-mid truncate hidden sm:block">{formatDate(recording.createdAt)}</p>
            {recording.meetingType && recording.meetingType !== 'general' && (
              <span className="hidden sm:inline text-xs px-2 py-0.5 rounded-full bg-surface-raised border border-surface-border text-ftc-mid">
                {MEETING_TYPE_LABELS[recording.meetingType] ?? recording.meetingType}
              </span>
            )}
          </div>
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

      <main className="max-w-[1800px] mx-auto w-full px-4 py-6 flex-1">
        {/* Auto-retry + auto-refresh when queued or processing */}
        {(isUploading || isProcessing) && <ProcessingPoller id={recording.id} />}

        {/* Status banners */}
        {isFailed && (
          <div className="flex items-start gap-3 rounded-2xl border border-red-500/20 bg-red-500/5 p-4 mb-4 text-red-300 text-sm">
            <svg className="w-4 h-4 mt-0.5 flex-shrink-0" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
              <circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/>
            </svg>
            <div className="flex-1 space-y-3">
              <span>Analysis failed — you can retry below. If it keeps failing, check your API keys in Settings.</span>
              <RetryButton id={recording.id} />
            </div>
          </div>
        )}
        {isUploading && (
          <div className="flex items-start gap-3 rounded-2xl border border-blue-500/20 bg-blue-500/5 p-4 mb-4 text-blue-300 text-sm">
            <div className="w-4 h-4 rounded-full border-2 border-blue-400/30 border-t-blue-400 animate-spin flex-shrink-0 mt-0.5" />
            <div className="flex-1 space-y-3">
              <span>
                Queued for transcription — this page updates automatically. You can leave and come back.
                {etaLabel && <span className="ml-1 text-blue-400/70">Est. {etaLabel}.</span>}
              </span>
              <RetryButton id={recording.id} />
            </div>
          </div>
        )}
        {isProcessing && (
          <div className="flex items-center gap-3 rounded-2xl border border-amber-500/20 bg-amber-500/5 p-4 mb-4 text-amber-300 text-sm">
            <div className="w-4 h-4 rounded-full border-2 border-amber-400/30 border-t-amber-400 animate-spin flex-shrink-0" />
            <div className="flex-1">
              Transcript is on its way — speaker labels and notes will follow shortly.
              {etaLabel && <span className="ml-1 text-amber-400/70">Est. {etaLabel}.</span>}
            </div>
          </div>
        )}

        {/* Three-column grid: Chat | AI Notes | Transcript */}
        <ActionItemsProvider
          recordingId={recording.id}
          initialItems={actions}
          initialDue={actionDue}
          initialChecked={checkedIndices}
        >
        <ResizableColumns
          userId={authUser?.id ?? null}
          chat={
            /* ── LEFT: Chat ── */
            <div className="chat-panel-col space-y-3">
              <p className="text-xs font-semibold uppercase tracking-widest text-ftc-mid flex items-center gap-2">
                <svg className="w-3.5 h-3.5 text-brand" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z" />
                </svg>
                Ask About This Meeting
              </p>
              <ChatPanel recordingId={recording.id} />
            </div>
          }
          notes={
            /* ── MIDDLE: AI Notes ── */
            <div>
              {recording.summary ? (
                <EditableAINotes
                  recordingId={recording.id}
                  recordingTitle={recording.title}
                  initialSummary={{
                    overview:    recording.summary.overview,
                    keyPoints:   points,
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
          }
          transcript={
            /* ── RIGHT: Transcript ── */
            <div className="transcript-panel">
              <p className="text-xs font-semibold uppercase tracking-widest text-ftc-mid flex items-center gap-2 mb-4">
                <svg className="w-3.5 h-3.5 text-brand" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                </svg>
                Transcript
              </p>

              {recording.transcript ? (
                <>
                  {hasSpeakers && (
                    <SpeakerPanel recordingId={recording.id} speakers={speakerOrder} />
                  )}
                  {hasSpeakers ? (
                    <TranscriptPlayer
                      recordingId={recording.id}
                      rawSegments={rawSegments}
                      speakerOrder={speakerOrder}
                      hasAudio={recording._count.chunks > 0}
                    />
                  ) : (
                    <div className="rounded-2xl border border-surface-border bg-surface-card p-5">
                      <p className="text-sm text-ftc-gray leading-8 whitespace-pre-wrap">
                        {recording.transcript.fullText}
                      </p>
                    </div>
                  )}
                </>
              ) : (
                <div className="rounded-2xl border border-surface-border bg-surface-card p-8 text-center text-ftc-mid text-sm">
                  {isComplete ? 'No transcript available.' : 'Transcript will appear here once processing is complete.'}
                </div>
              )}
            </div>
          }
        />
        </ActionItemsProvider>
      </main>
    </div>
  );
}
