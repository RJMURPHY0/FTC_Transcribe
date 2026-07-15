import { randomUUID } from 'crypto';
import { prisma } from '@/lib/db';
import {
  diarizeSegments,
  identifySpeakerNames,
  analyzeTranscript,
  generateTitle,
  generateTopics,
} from '@/lib/ai';
import type { RawSegment, MeetingType } from '@/lib/ai';
import { ensureSchema } from '@/lib/ensure-schema';
import { backupToAirtable } from '@/lib/airtable-backup';
import { notifyTeamsChannel } from '@/lib/integrations/teams-notify';
import { indexTranscript } from '@/lib/embeddings';
import { alignSpeakersAcrossChunks } from '@/lib/deepgram';
import type { DeepgramRawSegment } from '@/lib/deepgram';
import { resolveGlobalSpeakers, matchProfiles, cosineSim } from '@/lib/voice-id';
import type { ChunkForAlignment, ChunkVoiceData } from '@/lib/voice-id';
import {
  transcribeChunk,
  transcribeChunkWithRetry,
  transcribeChunkWithDeepgramRetry,
  withTempFile,
  MAX_CHUNK_ATTEMPTS,
} from '@/lib/transcribe-chunk';

// Must exceed the longest analysis phase (maxDuration is 800s) — a lock that
// lapses mid-analysis lets the poller/cron start a SECOND concurrent analysis,
// which double-posted notes to Teams/Airtable.
const LOCK_MS = 15 * 60 * 1000;
const PARALLEL_CHUNKS = 5;
// Safety cap: chunks are pre-transcribed in background so finalize normally skips them.
// This limit only matters if background transcription failed for many chunks.
const MAX_CHUNKS_PER_RUN = 100;

// Estimated processing time in seconds shown on the home-page list.
// Chunks are pre-transcribed as they upload; finalize only needs AI analysis (~45s).
// Small per-chunk buffer covers the rare case where background transcription didn't finish.
export function estimateSeconds(chunkCount: number): number {
  return 45 + Math.min(chunkCount * 3, 30);
}

async function runConcurrent<T>(tasks: (() => Promise<T>)[], limit: number): Promise<T[]> {
  const results: (T | undefined)[] = new Array(tasks.length);
  let idx = 0;
  async function worker() {
    while (idx < tasks.length) {
      const i = idx++;
      results[i] = await tasks[i]();
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, tasks.length) }, worker));
  return results as T[];
}

type FinalizeResult =
  | { ok: true; completed: true; failedChunks: 0; pendingChunks: 0 }
  | { ok: true; completed: false; failedChunks: number; pendingChunks: number; reason: string }
  | { ok: false; reason: string };

function isMissingFinalizeTablesError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return (
    message.includes('FinalizeJob')
    || message.includes('ChunkTranscript')
    || message.includes('relation "FinalizeJob" does not exist')
    || message.includes('relation "ChunkTranscript" does not exist')
  );
}


// Self-introduction learning: when the LLM confidently maps a generic speaker
// to a real name ("Hi, I'm Dave" → Speaker 2 = Dave) AND we have that speaker's
// acoustic voiceprint for this recording, save it as an auto voice profile so
// future meetings recognise them without any manual enrollment. The user can
// refine it later in Settings → Voice Profiles.
async function autoLearnVoiceProfiles(
  recordingId: string,
  speakerNames: Record<string, string>,
  userId: string | null,
): Promise<void> {
  const namedGenerics = Object.entries(speakerNames).filter(
    ([label, name]) => /^Speaker \d+$/.test(label) && name && !/^Speaker \d+$/i.test(name),
  );
  if (!namedGenerics.length) return;

  try {
    const embeddings = await prisma.speakerEmbedding.findMany({ where: { recordingId } });
    if (!embeddings.length) return; // no acoustic data (legacy / mobile / voice-id-off path)

    for (const [label, name] of namedGenerics) {
      const row = embeddings.find(e => e.speakerLabel === label);
      if (!row) continue;

      let emb: number[];
      try { emb = JSON.parse(row.embedding) as number[]; } catch { continue; }

      // Skip if we already have a near-identical sample for this person
      const existing = await prisma.voiceProfile.findMany({
        where: { personName: name },
        select: { embedding: true },
      });
      const duplicate = existing.some(p => {
        try { return cosineSim(emb, JSON.parse(p.embedding) as number[]) > 0.95; }
        catch { return false; }
      });

      if (!duplicate) {
        await prisma.voiceProfile.create({
          data: { userId, personName: name, embedding: row.embedding, durationS: row.durationS, source: 'auto' },
        });
      }
      // Keep the stored voiceprint label in sync with the resolved name
      await prisma.speakerEmbedding.update({ where: { id: row.id }, data: { speakerLabel: name } });
    }
  } catch (err) {
    console.warn('[finalize] auto voice-profile learn failed:', err);
  }
}

