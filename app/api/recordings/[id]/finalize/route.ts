import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { diarizeSegments, analyzeTranscript, generateTitle, generateTopics } from '@/lib/ai';
import type { RawSegment } from '@/lib/ai';

export const dynamic = 'force-dynamic';
export const maxDuration = 300;

const CUID_RE = /^c[a-z0-9]{20,}$/;

export async function POST(
  _request: NextRequest,
  { params }: { params: { id: string } },
) {
  if (!CUID_RE.test(params.id)) {
    return NextResponse.json({ error: 'Invalid recording ID.' }, { status: 400 });
  }

  try {
    const transcript = await prisma.transcript.findUnique({
      where: { recordingId: params.id },
    });

    if (!transcript) {
      return NextResponse.json({ error: 'No transcript found.' }, { status: 404 });
    }

    const rawSegments: RawSegment[] = JSON.parse(transcript.segments);

    // Run all AI calls in parallel (diarization is the slowest — batched internally)
    const [diarized, analysis, shortTitle, topics] = await Promise.all([
      diarizeSegments(rawSegments),
      analyzeTranscript(transcript.fullText),
      generateTitle(transcript.fullText),
      generateTopics(rawSegments),
    ]);

    // Build title: "Q3 Budget Review – 13 Apr 2026"
    const dateStr = new Date().toLocaleDateString('en-GB', {
      day: 'numeric', month: 'short', year: 'numeric',
    });
    const title = shortTitle ? `${shortTitle} – ${dateStr}` : null;

    // Persist everything
    await prisma.transcript.update({
      where: { recordingId: params.id },
      data: { segments: JSON.stringify(diarized) },
    });

    await prisma.summary.upsert({
      where: { recordingId: params.id },
      create: {
        recordingId: params.id,
        overview: analysis.overview,
        keyPoints: JSON.stringify(analysis.keyPoints),
        actionItems: JSON.stringify(analysis.actionItems),
        decisions: JSON.stringify(analysis.decisions),
        topics: JSON.stringify(topics),
      },
      update: {
        overview: analysis.overview,
        keyPoints: JSON.stringify(analysis.keyPoints),
        actionItems: JSON.stringify(analysis.actionItems),
        decisions: JSON.stringify(analysis.decisions),
        topics: JSON.stringify(topics),
      },
    });

    await prisma.recording.update({
      where: { id: params.id },
      data: { status: 'completed', ...(title ? { title } : {}) },
    });

    return NextResponse.json({ ok: true });
  } catch (error) {
    console.error('[finalize] Error:', error);
    await prisma.recording.update({
      where: { id: params.id },
      data: { status: 'failed' },
    }).catch(() => {});
    return NextResponse.json({ error: 'Finalization failed.' }, { status: 500 });
  }
}
