// Locate the transcript segment a summary line came from.
//
// Key points, action items and decisions are AI-paraphrased strings with no
// stored timestamp, so we can't jump to them by time the way topics do. Instead
// we match the line's distinctive words against every transcript block and pick
// the closest one. Weighting is IDF-based cosine similarity: words that appear
// in many blocks (the, water, meeting) barely count, while rare, distinctive
// ones (Montgomery, Stripe, safeforlegs) dominate — which is exactly what pins
// a paraphrase back to the moment it was said.

const STOPWORDS = new Set([
  'the','a','an','and','or','but','if','then','so','because','as','of','at','by',
  'for','with','about','against','between','into','through','during','before',
  'after','above','below','to','from','up','down','in','out','on','off','over',
  'under','again','further','once','here','there','all','any','both','each','few',
  'more','most','other','some','such','no','nor','not','only','own','same','than',
  'too','very','can','will','just','should','now','is','are','was','were','be',
  'been','being','have','has','had','having','do','does','did','doing','would',
  'could','this','that','these','those','it','its','they','them','their','we',
  'our','you','your','he','she','his','her','him','i','me','my','who','whom',
  'which','what','when','where','why','how','also','get','got','one','make','made',
]);

export function tokenize(text: string): string[] {
  const raw = text.toLowerCase().match(/[a-z0-9]+/g) ?? [];
  return raw.filter((t) => t.length > 1 && !STOPWORDS.has(t));
}

/** Same content-word filter as tokenize(), but keeps each word's character
 *  offsets in the original string so a match can be highlighted in place. */
export function tokenizeWithOffsets(text: string): Array<{ tok: string; start: number; end: number }> {
  const out: Array<{ tok: string; start: number; end: number }> = [];
  const re = /[a-z0-9]+/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const tok = m[0].toLowerCase();
    if (tok.length > 1 && !STOPWORDS.has(tok)) out.push({ tok, start: m.index, end: m.index + m[0].length });
  }
  return out;
}

/** Where in a block a summary line came from: the block index and the character
 *  span [start, end) of the tightest run of the line's distinctive words, or
 *  null when nothing distinctive lands inside it. */
export interface MatchLocation {
  index: number;
  span: [number, number] | null;
}

export interface SegmentMatcher {
  /** Best-matching block index for a query string, or -1 if nothing overlaps. */
  match(query: string): number;
  /** Best block index AND the exact span within it to highlight. */
  locate(query: string): MatchLocation;
}

/**
 * Build a matcher over a fixed set of block texts. Precomputes per-block token
 * sets and IDF norms so each subsequent match() is cheap — call once (memoised
 * on the segment list) and reuse across clicks.
 */
export function createSegmentMatcher(texts: string[]): SegmentMatcher {
  const n = texts.length;
  const tokenSets = texts.map((t) => new Set(tokenize(t)));

  // Document frequency → IDF. Smoothed so a term present everywhere still has a
  // small positive weight and a rare term is heavily favoured.
  const df = new Map<string, number>();
  for (const set of tokenSets) {
    for (const tok of set) df.set(tok, (df.get(tok) ?? 0) + 1);
  }
  const idf = (tok: string) => Math.log((n + 1) / ((df.get(tok) ?? 0) + 1)) + 1;

  // Per-block L2 norm over IDF weights (binary term presence).
  const norms = tokenSets.map((set) => {
    let sum = 0;
    for (const tok of set) { const w = idf(tok); sum += w * w; }
    return Math.sqrt(sum);
  });

  function bestBlock(query: string): { index: number; qSet: Set<string> } {
    const qTokens = Array.from(new Set(tokenize(query)));
    if (qTokens.length === 0) return { index: -1, qSet: new Set() };

    // Precompute each query term's squared IDF weight and the query norm.
    let qNorm = 0;
    const qSq = new Map<string, number>();
    for (const tok of qTokens) { const w = idf(tok); qSq.set(tok, w * w); qNorm += w * w; }
    qNorm = Math.sqrt(qNorm);
    if (qNorm === 0) return { index: -1, qSet: new Set(qTokens) };

    // The query is a short summary line, so iterating its terms per block is
    // cheap. Shared terms contribute idf² to the dot product (both sides use
    // the same binary-presence × IDF weight).
    let bestIdx = -1;
    let bestScore = 0;
    for (let i = 0; i < n; i++) {
      if (norms[i] === 0) continue;
      const set = tokenSets[i];
      let dot = 0;
      for (const [tok, w2] of qSq) if (set.has(tok)) dot += w2;
      if (dot === 0) continue;
      const score = dot / (qNorm * norms[i]);
      if (score > bestScore) { bestScore = score; bestIdx = i; }
    }
    return { index: bestIdx, qSet: new Set(qTokens) };
  }

  // Words apart that a highlight will still bridge. Two matched words with a run
  // of unrelated speech between them belong to different moments, so we don't
  // stretch one highlight across the gap.
  const MAX_WORD_GAP = 6;

  /** Grow a span out to the sentence(s) it sits in, so the highlight reads as
   *  the whole thing that was said rather than a lone word. Sentence bounds are
   *  . ! ? or a line break; if none is found the block edge is the bound. */
  function expandToSentence(text: string, start: number, end: number): [number, number] {
    let s = start;
    while (s > 0) {
      const ch = text[s - 1];
      if (ch === '.' || ch === '!' || ch === '?' || ch === '\n') break;
      s--;
    }
    while (s < start && /\s/.test(text[s])) s++; // drop leading space after the stop
    let e = end;
    while (e < text.length) {
      const ch = text[e];
      if (ch === '\n') break;
      e++;
      if (ch === '.' || ch === '!' || ch === '?') break;
    }
    return [s, e];
  }

  /** Within one block, the tightest run of the query's distinctive words. Scores
   *  each cluster by the total IDF weight of the matched words it contains, so
   *  the highlight lands on the densest, most distinctive phrase rather than the
   *  first stray keyword. */
  function spanWithin(index: number, qSet: Set<string>): [number, number] | null {
    const words = tokenizeWithOffsets(texts[index]);
    const hits: Array<{ i: number; start: number; end: number; w: number }> = [];
    for (let i = 0; i < words.length; i++) {
      if (qSet.has(words[i].tok)) hits.push({ i, start: words[i].start, end: words[i].end, w: idf(words[i].tok) });
    }
    if (hits.length === 0) return null;

    let bestStart = hits[0].start, bestEnd = hits[0].end, bestWeight = -1;
    let clusterStart = hits[0].start, clusterEnd = hits[0].end, clusterWeight = hits[0].w;
    for (let k = 1; k <= hits.length; k++) {
      const gap = k < hits.length ? hits[k].i - hits[k - 1].i : Infinity;
      if (gap <= MAX_WORD_GAP) {
        clusterEnd = hits[k].end;
        clusterWeight += hits[k].w;
      } else {
        if (clusterWeight > bestWeight) { bestWeight = clusterWeight; bestStart = clusterStart; bestEnd = clusterEnd; }
        if (k < hits.length) { clusterStart = hits[k].start; clusterEnd = hits[k].end; clusterWeight = hits[k].w; }
      }
    }
    return expandToSentence(texts[index], bestStart, bestEnd);
  }

  return {
    match(query: string): number {
      return bestBlock(query).index;
    },
    locate(query: string): MatchLocation {
      const { index, qSet } = bestBlock(query);
      if (index < 0) return { index, span: null };
      return { index, span: spanWithin(index, qSet) };
    },
  };
}
