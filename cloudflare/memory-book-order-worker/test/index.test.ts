import { describe, expect, it, vi } from 'vitest';
import worker from '../src/index';
import { hmacSha256Hex } from '../src/crypto';

const ORDER_ID = '50abcc52-5c0d-4b7b-86d4-1b3a0a661112';
const ATTEMPT_ID = '50abcc52-5c0d-4b7b-86d4-1b3a0a661113';

describe('health check', () => {
  it('responds ok with no auth required', async () => {
    const response = await worker.fetch(new Request('https://order-worker.test/health'), {} as Env);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
  });
});

describe('dispatch endpoint authentication', () => {
  it('accepts a valid signed dispatch and treats a duplicate Workflow id as idempotent 202', async () => {
    const create = vi.fn()
      .mockResolvedValueOnce({ id: ATTEMPT_ID })
      .mockRejectedValueOnce(new Error('Workflow instance already exists'));
    const env = { DISPATCH_SIGNING_SECRET: 'dispatch-secret', MEMORY_BOOK_ORDER_WORKFLOW: { create } } as unknown as Env;
    const body = JSON.stringify({ orderId: ORDER_ID, attemptId: ATTEMPT_ID });
    const timestamp = String(Date.now());
    const nonce = '50abcc52-5c0d-4b7b-86d4-1b3a0a661114';
    const signature = await hmacSha256Hex('dispatch-secret', `${timestamp}.${nonce}.${body}`);
    const signedRequest = () => new Request('https://order-worker.test/dispatch', {
      method: 'POST',
      headers: {
        'x-dispatch-timestamp': timestamp,
        'x-dispatch-nonce': nonce,
        'x-dispatch-signature': signature,
      },
      body,
    });

    const first = await worker.fetch(signedRequest(), env);
    expect(first.status).toBe(202);
    expect(await first.json()).toEqual({ accepted: true, orderId: ORDER_ID, attemptId: ATTEMPT_ID });

    const second = await worker.fetch(signedRequest(), env);
    expect(second.status).toBe(202);
    expect((await second.json() as { duplicate: boolean }).duplicate).toBe(true);
    expect(create).toHaveBeenCalledWith({
      id: ATTEMPT_ID,
      params: { orderId: ORDER_ID, attemptId: ATTEMPT_ID },
      retention: { successRetention: '3 days', errorRetention: '7 days' },
    });
  });

  it('rejects a tampered signature before touching the Workflow binding', async () => {
    const create = vi.fn();
    const env = { DISPATCH_SIGNING_SECRET: 'dispatch-secret', MEMORY_BOOK_ORDER_WORKFLOW: { create } } as unknown as Env;
    const body = JSON.stringify({ orderId: ORDER_ID, attemptId: ATTEMPT_ID });
    const timestamp = String(Date.now());
    const nonce = '50abcc52-5c0d-4b7b-86d4-1b3a0a661115';
    const signature = await hmacSha256Hex('dispatch-secret', `${timestamp}.${nonce}.${body}`);
    const response = await worker.fetch(new Request('https://order-worker.test/dispatch', {
      method: 'POST',
      headers: {
        'x-dispatch-timestamp': timestamp,
        'x-dispatch-nonce': nonce,
        'x-dispatch-signature': signature.slice(0, -1) + (signature.endsWith('0') ? '1' : '0'),
      },
      body,
    }), env);
    expect(response.status).toBe(401);
    expect(create).not.toHaveBeenCalled();
  });

  it('rejects a malformed orderId/attemptId body even when properly signed', async () => {
    const create = vi.fn();
    const env = { DISPATCH_SIGNING_SECRET: 'dispatch-secret', MEMORY_BOOK_ORDER_WORKFLOW: { create } } as unknown as Env;
    const body = JSON.stringify({ orderId: 'not-a-uuid', attemptId: ATTEMPT_ID });
    const timestamp = String(Date.now());
    const nonce = '50abcc52-5c0d-4b7b-86d4-1b3a0a661116';
    const signature = await hmacSha256Hex('dispatch-secret', `${timestamp}.${nonce}.${body}`);
    const response = await worker.fetch(new Request('https://order-worker.test/dispatch', {
      method: 'POST',
      headers: {
        'x-dispatch-timestamp': timestamp,
        'x-dispatch-nonce': nonce,
        'x-dispatch-signature': signature,
      },
      body,
    }), env);
    expect(response.status).toBe(400);
    expect(create).not.toHaveBeenCalled();
  });

  it('returns 404 for an unknown route', async () => {
    const response = await worker.fetch(new Request('https://order-worker.test/nope'), {} as Env);
    expect(response.status).toBe(404);
  });
});