async function analyzeAndCompleteRecording(recordingId: string): Promise<FinalizeResult> {
  await ensureSchema(); // self-heal: make sure new Summary columns exist before writing
  const [transcript, recording, existingSummary] = await Promise.all([
    prisma.transcript.findUnique({ where: { recordingId } }),
    prisma.recording.findUnique({ where: { id: recordingId }, select: { meetingType: true, createdAt: true, status: true, userId: true } }),
    prisma.summary.findUnique({ where: { recordingId }, select: { id: true } }),
  ]);

  // Idempotency: a completed recording with a summary never re-analyses.
  // Late chunk retries, poller re-triggers, and cron re-claims all land here.
  if (recording?.status === 'completed' && existingSummary) {
    return { ok: true, completed: true, failedChunks: 0, pendingChunks: 0 };
  }

  if (!transcript || !transcript.fullText.trim()) {
    await prisma.recording.update({ where: { id: recordingId }, data: { status: 'failed' } }).catch(() => {});
    return { ok: false, reason: 'No transcript to analyse.' };
  }

  const meetingType = (recording?.meetingType ?? 'general') as MeetingType;

  let rawSegments: Array<RawSegment & { speaker?: string }> = [];
  try {
    const parsed = JSON.parse(transcript.segments);
    if (Array.isArray(parsed)) rawSegments = parsed;
  } catch {
    // Malformed segments — proceed with empty array; diarization will be skipped
  }

  // Run analysis/title/topics in parallel with diarization, then resolve names
  const [diarizedRaw, analysis, shortTitle, topics] = await Promise.all([
    diarizeSegments(rawSegments),
    analyzeTranscript(transcript.fullText, meetingType, recording?.createdAt ?? new Date()),
    generateTitle(transcript.fullText),
    generateTopics(rawSegments),
  ]);

  // Replace speaker labels with real names where confident. Only generic
  // "Speaker N" labels are eligible — names already assigned by voice ID
  // (or a previous manual rename) are never overwritten by the LLM guess.
  const speakerNames = await identifySpeakerNames(diarizedRaw);
  const isGeneric = (label: string) => /^Speaker \d+$/.test(label);
  const diarized = Object.keys(speakerNames).length > 0
    ? diarizedRaw.map(seg => ({
        ...seg,
        speaker: isGeneric(seg.speaker) ? (speakerNames[seg.speaker] ?? seg.speaker) : seg.speaker,
      }))
    : diarizedRaw;

  // Turn confident self-introductions into reusable voice profiles
  await autoLearnVoiceProfiles(recordingId, speakerNames, recording?.userId ?? null);

  const dateStr = new Date().toLocaleDateString('en-GB', {
    day: 'numeric', month: 'short', year: 'numeric',
  });
  const title = shortTitle ? `${shortTitle} - ${dateStr}` : null;

  await prisma.transcript.update({
    where: { recordingId },
    data: { segments: JSON.stringify(diarized) },
  });

  // B2: Don't persist empty or mock-mode analysis — mark failed so the recording can be retried
  if (
    !analysis.overview.trim() ||
    analysis.overview.startsWith('Demo summary') ||
    analysis.overview.startsWith('Analysis could not be completed')
  ) {
    await prisma.recording.update({ where: { id: recordingId }, data: { status: 'failed' } }).catch(() => {});
    return { ok: false, reason: 'AI analysis returned empty or mock content — check ANTHROPIC_API_KEY.' };
  }

  // B3: Wrap summary upsert + status update atomically so a mid-flight crash
  // can't leave the recording stuck in 'processing' with no summary.
  const completedRecording = await prisma.$transaction(async (tx) => {
    await tx.summary.upsert({
      where: { recordingId },
      create: {
        recordingId,
        overview: analysis.overview,
        keyPoints: JSON.stringify(analysis.keyPoints),
        actionItems: JSON.stringify(analysis.actionItems),
        actionItemsDue: JSON.stringify(analysis.actionItemsDue),
        decisions: JSON.stringify(analysis.decisions),
        topics: JSON.stringify(topics),
      },
      update: {
        overview: analysis.overview,
        keyPoints: JSON.stringify(analysis.keyPoints),
        actionItems: JSON.stringify(analysis.actionItems),
        actionItemsDue: JSON.stringify(analysis.actionItemsDue),
        decisions: JSON.stringify(analysis.decisions),
        topics: JSON.stringify(topics),
      },
    });
    return tx.recording.update({
      where: { id: recordingId },
      data: { status: 'completed', ...(title ? { title } : {}) },
    });
  });

  // Fire-and-forget side effects, each claimed atomically so concurrent runs
  // (or later re-analyses) can never post the same notes twice.
  const airtableClaim = await prisma.recording.updateMany({
    where: { id: recordingId, airtableBackedUpAt: null },
    data: { airtableBackedUpAt: new Date() },
  }).catch(() => ({ count: 0 }));
  if (airtableClaim.count === 1) {
    backupToAirtable({
      recordingId,
      title:       completedRecording.title,
      createdAt:   completedRecording.createdAt,
      status:      'completed',
      overview:    analysis.overview,
      keyPoints:   analysis.keyPoints,
      actionItems: analysis.actionItems,
      decisions:   analysis.decisions,
      fullText:    transcript.fullText,
    }).catch((err) => console.error('[finalize] airtable backup failed:', err));
  }

  // Fire-and-forget semantic indexing for search (upsert-safe, no claim needed)
  indexTranscript(recordingId, completedRecording.userId ?? null, transcript.fullText)
    .catch(err => console.error('[finalize] embedding index failed:', err));

  const teamsClaim = await prisma.recording.updateMany({
    where: { id: recordingId, teamsNotifiedAt: null },
    data: { teamsNotifiedAt: new Date() },
  }).catch(() => ({ count: 0 }));
  if (teamsClaim.count === 1) {
    notifyTeamsChannel({
      recordingId,
      title:       completedRecording.title,
      createdAt:   completedRecording.createdAt,
      overview:    analysis.overview,
      keyPoints:   analysis.keyPoints,
      actionItems: analysis.actionItems,
      decisions:   analysis.decisions,
      durationSec: completedRecording.duration,
    }).catch((err) => console.error('[finalize] teams notify failed:', err));
  }

  return { ok: true, completed: true, failedChunks: 0, pendingChunks: 0 };
}

