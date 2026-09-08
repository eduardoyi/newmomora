import { describe, expect, it } from 'vitest';
import { createFakeR2Client } from './fakeR2';
import { claimRunning, readStatus, writeDone, writeFailed } from '../src/status';

/** Status transitions (task brief: "status transitions") — pending -> running -> done, and -> failed, plus the retry-after-failed path `render.ts`'s `acceptRenderRequest` relies on. */
describe('status transitions', () => {
  const orderId = 'order-1';
  const attemptId = 'attempt-1';

  it('pending (no marker) -> running (claimRunning) -> done (writeDone)', async () => {
    const client = createFakeR2Client();

    expect(await readStatus(client, orderId, attemptId)).toBeNull(); // pending

    const claim = await claimRunning(client, orderId, attemptId);
    expect(claim.claimed).toBe(true);
    const running = await readStatus(client, orderId, attemptId);
    expect(running?.status).toBe('running');

    const done = await writeDone(client, orderId, attemptId, { pageCount: 122, checksums: { interior: 'a', cover: 'b' } });
    expect(done.status).toBe('done');
    const readBack = await readStatus(client, orderId, attemptId);
    expect(readBack).toEqual(done);
  });

  it('running -> failed (writeFailed), and a fresh claimRunning after a failure succeeds (not sticky)', async () => {
    const client = createFakeR2Client();
    await claimRunning(client, orderId, attemptId);
    const failed = await writeFailed(client, orderId, attemptId, 'font hard-fail: Newsreader 400 not loaded');
    expect(failed).toMatchObject({ status: 'failed', reason: 'font hard-fail: Newsreader 400 not loaded' });

    const retryClaim = await claimRunning(client, orderId, attemptId);
    expect(retryClaim.claimed).toBe(true);
  });

  it('a second claimRunning for the SAME attemptId while the first is still running is rejected (the conditional-PUT idempotency check)', async () => {
    const client = createFakeR2Client();
    const first = await claimRunning(client, orderId, attemptId);
    const second = await claimRunning(client, orderId, attemptId);
    expect(first.claimed).toBe(true);
    expect(second.claimed).toBe(false);
    expect(second.claimed === false && second.existing?.status).toBe('running');
  });

  it('scopes status by BOTH orderId and attemptId — a different orderId with the same attemptId is a distinct marker', async () => {
    const client = createFakeR2Client();
    await claimRunning(client, 'order-a', attemptId);
    expect(await readStatus(client, 'order-b', attemptId)).toBeNull();
  });
});
