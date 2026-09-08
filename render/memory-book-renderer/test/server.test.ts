import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createServer } from '../src/server';
import { sign } from '../src/crypto';
import { createFakeR2Client } from './fakeR2';
import { claimRunning, readStatus, writeDone } from '../src/status';
import { makeElement, makeManifest, makeOutline } from '../../../book-renderer/src/model/__tests__/fixtures/build';
import { parseManifest, parseOutline } from '../../../book-renderer/src/model/loader';
import type { RenderWorkerEnv } from '../src/env';
import { randomUUID } from 'node:crypto';

/**
 * HTTP-level contract tests (task brief: "/fit contract", "/render
 * idempotency + 409-on-concurrent (R2 mocked)", "status transitions") — a
 * real `node:http` server (`createServer`) with a real HMAC round-trip
 * (`sign()`/`verifySignedBody`) but an in-memory fake `R2Client` (no real
 * bucket, no network — see `test/fakeR2.ts`).
 */

const HMAC_SECRET = 'test-hmac-secret';

function testEnv(overrides: Partial<RenderWorkerEnv> = {}): RenderWorkerEnv {
  return {
    port: 0,
    hmacSecret: HMAC_SECRET,
    r2: { accountId: 'a', accessKeyId: 'b', secretAccessKey: 'c', endpoint: 'https://example.com', bucket: 'test-bucket' },
    servedDistDir: '/nonexistent/dist-print',
    concurrency: 1,
    ...overrides,
  };
}

/** A real, fully valid book (same fixture `fitBookForPrint.test.ts` uses for
 * its own "real books" suite — skipped, not failed, when `book-data/` isn't
 * present locally, same tolerance that file documents). `/fit` never
 * touches Puppeteer either way (fitBookForPrint is pure Node), so this stays
 * a fast contract test — it's just genuinely fit-able, unlike a hand-rolled
 * synthetic outline/manifest (an empty manifest's `cover` element does not,
 * on its own, resolve to a cover-wrap page). */
const BOOK_DATA_DIR = resolve(process.cwd(), '..', '..', 'book-renderer', 'book-data');
const REAL_BOOK_SLUG = 'enzo-year-three';
const realManifestPath = resolve(BOOK_DATA_DIR, REAL_BOOK_SLUG, 'manifest.json');
const realOutlinePath = resolve(BOOK_DATA_DIR, REAL_BOOK_SLUG, 'book.outline.json');
const realBookAvailable = existsSync(realManifestPath) && existsSync(realOutlinePath);

function validBookDocument() {
  return {
    outline: parseOutline(JSON.parse(readFileSync(realOutlinePath, 'utf8'))),
    manifest: parseManifest(JSON.parse(readFileSync(realManifestPath, 'utf8'))),
  };
}

/** Deliberately fit-INVALID (no cover-producing element at all) — used by
 * the /render accept/idempotency tests, which only care about the
 * synchronous 202/200/409 response and the background job's fast, pure-JS
 * failure path (see fit.ts/render.ts's own header comments) — never reaches
 * Puppeteer/the static file server, so these tests stay fast and hermetic. */
function unfitableBookDocument() {
  return {
    outline: makeOutline([makeElement({ id: 'backbone:x', kind: 'backbone', memoryIds: [] })]),
    manifest: makeManifest({}),
  };
}

async function request(
  baseUrl: string,
  method: string,
  path: string,
  options: { body?: unknown; auth?: boolean } = {},
): Promise<Response> {
  const rawBody = options.body !== undefined ? JSON.stringify(options.body) : '';
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (options.auth !== false) {
    Object.assign(headers, await sign(HMAC_SECRET, rawBody));
  }
  return fetch(`${baseUrl}${path}`, { method, headers, body: rawBody.length > 0 ? rawBody : undefined });
}

