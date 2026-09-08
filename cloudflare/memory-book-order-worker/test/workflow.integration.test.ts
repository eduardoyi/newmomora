import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import type { WorkflowEvent, WorkflowStep } from 'cloudflare:workers';
import { MemoryBookOrderWorkflow } from '../src/workflow';
import type { Env, WorkflowDispatchPayload } from '../src/types';

const ORDER_ID = '50abcc52-5c0d-4b7b-86d4-1b3a0a661112';
const ATTEMPT_ID = '50abcc52-5c0d-4b7b-86d4-1b3a0a661113';

function fakeStep(): WorkflowStep {
  return {
    do: (async (_name: string, _config: unknown, callback: () => Promise<unknown>) => await callback()) as WorkflowStep['do'],
    sleep: (async (_name: string, _duration: unknown) => undefined) as WorkflowStep['sleep'],
  } as unknown as WorkflowStep;
}

function testEnv(): Env {
  return {
    ENVIRONMENT: 'test',
    SUPABASE_BRIDGE_URL: 'https://bridge.test/workflow-memory-book-order-bridge',
    DISPATCH_SIGNING_SECRET: 'dispatch-secret',
    SUPABASE_BRIDGE_HMAC_SECRET: 'bridge-secret',
    RENDER_WORKER_URL: 'https://render.test',
    RENDER_WORKER_HMAC_SECRET: 'render-secret',
    PRODIGI_API_BASE_URL: 'https://prodigi.test',
    PRODIGI_API_KEY: 'prodigi-key',
    PRODIGI_SKU: 'BOOK-FE-8_3-SQ-LF-G',
  } as unknown as Env;
}

function baseOrderContext(overrides: Record<string, unknown> = {}) {
  return {
    id: ORDER_ID,
    bookId: 'book-1',
    bookDocumentSnapshot: { outline: {}, manifest: {} },
    editsSnapshot: {},
    quotedPageCount: 118,
    priceCents: 4999,
    shippingCostCents: 1234,
    currency: 'usd',
    shippingAddress: { name: 'Ada Lovelace', line1: '1 Way', postalCode: 'X1', countryCode: 'GB' },
    ...overrides,
  };
}

interface Call { url: string; body: Record<string, unknown> | null }

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

/** Builds a fetch mock that routes by URL substring, recording every call
 * for assertions, and supports overriding any single response shape per
 * test via `overrides`. */
function buildFetchMock(overrides: {
  orderContext?: Record<string, unknown>;
  renderStates?: string[]; // sequential /status responses; /render itself always returns the FIRST of these (or 'accepted' if renderStates is polling-based)
  renderImmediateDone?: boolean;
} = {}) {
  const calls: Call[] = [];
  let statusCallIndex = 0;
  const renderStates = overrides.renderStates ?? ['done'];

  const fn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : (input as Request).url;
    const rawBody = init?.body ? String(init.body) : null;
    const body = rawBody ? JSON.parse(rawBody) as Record<string, unknown> : null;
    calls.push({ url, body });

    if (url.includes('bridge.test')) {
      switch (body?.operation) {
        case 'load_order':
          return jsonResponse({ order: overrides.orderContext ?? baseOrderContext() });
        case 'verify_and_presign_output':
          return jsonResponse({ interiorUrl: 'https://r2.test/interior.pdf', coverUrl: 'https://r2.test/cover.pdf', interiorSize: 1000, coverSize: 500 });
        case 'mark_submitted':
          return jsonResponse({ submitted: true });
        case 'mark_failed':
          return jsonResponse({ failed: true });
        case 'send_order_email':
          return jsonResponse({ sent: true });
        default:
          return jsonResponse({ error: 'unknown operation' }, 400);
      }
    }

    if (url.includes('render.test/fit')) {
      return jsonResponse({ pageCount: overrides.orderContext?.quotedPageCount ?? 118 });
    }
    if (url.includes('render.test/render')) {
      if (overrides.renderImmediateDone) {
        return jsonResponse({ status: 'done', keys: { interior: 'print-orders/order/interior.pdf', cover: 'print-orders/order/cover.pdf' }, checksums: { interior: 'sha-i', cover: 'sha-c' }, pageCount: overrides.orderContext?.quotedPageCount ?? 118 });
      }
      return jsonResponse({ accepted: true }, 202);
    }
    if (url.includes('render.test/status/')) {
      const state = renderStates[Math.min(statusCallIndex, renderStates.length - 1)];
      statusCallIndex += 1;
      if (state === 'done') {
        return jsonResponse({ status: 'done', keys: { interior: 'print-orders/order/interior.pdf', cover: 'print-orders/order/cover.pdf' }, checksums: { interior: 'sha-i', cover: 'sha-c' }, pageCount: overrides.orderContext?.quotedPageCount ?? 118 });
      }
      if (state === 'failed') {
        return jsonResponse({ status: 'failed', reason: 'PUPPETEER_CRASHED' });
      }
      return jsonResponse({ status: 'running', startedAt: 'x' });
    }
    if (url.includes('prodigi.test/v4.0/products/spine')) {
      return jsonResponse({ success: true, message: 'ok', spineInfo: { widthMm: 28 } });
    }
    if (url.includes('prodigi.test/v4.0/Orders')) {
      return jsonResponse({ order: { id: 'prodigi-order-1' } });
    }
    return jsonResponse({ error: 'unhandled url in test fetch mock: ' + url }, 500);
  });

  return { fn, calls };
}

