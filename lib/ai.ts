import OpenAI from 'openai';
import Anthropic from '@anthropic-ai/sdk';
import fs from 'fs';

// ── Transcription: Groq (free Whisper) preferred, OpenAI Whisper as fallback ──
const GROQ_KEY = process.env.GROQ_API_KEY;
const OPENAI_KEY = process.env.OPENAI_API_KEY;

const isGroqReady = !!GROQ_KEY && GROQ_KEY !== 'your_groq_api_key_here';
const isOpenAIReady = !!OPENAI_KEY && OPENAI_KEY !== 'your_openai_api_key_here';
const isMockTranscription = !isGroqReady && !isOpenAIReady;

const transcriptionClient = isGroqReady
  ? new OpenAI({ apiKey: GROQ_KEY, baseURL: 'https://api.groq.com/openai/v1' })
  : isOpenAIReady
  ? new OpenAI({ apiKey: OPENAI_KEY })
  : null;

const transcriptionModel = isGroqReady ? 'whisper-large-v3-turbo' : 'whisper-1';

// ── Summarisation: Anthropic Claude ──
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
const isMockAnthropic = !ANTHROPIC_KEY || ANTHROPIC_KEY === 'your_anthropic_api_key_here';
const anthropic = isMockAnthropic ? null : new Anthropic({ apiKey: ANTHROPIC_KEY });

export interface RawSegment {
  start: number;
  end: number;
  text: string;
}

export interface TranscriptSegment {
  speaker: string;
  start: number;
  end: number;
  text: string;
}

export interface AnalysisResult {
  overview: string;
  keyPoints: string[];
  actionItems: string[];
  decisions: string[];
}

export interface TopicSection {
  time: number;  // seconds from start
  title: string;
}

function formatTime(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export async function transcribeAudio(filePath: string): Promise<{ text: string; rawSegments: RawSegment[] }> {
  if (isMockTranscription || !transcriptionClient) {
    return {
      text: 'Demo transcript — add a GROQ_API_KEY (free at console.groq.com) or OPENAI_API_KEY with billing to .env.local.',
      rawSegments: [],
    };
  }

  // Build candidate list: primary client first; if Groq is primary and OpenAI is also available,
  // add OpenAI as an automatic fallback so a Groq rate-limit never kills a chunk.
  type Candidate = { client: OpenAI; model: string; label: string };
  const candidates: Candidate[] = [
    { client: transcriptionClient, model: transcriptionModel, label: isGroqReady ? 'Groq' : 'OpenAI' },
  ];
  if (isGroqReady && isOpenAIReady) {
    candidates.push({ client: new OpenAI({ apiKey: OPENAI_KEY! }), model: 'whisper-1', label: 'OpenAI fallback' });
  }

  let lastErr: Error = new Error('Transcription failed');

  for (const { client, model, label } of candidates) {
    for (let attempt = 0; attempt < 3; attempt++) {
      if (attempt > 0) await sleep(2000 * attempt); // 2 s, 4 s back-off

      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const transcription = await client.audio.transcriptions.create({
          file: fs.createReadStream(filePath),
          model,
          response_format: 'verbose_json',
        }) as any;

        const rawSegments: RawSegment[] = (transcription.segments ?? []).map((s: RawSegment) => ({
          start: s.start,
          end: s.end,
          text: s.text,
        }));

        return { text: transcription.text as string, rawSegments };
      } catch (err: unknown) {
        const e = err as { status?: number; code?: string; message?: string };

        if (e.status === 429 || e.code === 'insufficient_quota') {
          // Rate-limited — retry this candidate with back-off
          lastErr = new Error(`${label} rate limit — retrying`);
          continue;
        }
        if (e.status === 401) {
          throw new Error('Invalid API key. Check your key in .env.local.');
        }
        // Any other error: skip to next candidate
        lastErr = new Error(e.message ?? `${label} transcription failed`);
        break;
      }
    }
  }

  throw lastErr;
}

// Process at most this many segments per Claude call to stay well within context/timeout limits
const DIARIZE_BATCH_SIZE = 100;

