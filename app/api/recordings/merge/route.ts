import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import {
  diarizeSegments,
  identifySpeakerNames,
  analyzeTranscript,
  generateTitle,
  generateTopics,
} from '@/lib/ai';
import type { RawSegment } from '@/lib/ai';

export const dynamic = 'force-dynamic';
export const maxDuration = 800;

const CUID_RE = /^c[a-z0-9]{20,}$/;

export async function POST(request: NextRequest) {
  let body: { recordingIds?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON.' }, { status: 400 });
  }

  const { recordingIds } = body;
  if (
    !Array.isArray(recordingIds) ||
    recordingIds.length < 2 ||
    !recordingIds.every((id) => typeof id === 'string' && CUID_RE.test(id))
  ) {
    return NextResponse.json({ error: 'Provide at least 2 valid recording IDs.' }, { status: 400 });
  }

  // Fetch all recordings and their transcripts in the order provided
  const recordings = await prisma.recording.findMany({
    where: { id: { in: recordingIds as string[] } },
    include: { transcript: true, summary: true },
  });

  // Re-order to match selection order
  const ordered = (recordingIds as string[]).map(
    (id) => recordings.find((r) => r.id === id),
  ).filter(Boolean) as typeof recordings;

  if (ordered.length < 2) {
    return NextResponse.json({ error: 'Could not find the specified recordings.' }, { status: 404 });
  }

  // Concatenate transcripts in order, adjusting segment timestamps to be continuous
  let fullText = '';
  const allSegments: RawSegment[] = [];
  let timeOffset = 0;

  for (const rec of ordered) {
    const t = rec.transcript;
    if (!t) continue;

    if (t.fullText.trim()) {
      fullText += (fullText ? '\n\n' : '') + t.fullText.trim();
    }

    try {
      const segs = JSON.parse(t.segments) as Array<{ start: number; end: number; text: string }>;
      if (segs.length > 0) {
        // Find the duration of this recording's segments to advance the offset
        const maxEnd = segs.reduce((m, s) => Math.max(m, s.end), 0);
        allSegments.push(...segs.map((s) => ({
          start: s.start + timeOffset,
          end: s.end + timeOffset,
          text: s.text,
        })));
        timeOffset += maxEnd + 1; // 1-second gap between recordings
      }
    } catch { /* skip */ }
  }

  if (!fullText.trim()) {
    return NextResponse.json({ error: 'No transcript content found in the selected recordings.' }, { status: 422 });
  }

  // Build a merged title from source titles
  const sourceNames = ordered.map((r) => r.title).filter(Boolean);
  const mergedBaseTitle = sourceNames.length > 0
    ? `Merged: ${sourceNames.slice(0, 2).join(' + ')}${sourceNames.length > 2 ? ` +${sourceNames.length - 2} more` : ''}`
    : 'Merged Recording';

  // Create the new recording record first (with processing status)
  const newRecording = await prisma.recording.create({
    data: {
      title: mergedBaseTitle,
      status: 'processing',
      mimeType: 'merged',
    },
  });

  try {
    // Save combined transcript
    await prisma.transcript.create({
      data: {
        recordingId: newRecording.id,
        fullText,
        segments: JSON.stringify(allSegments),
      },
    });

    // Run AI analysis in parallel
    const [diarizedRaw, analysis, shortTitle, topics] = await Promise.all([
      diarizeSegments(allSegments),
      analyzeTranscript(fullText),
      generateTitle(fullText),
      generateTopics(allSegments),
    ]);

    const speakerNames = await identifySpeakerNames(diarizedRaw);
    const diarized = Object.keys(speakerNames).length > 0
      ? diarizedRaw.map((seg) => ({ ...seg, speaker: speakerNames[seg.speaker] ?? seg.speaker }))
      : diarizedRaw;

    await prisma.transcript.update({
      where: { recordingId: newRecording.id },
      data: { segments: JSON.stringify(diarized) },
    });

    if (
      !analysis.overview.trim() ||
      analysis.overview.startsWith('Demo summary') ||
      analysis.overview.startsWith('Analysis could not be completed')
    ) {
      await prisma.recording.update({ where: { id: newRecording.id }, data: { status: 'failed' } });
      return NextResponse.json({ error: 'AI analysis returned empty content.' }, { status: 500 });
    }

    const dateStr = new Date().toLocaleDateString('en-GB', {
      day: 'numeric', month: 'short', year: 'numeric',
    });
    const finalTitle = shortTitle ? `${shortTitle} - ${dateStr}` : mergedBaseTitle;

    await prisma.$transaction(async (tx) => {
      await tx.summary.create({
        data: {
          recordingId: newRecording.id,
          overview: analysis.overview,
          keyPoints: JSON.stringify(analysis.keyPoints),
          actionItems: JSON.stringify(analysis.actionItems),
          decisions: JSON.stringify(analysis.decisions),
          topics: JSON.stringify(topics),
        },
      });
      await tx.recording.update({
        where: { id: newRecording.id },
        data: { status: 'completed', title: finalTitle },
      });
    });

    return NextResponse.json({ id: newRecording.id });
  } catch (err) {
    // Clean up the new recording on failure
    await prisma.recording.delete({ where: { id: newRecording.id } }).catch(() => {});
    console.error('[merge] failed:', err);
    return NextResponse.json({ error: 'Merge failed.' }, { status: 500 });
  }
}
