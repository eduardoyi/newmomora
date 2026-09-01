import { describe, expect, it, vi } from 'vitest';
import { verifyCoverCandidates } from '../src/cover-verify';
import type { Env } from '../src/types';

function fakeEnv(overrides: Partial<Env> = {}): Env {
  return {
    ENVIRONMENT: 'test',
    SUPABASE_BRIDGE_URL: 'https://bridge.test',
    DISPATCH_SIGNING_SECRET: 'x',
    SUPABASE_BRIDGE_HMAC_SECRET: 'x',
    OPENAI_API_KEY: 'test-key',
    MEMORY_BOOK_PREVIEWS: { get: vi.fn(async () => null) } as unknown as R2Bucket,
    MEMORY_BOOK_WORKFLOW: {} as unknown as Workflow,
    ...overrides,
  };
}

describe('verifyCoverCandidates', () => {
  it('returns empty with no OpenAI/R2 calls when there are no candidates', async () => {
    const env = fakeEnv();
    const result = await verifyCoverCandidates(env, [], new Map());
    expect(result).toEqual({ coverCandidates: [], violations: [], usage: null });
    expect(env.MEMORY_BOOK_PREVIEWS.get).not.toHaveBeenCalled();
  });

  it('excludes a candidate with no fetchable thumbnail -- never silently kept as "passed"', async () => {
    const bucket = { get: vi.fn(async (key: string) => (key === 'has-preview.jpg' ? { arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer } : null)) };
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response(JSON.stringify({
      choices: [{ message: { content: JSON.stringify({ verdicts: [{ index: 0, disqualified: false, reason_code: 'ok', reason_detail: 'clear' }] }) } }],
      usage: { prompt_tokens: 10, completion_tokens: 5 },
    }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const env = fakeEnv({ MEMORY_BOOK_PREVIEWS: bucket as unknown as R2Bucket });
    const previewKeyByMemoryId = new Map([
      ['mem-with-preview', 'has-preview.jpg'],
      ['mem-without-preview', null],
    ]);
    const result = await verifyCoverCandidates(env, ['mem-with-preview', 'mem-without-preview'], previewKeyByMemoryId);

    expect(result.coverCandidates).toEqual(['mem-with-preview']);
    expect(result.violations.some((v) => v.kind === 'cover_verify_thumb_unavailable' && v.detail === 'mem-without-preview')).toBe(true);
    // Only one image (the fetchable one) was ever sent to the vision call.
    const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
    const imageParts = (body.messages[1].content as Array<{ type: string }>).filter((c) => c.type === 'image_url');
    expect(imageParts).toHaveLength(1);
  });

  it('fails open (keeps everything) when the model\'s content is not valid verdicts JSON', async () => {
    const bucket = { get: vi.fn(async () => ({ arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer })) };
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      choices: [{ message: { content: 'not json' } }],
    }), { status: 200 })));
    const env = fakeEnv({ MEMORY_BOOK_PREVIEWS: bucket as unknown as R2Bucket });
    const result = await verifyCoverCandidates(env, ['mem-1'], new Map([['mem-1', 'preview.jpg']]));
    expect(result.coverCandidates).toEqual(['mem-1']);
    expect(result.violations.some((v) => v.kind === 'cover_verify_unparseable')).toBe(true);
  });
});