describe('render worker HTTP server', () => {
  let server: ReturnType<typeof createServer>;
  let baseUrl: string;
  let r2: ReturnType<typeof createFakeR2Client>;
  let env: RenderWorkerEnv;

  beforeEach(async () => {
    r2 = createFakeR2Client();
    env = testEnv();
    server = createServer(env, r2);
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const address = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  describe('GET /health', () => {
    it('is open (no HMAC required) and returns ok:true', async () => {
      const res = await request(baseUrl, 'GET', '/health', { auth: false });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: true });
    });
  });

  describe('POST /fit — contract', () => {
    it('rejects an unsigned request with 401', async () => {
      const res = await request(baseUrl, 'POST', '/fit', { body: { bookDocument: unfitableBookDocument() }, auth: false });
      expect(res.status).toBe(401);
    });

    it('rejects a malformed body with 400', async () => {
      const res = await request(baseUrl, 'POST', '/fit', { body: { nope: true } });
      expect(res.status).toBe(400);
    });

    (realBookAvailable ? it : it.skip)('returns {pageCount} for a valid signed request', async () => {
      const res = await request(baseUrl, 'POST', '/fit', { body: { bookDocument: validBookDocument(), spineMm: 28 } });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { pageCount: number };
      expect(typeof body.pageCount).toBe('number');
      expect(body.pageCount).toBeGreaterThan(0);
      expect(body.pageCount % 2).toBe(0);
    });

    it('/fit never touches R2, success or failure', async () => {
      await request(baseUrl, 'POST', '/fit', { body: { bookDocument: unfitableBookDocument() } });
      expect(r2.objects.size).toBe(0);
    });
  });

  describe('POST /render — idempotency + 409-on-concurrent (R2 mocked)', () => {
    it('rejects an unsigned request with 401', async () => {
      const res = await request(baseUrl, 'POST', '/render', {
        body: { orderId: randomUUID(), attemptId: randomUUID(), bookDocument: unfitableBookDocument(), spineMm: 20 },
        auth: false,
      });
      expect(res.status).toBe(401);
    });

    it('rejects a malformed body (missing spineMm) with 400', async () => {
      const res = await request(baseUrl, 'POST', '/render', {
        body: { orderId: randomUUID(), attemptId: randomUUID(), bookDocument: unfitableBookDocument() },
      });
      expect(res.status).toBe(400);
    });

    it('accepts a fresh attemptId with 202, and the background job persists a failed status for an unfitable document', async () => {
      const orderId = randomUUID();
      const attemptId = randomUUID();
      const res = await request(baseUrl, 'POST', '/render', {
        body: { orderId, attemptId, bookDocument: unfitableBookDocument(), spineMm: 20 },
      });
      expect(res.status).toBe(202);
      expect(await res.json()).toEqual({ accepted: true, orderId, attemptId });

      // The background job is fire-and-forget (see render.ts's own doc
      // comment) — poll the fake store briefly rather than assuming a fixed
      // delay is enough (it should be near-instant: fitBookForPrint throws
      // synchronously, no I/O).
      const status = await pollUntil(() => readStatus(r2, orderId, attemptId), (s) => s?.status === 'failed');
      expect(status?.status).toBe('failed');
    });

    it('returns 409 with the existing status when a "running" marker already exists for this attemptId', async () => {
      const orderId = randomUUID();
      const attemptId = randomUUID();
      await claimRunning(r2, orderId, attemptId);

      const res = await request(baseUrl, 'POST', '/render', {
        body: { orderId, attemptId, bookDocument: unfitableBookDocument(), spineMm: 20 },
      });
      expect(res.status).toBe(409);
      const body = (await res.json()) as { error: string; status: { status: string } };
      expect(body.error).toBe('RENDER_IN_PROGRESS');
      expect(body.status.status).toBe('running');
    });

    it('returns the done status idempotently (200, not 202) when the attemptId already completed', async () => {
      const orderId = randomUUID();
      const attemptId = randomUUID();
      await writeDone(r2, orderId, attemptId, { pageCount: 42, checksums: { interior: 'x', cover: 'y' } });

      const res = await request(baseUrl, 'POST', '/render', {
        body: { orderId, attemptId, bookDocument: unfitableBookDocument(), spineMm: 20 },
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { status: string; pageCount: number };
      expect(body.status).toBe('done');
      expect(body.pageCount).toBe(42);
    });
  });

  describe('GET /status/:attemptId', () => {
    it('rejects an unsigned request with 401', async () => {
      const attemptId = randomUUID();
      const res = await request(baseUrl, 'GET', `/status/${attemptId}?orderId=${randomUUID()}`, { auth: false });
      expect(res.status).toBe(401);
    });

    it('returns pending when nothing has been written for this attemptId', async () => {
      const res = await request(baseUrl, 'GET', `/status/${randomUUID()}?orderId=${randomUUID()}`);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ status: 'pending' });
    });

    it('returns the running/done/failed status once one exists', async () => {
      const orderId = randomUUID();
      const attemptId = randomUUID();
      await claimRunning(r2, orderId, attemptId);
      const res = await request(baseUrl, 'GET', `/status/${attemptId}?orderId=${orderId}`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { status: string };
      expect(body.status).toBe('running');
    });

    it('rejects a malformed attemptId/orderId with 400 (id-injection guard — these are used to build R2 keys)', async () => {
      const res = await request(baseUrl, 'GET', `/status/not-a-uuid?orderId=also-not-a-uuid`);
      expect(res.status).toBe(400);
    });
  });
});

async function pollUntil<T>(read: () => Promise<T>, done: (value: T) => boolean, timeoutMs = 5000): Promise<T> {
  const start = Date.now();
  for (;;) {
    const value = await read();
    if (done(value)) return value;
    if (Date.now() - start > timeoutMs) return value;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}