beforeEach(() => {
  vi.useRealTimers();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function workflowWithEnv(env: Env): MemoryBookOrderWorkflow {
  const workflow = Object.create(MemoryBookOrderWorkflow.prototype) as MemoryBookOrderWorkflow;
  (workflow as unknown as { env: Env }).env = env;
  return workflow;
}

async function runWorkflow(env: Env, fetchImpl: typeof fetch) {
  vi.stubGlobal('fetch', fetchImpl);
  const event = { payload: { orderId: ORDER_ID, attemptId: ATTEMPT_ID } as WorkflowDispatchPayload } as unknown as Readonly<WorkflowEvent<WorkflowDispatchPayload>>;
  return await workflowWithEnv(env).run(event, fakeStep());
}

describe('memory book order workflow', () => {
  it('happy path: renders immediately-done, verifies, submits to Prodigi, and marks the order submitted', async () => {
    const { fn, calls } = buildFetchMock({ renderImmediateDone: true });
    const result = await runWorkflow(testEnv(), fn as unknown as typeof fetch);

    expect(result).toEqual({ orderId: ORDER_ID, status: 'submitted' });

    const markSubmittedCall = calls.find((c) => c.body?.operation === 'mark_submitted');
    expect(markSubmittedCall?.body?.orderId).toBe(ORDER_ID);
    expect(markSubmittedCall?.body?.prodigiOrderId).toBe('prodigi-order-1');

    const paidConfirmation = calls.find((c) => c.body?.operation === 'send_order_email' && c.body?.emailKind === 'paid_confirmation');
    expect(paidConfirmation).toBeTruthy();
    const ownerAlarm = calls.filter((c) => c.body?.operation === 'send_order_email' && c.body?.emailKind === 'owner_alarm');
    // Only the final spot-check alarm (with PDF links) -- no divergence
    // alarm since quotedPageCount matched the re-fit count.
    expect(ownerAlarm.length).toBe(1);
    expect((ownerAlarm[0]?.body?.pdfLinks as Record<string, unknown>)?.interiorUrl).toBe('https://r2.test/interior.pdf');

    const prodigiOrderCall = calls.find((c) => c.url.includes('prodigi.test/v4.0/Orders'));
    expect((prodigiOrderCall?.body?.items as unknown[])?.length).toBe(1);
  });

  it('polls /status through in_progress states before completing', async () => {
    const { fn, calls } = buildFetchMock({ renderStates: ['in_progress', 'in_progress', 'done'] });
    const result = await runWorkflow(testEnv(), fn as unknown as typeof fetch);

    expect(result).toEqual({ orderId: ORDER_ID, status: 'submitted' });
    const statusCalls = calls.filter((c) => c.url.includes('render.test/status/'));
    expect(statusCalls.length).toBe(3);
  });

  it('alarms on a page-count divergence but still completes the order using the FRESH count', async () => {
    // orderContext.quotedPageCount (118, the stale quote-time count) feeds
    // the render mock's /render + /status responses; overriding /fit alone
    // to 120 simulates the real-world divergence (a live book edited since
    // quoting) -- the render worker itself must have rendered at the FRESH
    // (120) count for the page-count sanity check (workflow.ts's
    // RenderOutputMismatchError guard) to pass, exactly like a correctly
    // functioning render worker would.
    const { fn, calls } = buildFetchMock({
      orderContext: baseOrderContext({ quotedPageCount: 120 }),
      renderImmediateDone: true,
    });
    const wrapped = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : (input as Request).url;
      if (url.includes('render.test/fit')) return new Response(JSON.stringify({ pageCount: 120 }), { status: 200, headers: { 'content-type': 'application/json' } });
      if (url.includes('bridge.test')) {
        const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : null;
        if (body?.operation === 'load_order') {
          return new Response(JSON.stringify({ order: baseOrderContext({ quotedPageCount: 118 }) }), { status: 200, headers: { 'content-type': 'application/json' } });
        }
      }
      return fn(input, init);
    });

    const result = await runWorkflow(testEnv(), wrapped as unknown as typeof fetch);
    expect(result).toEqual({ orderId: ORDER_ID, status: 'submitted' });

    const divergenceAlarm = calls.find((c) => c.body?.operation === 'send_order_email' && c.body?.emailKind === 'owner_alarm' && typeof c.body?.detail === 'string' && (c.body.detail as string).includes('diverged'));
    expect(divergenceAlarm).toBeTruthy();
  });

  it('marks the order failed and alarms the owner when the render worker reports failed', async () => {
    const { fn, calls } = buildFetchMock({ renderStates: ['failed'] });
    const result = await runWorkflow(testEnv(), fn as unknown as typeof fetch);

    expect(result).toEqual({ orderId: ORDER_ID, status: 'failed', code: 'RENDER_FAILED' });
    const markFailedCall = calls.find((c) => c.body?.operation === 'mark_failed');
    expect(markFailedCall?.body?.failureReason).toMatch(/^RENDER_FAILED/);
    const failureAlarm = calls.find((c) => c.body?.operation === 'send_order_email' && c.body?.emailKind === 'owner_alarm');
    expect(failureAlarm).toBeTruthy();
  });

  it('marks the order failed when the bridge reports the attempt is superseded', async () => {
    const fn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : (input as Request).url;
      const body = init?.body ? JSON.parse(String(init.body)) : null;
      if (url.includes('bridge.test')) {
        if (body?.operation === 'load_order') return new Response(JSON.stringify({ error: 'Order attempt is no longer current', code: 'ORDER_SUPERSEDED' }), { status: 409 });
        return jsonResponse({ failed: true, sent: true });
      }
      return jsonResponse({ error: 'unexpected call' }, 500);
    });

    const result = await runWorkflow(testEnv(), fn as unknown as typeof fetch);
    expect(result).toEqual({ orderId: ORDER_ID, status: 'failed', code: 'ORDER_LOAD_FAILED' });
  });

  it('marks the order failed when Prodigi order submission errors', async () => {
    const { fn } = buildFetchMock({ renderImmediateDone: true });
    const wrapped = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : (input as Request).url;
      if (url.includes('prodigi.test/v4.0/Orders')) return new Response(JSON.stringify({ message: 'invalid recipient' }), { status: 400 });
      return fn(input, init);
    });

    const result = await runWorkflow(testEnv(), wrapped as unknown as typeof fetch);
    expect(result).toEqual({ orderId: ORDER_ID, status: 'failed', code: 'PRODIGI_SUBMIT_FAILED' });
  });
});
