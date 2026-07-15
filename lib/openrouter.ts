// OpenRouter LLM routing — delegates the cheap text tasks (titles, topics,
// text diarization fallback, speaker-name guessing) to free/cheap models,
// keeping Anthropic quota for the main meeting analysis.
//
// Ladder: free models first (may 429 under load — skip to next), then a
// very cheap paid model. Callers fall back to Anthropic when this returns null.
// Override with OPENROUTER_MODELS="model-a,model-b" env var; free model IDs
// churn every few months, so expect to refresh this list.

const OPENROUTER_KEY = process.env.OPENROUTER_API_KEY;
export const isOpenRouterReady = !!OPENROUTER_KEY;

// Note: this account's OpenRouter data policy blocks free endpoints that train
// on prompts (good — meeting audio is business data), which 404s several :free
// models. Ladder = free models that pass the policy, then a very cheap paid one.
const DEFAULT_MODELS = [
  'qwen/qwen3-next-80b-a3b-instruct:free',
  'meta-llama/llama-3.3-70b-instruct:free',
  'openai/gpt-oss-120b', // paid fallback, ~$0.04/M input — ~$0.001 per meeting
];

const MODELS = (process.env.OPENROUTER_MODELS ?? '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

const modelLadder = MODELS.length ? MODELS : DEFAULT_MODELS;

const REQUEST_TIMEOUT_MS = 45_000;

export async function openRouterComplete(prompt: string, maxTokens: number): Promise<string | null> {
  if (!OPENROUTER_KEY) return null;

  for (const model of modelLadder) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS);
    try {
      const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        signal: ctrl.signal,
        headers: {
          'Authorization': `Bearer ${OPENROUTER_KEY}`,
          'Content-Type': 'application/json',
          'HTTP-Referer': 'https://ftctranscribe.vercel.app',
          'X-Title': 'FTC Transcribe',
        },
        body: JSON.stringify({
          model,
          // Reasoning models (gpt-oss, qwen) spend tokens thinking before they
          // answer — give headroom so the visible answer never gets truncated,
          // and keep the thinking short. Ignored by non-reasoning models.
          max_tokens: maxTokens * 2 + 1024,
          temperature: 0,
          reasoning: { effort: 'low', exclude: true },
          messages: [{ role: 'user', content: prompt }],
        }),
      });

      if (!res.ok) {
        // 429 = free model saturated, 404 = model retired, 5xx = provider down —
        // in every case the next model in the ladder is the answer
        continue;
      }

      const data = await res.json() as { choices?: Array<{ message?: { content?: string } }> };
      const text = data.choices?.[0]?.message?.content;
      if (typeof text === 'string' && text.trim()) return text;
    } catch {
      // timeout / network — try next model
    } finally {
      clearTimeout(timer);
    }
  }
  return null;
}
