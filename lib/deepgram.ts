const DEEPGRAM_KEY = process.env.DEEPGRAM_API_KEY;
export const isDeepgramReady = !!DEEPGRAM_KEY && DEEPGRAM_KEY !== 'your_deepgram_api_key_here';

// Segments as returned per-chunk — speaker is Deepgram's local 0-indexed integer
export interface DeepgramRawSegment {
  start: number;
  end: number;
  text: string;
  speaker: number;
}

interface DeepgramUtterance {
  start: number;
  end: number;
  transcript: string;
  speaker: number;
}

export async function transcribeWithDeepgram(
  audioData: Buffer,
  mimeType: string,
): Promise<{ text: string; segments: DeepgramRawSegment[] }> {
  if (!DEEPGRAM_KEY) throw new Error('DEEPGRAM_API_KEY not configured');

  const contentType = mimeType.includes('mp4') ? 'audio/mp4'
    : mimeType.includes('ogg') ? 'audio/ogg'
    : 'audio/webm';

  const res = await fetch(
    'https://api.deepgram.com/v1/listen?model=nova-2&diarize=true&punctuate=true&utterances=true&smart_format=true',
    {
      method: 'POST',
      headers: {
        'Authorization': `Token ${DEEPGRAM_KEY}`,
        'Content-Type': contentType,
      },
      body: new Uint8Array(audioData),
    },
  );

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Deepgram ${res.status}: ${body.slice(0, 300)}`);
  }

  const data = await res.json() as { results?: { utterances?: DeepgramUtterance[] } };
  const utterances = data.results?.utterances ?? [];

  const segments: DeepgramRawSegment[] = utterances.map(u => ({
    start: u.start,
    end: u.end,
    text: u.transcript.trim(),
    speaker: u.speaker,
  }));

  const text = utterances.map(u => u.transcript.trim()).filter(Boolean).join(' ');
  return { text, segments };
}

// Convert per-chunk local speaker indices into consistent global "Speaker N" labels.
// Chunks must be sorted by time offset (ascending) — chunks are continuous audio so
// whoever spoke first in chunk N+1 is assumed to be the same person who spoke last in chunk N.
export function alignSpeakersAcrossChunks(
  chunks: Array<{ segments: DeepgramRawSegment[]; offset: number }>,
): Array<{ start: number; end: number; text: string; speaker: string }> {
  const result: Array<{ start: number; end: number; text: string; speaker: string }> = [];
  let nextSpeakerNum = 1;
  let lastGlobalSpeaker = '';

  for (const chunk of chunks) {
    const sorted = [...chunk.segments].sort((a, b) => a.start - b.start);
    if (!sorted.length) continue;

    const localToGlobal = new Map<number, string>();

    // First speaker of this chunk = continuation of the last speaker in the previous chunk
    const firstLocal = sorted[0].speaker;
    localToGlobal.set(firstLocal, lastGlobalSpeaker || `Speaker ${nextSpeakerNum++}`);

    for (const seg of sorted) {
      if (!localToGlobal.has(seg.speaker)) {
        localToGlobal.set(seg.speaker, `Speaker ${nextSpeakerNum++}`);
      }
    }

    for (const seg of sorted) {
      result.push({
        start: seg.start + chunk.offset,
        end: seg.end + chunk.offset,
        text: seg.text,
        speaker: localToGlobal.get(seg.speaker) ?? `Speaker ${seg.speaker + 1}`,
      });
    }

    lastGlobalSpeaker = result[result.length - 1]?.speaker ?? lastGlobalSpeaker;
  }

  return result;
}
