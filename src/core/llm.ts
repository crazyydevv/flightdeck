// One call to any OpenAI-compatible chat endpoint (Qwen, Gemini, others).
// Server-side only. Returns null when no model is configured.

export function llmConfigured(): boolean {
  return Boolean(process.env.LLM_BASE_URL && process.env.LLM_API_KEY && process.env.LLM_MODEL);
}

export async function chat(system: string, user: string, maxTokens = 500): Promise<string | null> {
  const { LLM_BASE_URL: base, LLM_API_KEY: key, LLM_MODEL: model } = process.env;
  if (!base || !key || !model) return null;
  const r = await fetch(base.replace(/\/$/, '') + '/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
    body: JSON.stringify({ model, temperature: 0.3, max_tokens: maxTokens, messages: [{ role: 'system', content: system }, { role: 'user', content: user }] }),
    signal: AbortSignal.timeout(25_000),
  });
  const json = (await r.json()) as { choices?: { message?: { content?: string } }[] };
  return json.choices?.[0]?.message?.content ?? null;
}
