import { assertEquals } from 'jsr:@std/assert@1';
import {
  fetchLinkPreviewsForPlan,
  handleFetchLinkPreviews,
  normalizeLinkPreviews,
  planLinkPreviewFetch,
  writeLinkPreviewsIfContentUnchanged,
  type LinkPreviewMap,
} from './index.ts';

const MEMORY_ID = '11111111-1111-4111-8111-111111111111';
const FAMILY_ID = '22222222-2222-4222-8222-222222222222';

function authenticatedRequest(memoryId = MEMORY_ID): Request {
  return new Request('http://localhost/fetch-link-previews', {
    method: 'POST',
    headers: {
      Authorization: 'Bearer test-token',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ memoryId }),
  });
}

interface MemoryFixture {
  id: string;
  family_id: string;
  content: string | null;
  link_previews: unknown;
}

function fakeMemoryReadClient(memory: MemoryFixture | null) {
  return {
    from: () => ({
      select: () => ({
        eq: () => ({
          maybeSingle: () => Promise.resolve({ data: memory, error: null }),
        }),
      }),
    }),
  };
}

interface ConditionalUpdateObservation {
  payload?: unknown;
  filters: Array<{ kind: 'eq' | 'is'; column: string; value: unknown }>;
  selectedColumns?: string;
}

function fakeConditionalUpdateClient(
  observation: ConditionalUpdateObservation,
  options: { didMatch?: boolean; errorMessage?: string } = {},
) {
  const query = {
    eq(column: string, value: unknown) {
      observation.filters.push({ kind: 'eq' as const, column, value });
      return query;
    },
    is(column: string, value: unknown) {
      observation.filters.push({ kind: 'is' as const, column, value });
      return query;
    },
    select(columns: string) {
      observation.selectedColumns = columns;
      return {
        maybeSingle: () => Promise.resolve({
          data: options.didMatch === false ? null : { id: MEMORY_ID },
          error: options.errorMessage ? { message: options.errorMessage } : null,
        }),
      };
    },
  };

  return {
    from: () => ({
      update: (payload: unknown) => {
        observation.payload = payload;
        return query;
      },
    }),
  };
}

function handlerDependencies(options: {
  memory?: MemoryFixture | null;
  role?: 'owner' | 'manager' | 'viewer' | null;
  isCoolingDown?: boolean;
  serviceClient?: ReturnType<typeof fakeConditionalUpdateClient>;
  onMarkRun?: () => void;
  fetchTitle?: (url: string) => Promise<string | null>;
} = {}) {
  const memory = options.memory === undefined
    ? {
      id: MEMORY_ID,
      family_id: FAMILY_ID,
      content: 'See https://example.com',
      link_previews: {},
    }
    : options.memory;

  return {
    getAuthenticatedUser: async () => ({ id: 'user-1' }) as never,
    createUserClient: () => fakeMemoryReadClient(memory) as never,
    createServiceClient: () =>
      (options.serviceClient ?? fakeConditionalUpdateClient({ filters: [] })) as never,
    getCallerFamilyRole: async () => options.role === undefined ? 'viewer' : options.role,
    isWithinCooldown: () => options.isCoolingDown ?? false,
    markRun: () => options.onMarkRun?.(),
    fetchTitle: options.fetchTitle ?? (async () => 'Example Domain'),
  };
}

Deno.test('fetch-link-previews rejects unauthenticated requests', async () => {
  const response = await handleFetchLinkPreviews(
    new Request('http://localhost/fetch-link-previews', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ memoryId: MEMORY_ID }),
    }),
  );

  assertEquals(response.status, 401);
});

Deno.test('fetch-link-previews rejects unsupported methods', async () => {
  const response = await handleFetchLinkPreviews(
    new Request('http://localhost/fetch-link-previews', { method: 'GET' }),
  );

  assertEquals(response.status, 405);
});

Deno.test('fetch-link-previews returns 404 when the memory is not visible', async () => {
  const response = await handleFetchLinkPreviews(
    authenticatedRequest(),
    handlerDependencies({ memory: null }),
  );

  assertEquals(response.status, 404);
  assertEquals((await response.json()).code, 'MEMORY_NOT_FOUND');
});