async function finalizeLegacy(recordingId: string): Promise<FinalizeResult> {
  await prisma.recording.update({ where: { id: recordingId }, data: { status: 'processing' } }).catch(() => {});

  // Load metadata only — audioData is fetched one chunk at a time below to avoid
  // loading the entire recording (~60+ MB for a long meeting) into memory at once.
  const chunkMetas = await prisma.chunkBlob.findMany({
    where: { recordingId },
    orderBy: { offset: 'asc' },
    select: { id: true, offset: true, mimeType: true },
  });

  let failedChunks = 0;

  if (chunkMetas.length > 0) {
    let fullText = '';
    const allSegments: RawSegment[] = [];

    for (const chunkMeta of chunkMetas) {
      const ext = chunkMeta.mimeType.includes('mp4') ? '.mp4'
        : chunkMeta.mimeType.includes('ogg') ? '.ogg'
        : '.webm';

      try {
        const chunkData = await prisma.chunkBlob.findUniqueOrThrow({
          where: { id: chunkMeta.id },
          select: { audioData: true },
        });
        const { text, rawSegments } = await transcribeChunkWithRetry(chunkData.audioData as Buffer, ext);
        if (text.trim()) {
          fullText += (fullText ? ' ' : '') + text.trim();
        }

        const shifted = rawSegments.map((s) => ({
          start: s.start + chunkMeta.offset,
          end: s.end + chunkMeta.offset,
          text: s.text,
        }));
        allSegments.push(...shifted);
      } catch (err) {
        failedChunks += 1;
        console.error(`[finalize] chunk ${chunkMeta.id} failed after retries:`, err);
      }
    }

    if (fullText.trim()) {
      await prisma.transcript.upsert({
        where: { recordingId },
        create: {
          recordingId,
          fullText,
          segments: JSON.stringify(allSegments),
        },
        update: {
          fullText,
          segments: JSON.stringify(allSegments),
        },
      });
    }

    if (failedChunks === 0) {
      await prisma.chunkBlob.deleteMany({ where: { recordingId } });
    } else {
      await prisma.recording.update({ where: { id: recordingId }, data: { status: 'failed' } }).catch(() => {});
      return {
        ok: true,
        completed: false,
        failedChunks,
        pendingChunks: 0,
        reason: 'Some chunks failed. Audio was preserved so retry can continue.',
      };
    }
  }

  return analyzeAndCompleteRecording(recordingId);
}

