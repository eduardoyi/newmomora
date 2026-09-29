// Chat Completions call for the Year Film checks. Returns the content and
// the raw usage (recorded to the ledger through the bridge); never logs
// prompts or answers. One retry on 429/5xx, like the eval scripts.
export interface ChatResult {
  content: string | null;
  usage: unknown;
  ok: boolean;
}

export type ChatFn = (body: Record<string, unknown>) => Promise<ChatResult>;

export function createChat(apiKey: string): ChatFn {
  return async (body) => {
    const call = () =>
      fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
    let response = await call();
    if (!response.ok && (response.status === 429 || response.status >= 500)) {
      await new Promise((resolve) => setTimeout(resolve, 3000));
      response = await call();
    }
    if (!response.ok) {
      console.error('year film openai call failed', response.status);
      return { content: null, usage: null, ok: false };
    }
    const payload = await response.json() as { choices?: { message?: { content?: string } }[]; usage?: unknown };
    return { content: payload.choices?.[0]?.message?.content ?? null, usage: payload.usage ?? null, ok: true };
  };
}
