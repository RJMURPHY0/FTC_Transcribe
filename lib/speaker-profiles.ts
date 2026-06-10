import { prisma } from '@/lib/db';
import type { TranscriptSegment } from '@/lib/ai';

export interface SpeakerFeatures {
  avgSegDuration: number;
  avgPause:       number;
  speakingRate:   number; // words per second
  topWords:       string[];
}

const STOP_WORDS = new Set([
  'the','a','an','and','or','but','in','on','at','to','for','of','with','by',
  'is','are','was','were','be','been','have','has','had','do','does','did',
  'will','would','could','should','can','may','might','shall','i','we','you',
  'he','she','they','it','this','that','these','those','so','if','as','not',
  'no','yes','ok','yeah','um','uh','like','just','really','very',
]);

export function extractFeatures(segments: TranscriptSegment[]): SpeakerFeatures {
  if (!segments.length) {
    return { avgSegDuration: 0, avgPause: 0, speakingRate: 0, topWords: [] };
  }

  const durations: number[] = segments.map(s => s.end - s.start);
  const avgSegDuration = durations.reduce((a, b) => a + b, 0) / durations.length;

  const pauses: number[] = [];
  for (let i = 1; i < segments.length; i++) {
    const gap = segments[i].start - segments[i - 1].end;
    if (gap > 0 && gap < 30) pauses.push(gap);
  }
  const avgPause = pauses.length ? pauses.reduce((a, b) => a + b, 0) / pauses.length : 0;

  const allWords = segments.flatMap(s => s.text.toLowerCase().split(/\s+/).filter(Boolean));
  const wordCount = allWords.length;
  const totalDuration = durations.reduce((a, b) => a + b, 0);
  const speakingRate = totalDuration > 0 ? wordCount / totalDuration : 0;

  const freq: Record<string, number> = {};
  for (const word of allWords) {
    const clean = word.replace(/[^a-z']/g, '');
    if (clean.length > 3 && !STOP_WORDS.has(clean)) {
      freq[clean] = (freq[clean] ?? 0) + 1;
    }
  }
  const topWords = Object.entries(freq)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 20)
    .map(([w]) => w);

  return { avgSegDuration, avgPause, speakingRate, topWords };
}

// Cosine-style similarity between two feature vectors (0–1, higher = more similar)
export function featureSimilarity(a: SpeakerFeatures, b: SpeakerFeatures): number {
  // Numeric distance score (lower = more similar)
  const durDiff  = Math.abs(a.avgSegDuration - b.avgSegDuration) / (Math.max(a.avgSegDuration, b.avgSegDuration, 1));
  const rateDiff = Math.abs(a.speakingRate   - b.speakingRate)   / (Math.max(a.speakingRate,   b.speakingRate,   1));

  const numericSim = 1 - (durDiff * 0.4 + rateDiff * 0.6);

  // Jaccard similarity of top-word sets
  const setA = new Set(a.topWords);
  const setB = new Set(b.topWords);
  const intersection = [...setA].filter(w => setB.has(w)).length;
  const union = new Set([...setA, ...setB]).size;
  const jaccardSim = union > 0 ? intersection / union : 0;

  return numericSim * 0.5 + jaccardSim * 0.5;
}

const MATCH_THRESHOLD = 0.55;

export async function matchOrCreateProfiles(
  segments:  TranscriptSegment[],
  userId:    string | null,
): Promise<Record<string, string>> {
  if (!segments.length) return {};

  // Group segments by speaker label
  const bySpeaker: Record<string, TranscriptSegment[]> = {};
  for (const seg of segments) {
    const key = String(seg.speaker);
    (bySpeaker[key] ??= []).push(seg);
  }

  const existingProfiles = await prisma.speakerProfile.findMany({
    where: { userId: userId ?? undefined },
    orderBy: { sampleCount: 'desc' },
  });

  const renames: Record<string, string> = {};

  for (const [label, segs] of Object.entries(bySpeaker)) {
    const features = extractFeatures(segs);

    let bestMatch: { id: string; name: string; score: number } | null = null;
    for (const profile of existingProfiles) {
      const stored = JSON.parse(profile.features) as SpeakerFeatures;
      const score  = featureSimilarity(features, stored);
      if (score > MATCH_THRESHOLD && (!bestMatch || score > bestMatch.score)) {
        bestMatch = { id: profile.id, name: profile.name, score };
      }
    }

    if (bestMatch) {
      renames[label] = bestMatch.name;
      // Update profile with blended features
      const stored   = JSON.parse(existingProfiles.find(p => p.id === bestMatch!.id)!.features) as SpeakerFeatures;
      const n        = existingProfiles.find(p => p.id === bestMatch!.id)!.sampleCount;
      const blended: SpeakerFeatures = {
        avgSegDuration: (stored.avgSegDuration * n + features.avgSegDuration) / (n + 1),
        avgPause:       (stored.avgPause       * n + features.avgPause)       / (n + 1),
        speakingRate:   (stored.speakingRate   * n + features.speakingRate)   / (n + 1),
        topWords:       [...new Set([...stored.topWords, ...features.topWords])].slice(0, 20),
      };
      await prisma.speakerProfile.update({
        where: { id: bestMatch.id },
        data:  { features: JSON.stringify(blended), sampleCount: { increment: 1 } },
      });
    }
  }

  return renames;
}