async function acquireJobLock(recordingId: string): Promise<{ id: string; token: string } | null> {
  const token = randomUUID();
  const lockUntil = new Date(Date.now() + LOCK_MS);

  const job = await prisma.finalizeJob.upsert({
    where: { recordingId },
    create: { recordingId, status: 'pending' },
    update: {},
    select: { id: true },
  });

  const claim = await prisma.finalizeJob.updateMany({
    where: {
      id: job.id,
      status: { not: 'completed' },
      OR: [{ lockUntil: null }, { lockUntil: { lt: new Date() } }],
    },
    data: {
      lockToken: token,
      lockUntil,
      status: 'running',
      attempts: { increment: 1 },
      lastError: '',
    },
  });

  if (claim.count === 0) return null;
  await prisma.recording.update({ where: { id: recordingId }, data: { status: 'processing' } }).catch(() => {});
  return { id: job.id, token };
}

async function refreshJobLock(jobId: string, token: string): Promise<void> {
  await prisma.finalizeJob.updateMany({
    where: { id: jobId, lockToken: token },
    data: { lockUntil: new Date(Date.now() + LOCK_MS) },
  });
}

async function releaseJobLock(jobId: string, token: string): Promise<void> {
  await prisma.finalizeJob.updateMany({
    where: { id: jobId, lockToken: token },
    data: { lockToken: null, lockUntil: null },
  });
}