async function diarizeBatch(
  segments: RawSegment[],
  prevSpeaker: string,
  prevText: string,
  prevEnd: number,
  client: Anthropic,
): Promise<string[]> {
  const segmentList = segments
    .map((s, i) => {
      const gapFrom = i === 0 ? prevEnd : segments[i - 1].end;
      const gap = gapFrom >= 0 ? ` +${(s.start - gapFrom).toFixed(1)}s` : '';
      const noEnd = /[.?!…]$/.test(s.text.trim()) ? '' : ' [no-end]';
      return `[${i}] ${formatTime(s.start)}${gap}: ${s.text.trim()}${noEnd}`;
    })
    .join('\n');

  const contextHint = prevSpeaker
    ? `Last segment before this batch — ${prevSpeaker}: "${prevText}"\n\n`
    : '';

  const message = await client.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 2048,
    messages: [
      {
        role: 'user',
        content: `${contextHint}Label each segment with the speaker.

Each line shows: [index] timestamp +gap: text [no-end?]
- "+Xs" = seconds of silence before this segment started
- "[no-end]" = segment ends without terminal punctuation — the thought is incomplete

Gap rules (most important signal):
- gap < 0.5s → same speaker, person is still mid-speech
- gap 0.5s–1.5s → probably same speaker; only change if very strong turn evidence
- gap > 1.5s → possible speaker change, but ONLY if previous segment had no [no-end]
- gap > 1.5s AND previous had [no-end] → ambiguous; default to same speaker unless you are certain

Sentence rules:
- [no-end] means the thought is unfinished — the next segment almost certainly continues from the same speaker
- Never assign a new speaker immediately after a [no-end] segment unless the gap is also large AND there is clear turn-taking evidence in the words themselves

General rules:
- When in doubt keep the SAME speaker — false splits are worse than false merges
- A monologue (one person speaking) must be entirely "Speaker 1" — never alternate labels
- Fillers ("yes", "right", "mm-hmm") between long turns: default to same speaker
- Speakers numbered in order of first appearance: "Speaker 1", "Speaker 2", etc.

Segments:
${segmentList}

Return ONLY a JSON array, one label per segment: ["Speaker 1","Speaker 1","Speaker 2",...]`,
      },
    ],
  });

  const content = message.content[0];
  if (content.type !== 'text') return segments.map(() => prevSpeaker || 'Speaker 1');

  try {
    const jsonMatch = content.text.match(/\[[\s\S]*\]/);
    if (!jsonMatch) throw new Error('No JSON array in response');
    const labels = JSON.parse(jsonMatch[0]) as string[];
    return segments.map((_, i) => labels[i] ?? prevSpeaker ?? 'Speaker 1');
  } catch {
    return segments.map(() => prevSpeaker || 'Speaker 1');
  }
}

// Fix single-segment speaker islands that are almost certainly diarization errors.
// E.g. [...S1, S1, S2, S1, S1...] where the S2 segment is short → collapse to S1.
function fixOrphanSpeakers(segments: TranscriptSegment[]): TranscriptSegment[] {
  const result = [...segments];
  for (let i = 1; i < result.length - 1; i++) {
    const prev = result[i - 1].speaker;
    const curr = result[i].speaker;
    const next = result[i + 1].speaker;
    if (curr !== prev && prev === next) {
      const wordCount = result[i].text.trim().split(/\s+/).length;
      if (wordCount < 10) {
        result[i] = { ...result[i], speaker: prev };
      }
    }
  }
  return result;
}

export async function diarizeSegments(rawSegments: RawSegment[]): Promise<TranscriptSegment[]> {
  if (!rawSegments.length) return [];

  // Without Claude, label everything Speaker 1
  if (isMockAnthropic || !anthropic) {
    return rawSegments.map((s) => ({ ...s, speaker: 'Speaker 1' }));
  }

  const allLabels: string[] = [];
  let prevSpeaker = '';
  let prevText = '';
  let prevEnd = -1;

  // Process in batches so long meetings (hundreds of segments) don't hit context/timeout limits
  for (let i = 0; i < rawSegments.length; i += DIARIZE_BATCH_SIZE) {
    const batch = rawSegments.slice(i, i + DIARIZE_BATCH_SIZE);
    const labels = await diarizeBatch(batch, prevSpeaker, prevText, prevEnd, anthropic);
    allLabels.push(...labels);
    prevSpeaker = labels[labels.length - 1] ?? prevSpeaker;
    prevText = batch[batch.length - 1]?.text.trim() ?? prevText;
    prevEnd = batch[batch.length - 1]?.end ?? prevEnd;
  }

  // Timestamps are always from Whisper — only the speaker label comes from Claude
  const labelled = rawSegments.map((s, i) => ({ ...s, speaker: allLabels[i] ?? 'Speaker 1' }));
  return fixOrphanSpeakers(labelled);
}

export async function identifySpeakerNames(
  segments: TranscriptSegment[],
): Promise<Record<string, string>> {
  if (!segments.length || isMockAnthropic || !anthropic) return {};

  // Collect the first 6 segments per speaker (introductions) + 30 from the middle
  const perSpeaker = new Map<string, string[]>();
  for (const seg of segments) {
    const bucket = perSpeaker.get(seg.speaker) ?? [];
    if (bucket.length < 6) {
      bucket.push(`${seg.speaker}: ${seg.text.trim()}`);
      perSpeaker.set(seg.speaker, bucket);
    }
  }
  const midStart = Math.floor(segments.length * 0.4);
  const midLines = segments
    .slice(midStart, midStart + 30)
    .map(s => `${s.speaker}: ${s.text.trim()}`);

  const sampleLines: string[] = [];
  for (const lines of perSpeaker.values()) sampleLines.push(...lines);
  sampleLines.push(...midLines);

  const sample = sampleLines.join('\n').slice(0, 6000);
  const speakers = [...perSpeaker.keys()];

  try {
    const message = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 256,
      messages: [{
        role: 'user',
        content: `Analyse this meeting transcript excerpt and identify the real name of each speaker.

Only assign a name if you are HIGHLY CONFIDENT — the person introduces themselves ("I'm John", "This is Sarah"), is addressed directly by name ("Thanks, John"), or their identity is unambiguous from context.

If you are not confident, return null for that speaker.

Speaker labels: ${speakers.join(', ')}

Transcript excerpt:
${sample}

Return ONLY a JSON object, e.g. {"Speaker 1": "John Smith", "Speaker 2": null}`,
      }],
    });

    const content = message.content[0];
    if (content.type !== 'text') return {};

    const jsonMatch = content.text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return {};

    const raw = JSON.parse(jsonMatch[0]) as Record<string, string | null>;
    const result: Record<string, string> = {};
    for (const [label, name] of Object.entries(raw)) {
      if (name && typeof name === 'string' && name.trim()) {
        result[label] = name.trim();
      }
    }
    return result;
  } catch {
    return {};
  }
}

