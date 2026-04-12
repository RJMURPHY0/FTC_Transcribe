import { NextRequest, NextResponse } from 'next/server';
import { writeFile, unlink } from 'fs/promises';
import path from 'path';
import os from 'os';
import { prisma } from '@/lib/db';
import { transcribeAudio, diarizeSegments, analyzeTranscript } from '@/lib/ai';

export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest) {
  let tempPath: string | null = null;
  let recordingId: string | null = null;

  try {
    const formData = await request.formData();
    const file = formData.get('audio') as File | null;

    if (!file || file.size === 0) {
      return NextResponse.json({ error: 'No audio file provided.' }, { status: 400 });
    }

    // Write to temp file
    const bytes = await file.arrayBuffer();
    const buffer = Buffer.from(bytes);
    const ext = file.type.includes('mp4') ? '.mp4' : '.webm';
    tempPath = path.join(os.tmpdir(), `rec-${Date.now()}${ext}`);
    await writeFile(tempPath, buffer);

    // Create a placeholder DB record (track ID so we can mark as failed on error)
    const recording = await prisma.recording.create({
      data: {
        title: `Recording – ${new Date().toLocaleDateString('en-GB', {
          day: 'numeric',
          month: 'short',
          year: 'numeric',
        })}`,
        mimeType: file.type,
        fileSize: file.size,
        status: 'processing',
      },
    });
    recordingId = recording.id;

    // Transcribe (returns full text + timestamped segments)
    const { text: transcriptText, rawSegments } = await transcribeAudio(tempPath);

    // Diarise: assign speaker labels to each timestamped segment
    const segments = await diarizeSegments(rawSegments);

    // Analyse
    const analysis = await analyzeTranscript(transcriptText);

    // Save transcript
    await prisma.transcript.create({
      data: {
        recordingId: recording.id,
        fullText: transcriptText,
        segments: JSON.stringify(segments),
      },
    });

    // Save summary
    await prisma.summary.create({
      data: {
        recordingId: recording.id,
        overview: analysis.overview,
        keyPoints: JSON.stringify(analysis.keyPoints),
        actionItems: JSON.stringify(analysis.actionItems),
        decisions: JSON.stringify(analysis.decisions),
      },
    });

    // Mark complete
    await prisma.recording.update({
      where: { id: recording.id },
      data: { status: 'completed' },
    });

    return NextResponse.json({ id: recording.id });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Processing failed.';
    console.error('[transcribe] Error:', error);
    // Mark the recording as failed so it doesn't hang as "processing" forever
    if (recordingId) {
      await prisma.recording.update({
        where: { id: recordingId },
        data: { status: 'failed' },
      }).catch(() => {});
    }
    return NextResponse.json({ error: message }, { status: 500 });
  } finally {
    if (tempPath) await unlink(tempPath).catch(() => {});
  }
}