async function finalizeWithJobs(recordingId: string): Promise<FinalizeResult> {
  const lock = await acquireJobLock(recordingId);
  if (!lock) {
    return { ok: true, completed: false, failedChunks: 0, pendingChunks: 0, reason: 'already-processing' };
  }

  try {
    // Fetch metadata only (no audioData) to avoid loading gigabytes into memory for long meetings
    const allChunkMeta = await prisma.chunkBlob.findMany({
      where: { recordingId },
      orderBy: [{ offset: 'asc' }, { createdAt: 'asc' }],
      select: { id: true, offset: true, mimeType: true },
    });

    // Find chunks already successfully transcribed in a previous invocation
    const doneIds = new Set(
      (await prisma.chunkTranscript.findMany({
        where: { jobId: lock.id, status: 'succeeded' },
        select: { chunkId: true },
      })).map(r => r.chunkId),
    );

    const remaining = allChunkMeta.filter(c => !doneIds.has(c.id));
    const thisBatch = remaining.slice(0, MAX_CHUNKS_PER_RUN);
    const moreAfterThis = remaining.length > thisBatch.length;

    await runConcurrent(
      thisBatch.map((chunkMeta) => async () => {
        try {
          await refreshJobLock(lock.id, lock.token);

          await prisma.chunkTranscript.upsert({
            where: { jobId_chunkId: { jobId: lock.id, chunkId: chunkMeta.id } },
            create: { jobId: lock.id, recordingId, chunkId: chunkMeta.id, offset: chunkMeta.offset, status: 'processing', attempts: 1 },
            update: { status: 'processing', attempts: { increment: 1 }, lastError: '' },
          });

          try {
            // Load audio data only when needed — one chunk at a time, not the entire recording
            const blob = await prisma.chunkBlob.findUniqueOrThrow({
              where: { id: chunkMeta.id },
              select: { audioData: true },
            });

            // Chunks smaller than 1 KB contain no real audio (e.g. WebM cluster headers from
            // browsers that fail to capture after a recorder restart). Skip transcription.
            if ((blob.audioData as Buffer).length < 1000) {
              await prisma.chunkTranscript.update({
                where: { jobId_chunkId: { jobId: lock.id, chunkId: chunkMeta.id } },
                data: { status: 'succeeded', transcript: '', segments: '[]', processedAt: new Date(), lastError: '' },
              });
              return;
            }

            const { text: chunkText, segments: chunkSegments, voiceData: chunkVoice } = await transcribeChunk(
              blob.audioData as Buffer,
              chunkMeta.mimeType,
            );

            await prisma.chunkTranscript.update({
              where: { jobId_chunkId: { jobId: lock.id, chunkId: chunkMeta.id } },
              data: { status: 'succeeded', transcript: chunkText.trim(), segments: JSON.stringify(chunkSegments), voiceData: chunkVoice ? JSON.stringify(chunkVoice) : '', processedAt: new Date(), lastError: '' },
            });
          } catch (err) {
            const msg = err instanceof Error ? err.message : 'Chunk transcription failed';
            await prisma.chunkTranscript.update({
              where: { jobId_chunkId: { jobId: lock.id, chunkId: chunkMeta.id } },
              data: { status: 'failed', lastError: msg.slice(0, 500), processedAt: null },
            }).catch(() => {});
          }
        } catch (outerErr) {
          console.error(`[finalize] chunk ${chunkMeta.id} task error:`, outerErr);
        }
      }),
      PARALLEL_CHUNKS,
    );

    // If there are more chunks left (rare with background transcription), let the next cron run continue.
    if (moreAfterThis) {
      const processed = doneIds.size + thisBatch.length;
      const stillLeft  = allChunkMeta.length - processed;
      return { ok: true, completed: false, failedChunks: 0, pendingChunks: stillLeft, reason: 'partial-progress' };
    }

    // ── All chunks have been attempted ─────────────────────────────────────────
    const [failedChunks, pendingChunks, rows] = await Promise.all([
      prisma.chunkTranscript.count({ where: { jobId: lock.id, status: 'failed' } }),
      prisma.chunkTranscript.count({ where: { jobId: lock.id, status: { in: ['pending', 'processing'] } } }),
      prisma.chunkTranscript.findMany({
        where: { jobId: lock.id, status: 'succeeded' },
        orderBy: [{ offset: 'asc' }, { createdAt: 'asc' }],
      }),
    ]);

    let fullText = '';
    const allSegments: Array<RawSegment & { speaker?: string }> = [];
    const deepgramChunkData: Array<{ segments: DeepgramRawSegment[]; offset: number }> = [];
    let hasDeepgramChunks = false;
    const voiceChunks: ChunkForAlignment[] = [];

    for (const row of rows) {
      if (row.transcript.trim()) fullText += (fullText ? ' ' : '') + row.transcript.trim();
      try {
        const parsed = JSON.parse(row.segments) as Array<{ start: number; end: number; text: string; speaker?: number | string }>;
        let voiceData: ChunkVoiceData | null = null;
        try {
          if (row.voiceData) voiceData = JSON.parse(row.voiceData) as ChunkVoiceData;
        } catch { /* treat as no voice data */ }
        voiceChunks.push({ offset: row.offset, segments: parsed, voiceData });

        if (parsed.length > 0 && typeof parsed[0].speaker === 'number') {
          hasDeepgramChunks = true;
          deepgramChunkData.push({ segments: parsed as DeepgramRawSegment[], offset: row.offset });
        } else {
          allSegments.push(...parsed.map(s => ({ start: s.start + row.offset, end: s.end + row.offset, text: s.text })));
        }
      } catch { /* skip unparseable chunk */ }
    }

    // Acoustic speaker resolution: cluster per-chunk voiceprints into global
    // speakers, then match against enrolled voice profiles. When it succeeds it
    // replaces both the naive Deepgram cross-chunk alignment and (downstream)
    // the LLM text diarization.
    let voiceResolved = false;
    try {
      const resolved = resolveGlobalSpeakers(voiceChunks);
      if (resolved && resolved.segments.length > 0) {
        const profileRows = await prisma.voiceProfile.findMany({
          select: { personName: true, embedding: true },
        }).catch(() => [] as Array<{ personName: string; embedding: string }>);
        const profiles = profileRows
          .map((p) => {
            try { return { personName: p.personName, embedding: JSON.parse(p.embedding) as number[] }; }
            catch { return null; }
          })
          .filter((p): p is { personName: string; embedding: number[] } => !!p);

        const matches = matchProfiles(resolved.speakerEmbeddings, profiles);
        allSegments.length = 0;
        allSegments.push(...resolved.segments.map(s => ({
          ...s,
          speaker: matches[s.speaker] ?? s.speaker,
        })));

        // Persist per-speaker voiceprints for this recording (idempotent on re-run) —
        // used by the relearn loop when the user renames a speaker.
        await prisma.speakerEmbedding.deleteMany({ where: { recordingId } }).catch(() => {});
        await prisma.speakerEmbedding.createMany({
          data: resolved.speakerEmbeddings.map(se => ({
            recordingId,
            speakerLabel: matches[se.label] ?? se.label,
            embedding: JSON.stringify(se.embedding),
            durationS: se.durationS,
          })),
        }).catch(() => {});

        voiceResolved = true;
        const matched = Object.entries(matches).map(([l, n]) => `${l}→${n}`).join(', ');
        console.log(`[finalize] voice ID resolved ${resolved.speakerEmbeddings.length} speakers${matched ? ` (${matched})` : ''}`);
      }
    } catch (err) {
      console.warn('[finalize] voice speaker resolution failed, using fallback:', err);
    }

    if (!voiceResolved && hasDeepgramChunks) {
      const sorted = deepgramChunkData.sort((a, b) => a.offset - b.offset);
      allSegments.push(...alignSpeakersAcrossChunks(sorted));
    }

    if (fullText.trim()) {
      await prisma.transcript.upsert({
        where: { recordingId },
        create: { recordingId, fullText, segments: JSON.stringify(allSegments) },
        update: { fullText, segments: JSON.stringify(allSegments) },
      });
    }

    if (pendingChunks > 0) {
      // Background transcription (waitUntil) may still be running — don't mark failed, let next cron retry
      return { ok: true, completed: false, failedChunks, pendingChunks, reason: 'Chunks still pending — will retry next cron run.' };
    }

    if (failedChunks > 0) {
      await prisma.finalizeJob.update({ where: { id: lock.id }, data: { status: 'failed', lastError: `failed=${failedChunks}` } });
      await prisma.recording.update({ where: { id: recordingId }, data: { status: 'failed' } }).catch(() => {});
      return { ok: true, completed: false, failedChunks, pendingChunks: 0, reason: 'Some chunks failed and were kept for retry.' };
    }

    // Refresh lock before analysis — diarization + AI calls can take several minutes
    // and the last refreshJobLock was called during chunk processing above.
    await refreshJobLock(lock.id, lock.token);
    const completed = await analyzeAndCompleteRecording(recordingId);
    if (!completed.ok) {
      await prisma.finalizeJob.update({ where: { id: lock.id }, data: { status: 'failed', lastError: completed.reason } });
      return completed;
    }

    await prisma.finalizeJob.update({ where: { id: lock.id }, data: { status: 'completed', lastError: '' } });
    await prisma.chunkBlob.deleteMany({ where: { recordingId } });
    return completed;
  } finally {
    await releaseJobLock(lock.id, lock.token);
  }
}

