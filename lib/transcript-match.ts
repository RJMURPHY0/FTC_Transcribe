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

export interface SegmentMatcher {
  /** Best-matching block index for a query string, or -1 if nothing overlaps. */
  match(query: string): number;
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

  return {
    match(query: string): number {
      const qTokens = Array.from(new Set(tokenize(query)));
      if (qTokens.length === 0) return -1;

      // Precompute each query term's squared IDF weight and the query norm.
      let qNorm = 0;
      const qSq = new Map<string, number>();
      for (const tok of qTokens) { const w = idf(tok); qSq.set(tok, w * w); qNorm += w * w; }
      qNorm = Math.sqrt(qNorm);
      if (qNorm === 0) return -1;

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
      return bestIdx;
    },
  };
}