export async function generateTitle(transcript: string): Promise<string | null> {
  if (isMockAnthropic || !anthropic || !transcript.trim()) return null;

  try {
    const message = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 24,
      messages: [
        {
          role: 'user',
          content: `Write a 3-4 word meeting title. Return ONLY the title — no quotes, no punctuation at the end.

Good examples: "Q3 Budget Review", "New Hire Onboarding", "Product Roadmap Planning", "Weekly Team Standup", "Client Discovery Call"

Transcript excerpt:
${transcript.slice(0, 600)}`,
        },
      ],
    });
    const text = message.content[0]?.type === 'text' ? message.content[0].text.trim() : null;
    // Reject anything that looks too long or malformed
    if (!text || text.length > 60 || text.includes('\n')) return null;
    return text;
  } catch {
    return null;
  }
}

export async function generateTopics(rawSegments: RawSegment[]): Promise<TopicSection[]> {
  if (!rawSegments.length || isMockAnthropic || !anthropic) return [];

  // Sample up to ~80 evenly-spaced segments so the prompt stays short
  const step = Math.max(1, Math.floor(rawSegments.length / 80));
  const timeline = rawSegments
    .filter((_, i) => i % step === 0)
    .map((s) => `[${Math.round(s.start)}s] ${s.text.trim()}`)
    .join('\n');

  try {
    const message = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 512,
      messages: [
        {
          role: 'user',
          content: `Identify distinct topic sections in this meeting transcript.

Return a JSON array where each item is {"time": <start in seconds, as a number>, "title": "<3-5 word topic name>"}.

Rules:
- Return [] if the meeting has fewer than 3 clearly distinct topics (e.g. short chats, single-subject calls, casual conversations).
- 3–8 topics maximum.
- "time" must be the exact second value shown in brackets (e.g. [270s] → 270).

Timeline:
${timeline}

Return ONLY the JSON array, nothing else.`,
        },
      ],
    });

    const content = message.content[0];
    if (content.type !== 'text') return [];

    const jsonMatch = content.text.match(/\[[\s\S]*\]/);
    if (!jsonMatch) return [];

    const parsed = JSON.parse(jsonMatch[0]) as TopicSection[];
    if (!Array.isArray(parsed) || parsed.length < 3) return [];

    return parsed.filter((t) => typeof t.time === 'number' && typeof t.title === 'string');
  } catch {
    return [];
  }
}

// ~48 000 words — enough for a 4-6 hour meeting; well within Haiku's 200k token context window
const MAX_TRANSCRIPT_CHARS = 200_000;

export async function analyzeTranscript(transcript: string): Promise<AnalysisResult> {
  if (isMockAnthropic || !anthropic) {
    return {
      overview: 'Demo summary — add your ANTHROPIC_API_KEY to .env.local to enable AI analysis.',
      keyPoints: ['Add ANTHROPIC_API_KEY to .env.local', 'Restart the dev server'],
      actionItems: [],
      decisions: [],
    };
  }

  const truncated =
    transcript.length > MAX_TRANSCRIPT_CHARS
      ? transcript.slice(0, MAX_TRANSCRIPT_CHARS) + '\n\n[Transcript truncated — full meeting was longer]'
      : transcript;

  const message = await anthropic.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 1024,
    messages: [
      {
        role: 'user',
        content: `You are an AI meeting assistant. Analyse this transcript and return ONLY valid JSON.

Format:
{
  "overview": "2-3 sentence summary",
  "keyPoints": ["point 1", "point 2"],
  "actionItems": ["action 1"],
  "decisions": ["decision 1"]
}

Rules: keyPoints 3-5 items; actionItems empty array if none; decisions empty array if none.

TRANSCRIPT:
${truncated}`,
      },
    ],
  });

  const content = message.content[0];
  if (content.type !== 'text') throw new Error('Unexpected Claude response type');

  try {
    const jsonMatch = content.text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error('No JSON in response');
    return JSON.parse(jsonMatch[0]) as AnalysisResult;
  } catch {
    return {
      overview: content.text.slice(0, 500),
      keyPoints: [],
      actionItems: [],
      decisions: [],
    };
  }
}