Deno.test('fetch-link-previews rejects callers without a family role', async () => {
  const response = await handleFetchLinkPreviews(
    authenticatedRequest(),
    handlerDependencies({ role: null }),
  );

  assertEquals(response.status, 403);
  assertEquals((await response.json()).code, 'forbidden');
});

Deno.test('fetch-link-previews enforces the per-memory cooldown before loading the memory', async () => {
  let createdUserClient = false;
  const dependencies = handlerDependencies({ isCoolingDown: true });

  const response = await handleFetchLinkPreviews(authenticatedRequest(), {
    ...dependencies,
    createUserClient: () => {
      createdUserClient = true;
      return fakeMemoryReadClient(null) as never;
    },
  });

  assertEquals(response.status, 429);
  assertEquals((await response.json()).code, 'rate_limited');
  assertEquals(createdUserClient, false);
});

Deno.test('fetch-link-previews authorizes a viewer and persists through the service client', async () => {
  const observation: ConditionalUpdateObservation = { filters: [] };
  let didMarkRun = false;
  const response = await handleFetchLinkPreviews(
    authenticatedRequest(),
    handlerDependencies({
      role: 'viewer',
      serviceClient: fakeConditionalUpdateClient(observation),
      onMarkRun: () => {
        didMarkRun = true;
      },
    }),
  );

  assertEquals(response.status, 200);
  assertEquals(didMarkRun, true);
  assertEquals(observation.filters, [
    { kind: 'eq', column: 'id', value: MEMORY_ID },
    { kind: 'eq', column: 'content', value: 'See https://example.com' },
  ]);
  assertEquals(observation.selectedColumns, 'id');
  assertEquals(
    (observation.payload as { link_previews: LinkPreviewMap }).link_previews[
      'https://example.com'
    ].title,
    'Example Domain',
  );
});

// ── planLinkPreviewFetch ─────────────────────────────────────────────────

Deno.test('planLinkPreviewFetch queues new URLs and preserves existing non-null titles', () => {
  const existing: LinkPreviewMap = {
    'https://a.com': { title: 'A Site', fetchedAt: '2026-07-01T00:00:00Z' },
  };

  const plan = planLinkPreviewFetch(
    'Check out https://a.com and also https://b.com',
    existing,
  );

  assertEquals(plan.urls, ['https://a.com', 'https://b.com']);
  assertEquals(plan.toFetch, ['https://b.com']);
  assertEquals(plan.preserved, { 'https://a.com': existing['https://a.com'] });
});

Deno.test('planLinkPreviewFetch re-queues a previously-failed (null-title) URL', () => {
  const existing: LinkPreviewMap = {
    'https://a.com': { title: null, fetchedAt: '2026-07-01T00:00:00Z' },
  };

  const plan = planLinkPreviewFetch('https://a.com', existing);

  assertEquals(plan.toFetch, ['https://a.com']);
  assertEquals(plan.preserved, {});
});

Deno.test('planLinkPreviewFetch prunes entries whose URL no longer appears in content', () => {
  const existing: LinkPreviewMap = {
    'https://a.com': { title: 'A Site', fetchedAt: '2026-07-01T00:00:00Z' },
    'https://b.com': { title: 'B Site', fetchedAt: '2026-07-01T00:00:00Z' },
  };

  // The edit removed b.com from the content entirely.
  const plan = planLinkPreviewFetch('Only https://a.com remains', existing);

  assertEquals(plan.urls, ['https://a.com']);
  assertEquals(plan.preserved, { 'https://a.com': existing['https://a.com'] });
  assertEquals(plan.toFetch, []);
});

Deno.test('planLinkPreviewFetch prunes everything when an edit removes all URLs', () => {
  const existing: LinkPreviewMap = {
    'https://a.com': { title: 'A Site', fetchedAt: '2026-07-01T00:00:00Z' },
  };

  const plan = planLinkPreviewFetch('No links here anymore.', existing);

  assertEquals(plan.urls, []);
  assertEquals(plan.preserved, {});
  assertEquals(plan.toFetch, []);
});

