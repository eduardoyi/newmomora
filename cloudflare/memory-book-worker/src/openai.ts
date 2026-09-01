/**
 * OpenAI chat-completions fetch wrappers for the outline call and the
 * cover-verify call, ported from supabase/scripts/eval-memory-book-outline.ts
 * (callOpenAiOutline / callOpenAiCoverVerify) -- same endpoint, same
 * one-shot 429/5xx retry policy. Request bodies come from the SHARED
 * builders (`buildOutlineRequestBody`/`buildCoverVerifyRequestBody`) so the
 * prompt contract can never drift between the eval CLI and this worker.
 */
import type { OpenAiUsage } from '../../../supabase/functions/_shared/memory-book-outline.ts';
import type { Env } from './types';

const OPENAI_CHAT_COMPLETIONS_URL = 'https://api.openai.com/v1/chat/completions';
const RETRY_BACKOFF_MS = 1500;

/** The outline call and the cover-verify call both use this model (same as
 * the eval CLI's `--model` default) -- see docs/durable-ai-generation-
 * workflows.md's "Failure classification" table for why a bounded one-shot
 * retry, not open-ended, is the right policy for a deterministic-provider
 * rejection vs a transient one. */
export const DEFAULT_OUTLINE_MODEL = 'gpt-5.6-sol';

export class OutlineProviderError extends Error {
  constructor(
    public readonly code: string,
    public readonly retryable: boolean,
  ) {
    super(code);
  }
}

export interface OpenAiChatResult {
  content: string;
  usage: OpenAiUsage | null;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseUsage(raw: unknown): OpenAiUsage | null {
  if (!raw || typeof raw !== 'object') return null;
  const usage = raw as Record<string, unknown>;
  const promptTokens = usage.prompt_tokens;
  const completionTokens = usage.completion_tokens;
  if (typeof promptTokens !== 'number' || typeof completionTokens !== 'number') return null;
  return { prompt_tokens: promptTokens, completion_tokens: completionTokens };
}

async function postChatCompletion(apiKey: string, body: Record<string, unknown>): Promise<OpenAiChatResult> {
  const payload = JSON.stringify(body);
  const attempt = () =>
    fetch(OPENAI_CHAT_COMPLETIONS_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: payload,
    });

  let response: Response;
  try {
    response = await attempt();
  } catch {
    throw new OutlineProviderError('OPENAI_NETWORK_ERROR', true);
  }

  if (!response.ok && (response.status === 429 || response.status >= 500)) {
    await delay(RETRY_BACKOFF_MS);
    try {
      response = await attempt();
    } catch {
      throw new OutlineProviderError('OPENAI_NETWORK_ERROR', true);
    }
  }

  if (!response.ok) {
    throw new OutlineProviderError(
      response.status === 408 || response.status === 429 || response.status >= 500
        ? 'OPENAI_RETRYABLE_ERROR'
        : 'OPENAI_REJECTED',
      response.status === 408 || response.status === 429 || response.status >= 500,
    );
  }

  let json: { choices?: Array<{ message?: { content?: string } }>; usage?: unknown };
  try {
    json = await response.json();
  } catch {
    throw new OutlineProviderError('OPENAI_MALFORMED_RESPONSE', true);
  }

  const content = json.choices?.[0]?.message?.content;
  if (typeof content !== 'string' || content.length === 0) {
    throw new OutlineProviderError('OPENAI_EMPTY_RESPONSE', true);
  }

  return { content, usage: parseUsage(json.usage) };
}

export async function callOpenAiChat(
  env: Env,
  body: Record<string, unknown>,
): Promise<OpenAiChatResult> {
  return await postChatCompletion(env.OPENAI_API_KEY, body);
}