export async function enqueueFinalizeJob(recordingId: string): Promise<string | null> {
  try {
    // Never resurrect a completed job — a late retried chunk used to reset it
    // to 'pending', triggering a full re-analysis and duplicate notes.
    const job = await prisma.finalizeJob.upsert({
      where: { recordingId },
      create: { recordingId, status: 'pending' },
      update: {},
      select: { id: true, status: true },
    });
    if (job.status === 'completed') return job.id;
    await prisma.finalizeJob.updateMany({
      where: { id: job.id, status: { not: 'completed' } },
      data: { status: 'pending', lastError: '' },
    });
    return job.id;
  } catch (err) {
    if (!isMissingFinalizeTablesError(err)) {
      console.warn('[finalize] enqueue warning:', err);
    }
    return null;
  }
}

export async function finalizeRecording(recordingId: string): Promise<FinalizeResult> {
  try {
    return await finalizeWithJobs(recordingId);
  } catch (err) {
    // Legacy mode exists ONLY for databases without the FinalizeJob tables.
    // It has no locking, so falling into it on arbitrary errors let concurrent
    // requests run duplicate full re-analyses.
    if (isMissingFinalizeTablesError(err)) {
      return finalizeLegacy(recordingId);
    }
    const reason = err instanceof Error ? err.message : 'Finalize failed';
    console.error('[finalize] job mode failed:', err);
    return { ok: false, reason };
  }
}