Deno.test('planLinkPreviewFetch caps at the first 5 URLs, ignoring the rest', () => {
  const urls = Array.from({ length: 7 }, (_, i) => `https://site${i}.com`);
  const content = urls.join(' ');

  const plan = planLinkPreviewFetch(content, {});

  assertEquals(plan.urls.length, 5);
  assertEquals(plan.urls, urls.slice(0, 5));
  assertEquals(plan.toFetch, urls.slice(0, 5));
});

Deno.test('planLinkPreviewFetch deduplicates in first-seen order before applying the cap', () => {
  const content = [
    'https://a.com',
    'https://a.com',
    'https://a.com',
    'https://b.com',
    'https://c.com',
    'https://d.com',
    'https://e.com',
    'https://f.com',
  ].join(' ');

  const plan = planLinkPreviewFetch(content, {});

  assertEquals(plan.urls, [
    'https://a.com',
    'https://b.com',
    'https://c.com',
    'https://d.com',
    'https://e.com',
  ]);
  assertEquals(plan.toFetch, plan.urls);
});

Deno.test('fetchLinkPreviewsForPlan fetches each deduplicated URL only once', async () => {
  const calls: string[] = [];
  const plan = planLinkPreviewFetch('https://a.com https://a.com https://b.com', {});

  await fetchLinkPreviewsForPlan(plan, async (url) => {
    calls.push(url);
    return url;
  });

  assertEquals(calls, ['https://a.com', 'https://b.com']);
});

// ── fetchLinkPreviewsForPlan ─────────────────────────────────────────────

Deno.test('fetchLinkPreviewsForPlan merges fetched titles with preserved entries', async () => {
  const plan = {
    urls: ['https://a.com', 'https://b.com'],
    toFetch: ['https://b.com'],
    preserved: { 'https://a.com': { title: 'A Site', fetchedAt: '2026-07-01T00:00:00Z' } },
  };

  const merged = await fetchLinkPreviewsForPlan(plan, async (url) =>
    url === 'https://b.com' ? 'B Site' : null,
  );

  assertEquals(merged['https://a.com'].title, 'A Site');
  assertEquals(merged['https://b.com'].title, 'B Site');
  assertEquals(typeof merged['https://b.com'].fetchedAt, 'string');
});

Deno.test('fetchLinkPreviewsForPlan writes title: null for a fetch that resolves null', async () => {
  const plan = { urls: ['https://a.com'], toFetch: ['https://a.com'], preserved: {} };

  const merged = await fetchLinkPreviewsForPlan(plan, async () => null);

  assertEquals(merged['https://a.com'].title, null);
});

Deno.test('fetchLinkPreviewsForPlan writes title: null (never throws) when a fetch rejects', async () => {
  const plan = { urls: ['https://a.com'], toFetch: ['https://a.com'], preserved: {} };

  const merged = await fetchLinkPreviewsForPlan(plan, async () => {
    throw new Error('boom');
  });

  assertEquals(merged['https://a.com'].title, null);
});

Deno.test('fetchLinkPreviewsForPlan against the real fetchPageTitle (mocked fetch + DNS)', async () => {
  const originalFetch = globalThis.fetch;
  const originalResolveDns = Deno.resolveDns;

  // deno-lint-ignore no-explicit-any
  (Deno as any).resolveDns = async (_hostname: string, recordType: string) =>
    recordType === 'A' ? ['93.184.216.34'] : [];

  globalThis.fetch = (() =>
    Promise.resolve(
      new Response('<title>Example Domain</title>', {
        status: 200,
        headers: { 'content-type': 'text/html' },
      }),
    )) as typeof fetch;

  try {
    const plan = { urls: ['https://example.com'], toFetch: ['https://example.com'], preserved: {} };
    const merged = await fetchLinkPreviewsForPlan(plan);
    assertEquals(merged['https://example.com'].title, 'Example Domain');
  } finally {
    globalThis.fetch = originalFetch;
    // deno-lint-ignore no-explicit-any
    (Deno as any).resolveDns = originalResolveDns;
  }
});

// ── normalizeLinkPreviews ────────────────────────────────────────────────

Deno.test('normalizeLinkPreviews passes through well-formed entries', () => {
  const raw = { 'https://a.com': { title: 'A', fetchedAt: '2026-07-01T00:00:00Z' } };
  assertEquals(normalizeLinkPreviews(raw), raw);
});

Deno.test('normalizeLinkPreviews treats malformed entries as absent', () => {
  const raw = {
    'https://a.com': { title: 'A', fetchedAt: '2026-07-01T00:00:00Z' },
    'https://b.com': { title: 42 }, // wrong type, no fetchedAt
    'https://c.com': 'not an object',
    'https://d.com': null,
  };

  assertEquals(normalizeLinkPreviews(raw), {
    'https://a.com': { title: 'A', fetchedAt: '2026-07-01T00:00:00Z' },
  });
});

Deno.test('normalizeLinkPreviews handles non-object input (null, array, string)', () => {
  assertEquals(normalizeLinkPreviews(null), {});
  assertEquals(normalizeLinkPreviews(undefined), {});
  assertEquals(normalizeLinkPreviews([]), {});
  assertEquals(normalizeLinkPreviews('oops'), {});
});

// ── writeLinkPreviewsIfContentUnchanged ──────────────────────────────────

Deno.test('writeLinkPreviewsIfContentUnchanged writes when content still matches the snapshot', async () => {
  const observation: ConditionalUpdateObservation = { filters: [] };
  const client = fakeConditionalUpdateClient(observation);

  const linkPreviews: LinkPreviewMap = {
    'https://a.com': { title: 'A Site', fetchedAt: '2026-07-01T00:00:00Z' },
  };

  const wrote = await writeLinkPreviewsIfContentUnchanged(
    client as never,
    MEMORY_ID,
    linkPreviews,
    'Hello https://a.com',
  );

  assertEquals(wrote, true);
  assertEquals(observation.payload, { link_previews: linkPreviews });
  assertEquals(observation.filters, [
    { kind: 'eq', column: 'id', value: MEMORY_ID },
    { kind: 'eq', column: 'content', value: 'Hello https://a.com' },
  ]);
  assertEquals(observation.selectedColumns, 'id');
});

Deno.test('writeLinkPreviewsIfContentUnchanged reports a concurrent content edit as no write', async () => {
  const observation: ConditionalUpdateObservation = { filters: [] };
  const client = fakeConditionalUpdateClient(observation, { didMatch: false });

  const wrote = await writeLinkPreviewsIfContentUnchanged(
    client as never,
    MEMORY_ID,
    { 'https://a.com': { title: 'A Site', fetchedAt: '2026-07-01T00:00:00Z' } },
    'Original content with https://a.com',
  );

  assertEquals(wrote, false);
  assertEquals(observation.filters, [
    { kind: 'eq', column: 'id', value: MEMORY_ID },
    { kind: 'eq', column: 'content', value: 'Original content with https://a.com' },
  ]);
});

Deno.test('writeLinkPreviewsIfContentUnchanged reports a disappeared memory as no write', async () => {
  const observation: ConditionalUpdateObservation = { filters: [] };
  const client = fakeConditionalUpdateClient(observation, { didMatch: false });

  const wrote = await writeLinkPreviewsIfContentUnchanged(
    client as never,
    MEMORY_ID,
    {},
    'anything',
  );

  assertEquals(wrote, false);
});

Deno.test('writeLinkPreviewsIfContentUnchanged uses IS NULL for a null content snapshot', async () => {
  const observation: ConditionalUpdateObservation = { filters: [] };
  const client = fakeConditionalUpdateClient(observation);

  const wrote = await writeLinkPreviewsIfContentUnchanged(client as never, MEMORY_ID, {}, null);

  assertEquals(wrote, true);
  assertEquals(observation.filters, [
    { kind: 'eq', column: 'id', value: MEMORY_ID },
    { kind: 'is', column: 'content', value: null },
  ]);
});
