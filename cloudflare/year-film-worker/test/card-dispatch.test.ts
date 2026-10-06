import { describe, expect, it, vi } from 'vitest';
import { hmacSha256Hex } from '../src/crypto';
import { handleCardGenerate, handleDispatch } from '../src/index';
import type { Env } from '../src/types';
import { startFilmWorkflow } from '../src/util';

const SECRET = 'test-dispatch-secret';
const CARD = '11111111-1111-4111-8111-111111111111';
const ATTEMPT = '22222222-2222-4222-8222-222222222222';

async function signed(body: unknown, options: { secret?: string; timestamp?: string; nonce?: string } = {}): Promise<Request> {
  const raw = typeof body === 'string' ? body : JSON.stringify(body);
  const timestamp = options.timestamp ?? String(Date.now());
  const nonce = options.nonce ?? crypto.randomUUID();
  const signature = await hmacSha256Hex(options.secret ?? SECRET, `${timestamp}.${nonce}.${raw}`);
  return new Request('https://worker.example.test/holiday-cards/generate', {
    method: 'POST',
    headers: { 'x-dispatch-timestamp': timestamp, 'x-dispatch-nonce': nonce, 'x-dispatch-signature': signature },
    body: raw,
  });
}

function env(create: (options: unknown) => Promise<unknown>): Env {
  return {
    DISPATCH_SIGNING_SECRET: SECRET,
    HOLIDAY_CARD_WORKFLOW: { create },
    YEAR_FILM_WORKFLOW: { create: async () => { throw new Error('the card route must not start a film directly'); } },
  } as unknown as Env;
}

describe('POST /holiday-cards/generate', () => {
  it('starts one Workflow instance per attempt (instance id = attempt id) with ids only', async () => {
    const create = vi.fn(async () => ({}));
    const res = await handleCardGenerate(await signed({ cardId: CARD, attemptId: ATTEMPT }), env(create));
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ accepted: true });
    expect(create).toHaveBeenCalledWith({
      id: ATTEMPT,
      params: { cardId: CARD, attemptId: ATTEMPT },
      retention: { successRetention: '1 day', errorRetention: '1 day' },
    });
  });

  it('a retried dispatch of the same attempt is a 202 duplicate; other failures are 502', async () => {
    const dup = await handleCardGenerate(await signed({ cardId: CARD, attemptId: ATTEMPT }), env(async () => { throw new Error('instance.already_exists'); }));
    expect(dup.status).toBe(202);
    expect(await dup.json()).toEqual({ accepted: true, duplicate: true });
    const failed = await handleCardGenerate(await signed({ cardId: CARD, attemptId: ATTEMPT }), env(async () => { throw new Error('platform down'); }));
    expect(failed.status).toBe(502);
    expect(await failed.json()).toEqual({ error: 'Workflow dispatch failed', code: 'DISPATCH_FAILED' });
  });

  it('is authenticated exactly like /dispatch: same secret, same signed-body check', async () => {
    const create = vi.fn(async () => ({}));
    const bad = [
      await signed({ cardId: CARD, attemptId: ATTEMPT }, { secret: 'wrong' }),
      await signed({ cardId: CARD, attemptId: ATTEMPT }, { timestamp: String(Date.now() - 10 * 60_000) }),
      await signed({ cardId: CARD, attemptId: ATTEMPT }, { nonce: 'not-a-uuid' }),
      new Request('https://worker.example.test/holiday-cards/generate', { method: 'POST', body: JSON.stringify({ cardId: CARD, attemptId: ATTEMPT }) }),
    ];
    for (const request of bad) {
      expect((await handleCardGenerate(request, env(create))).status).toBe(401);
    }
    // A film dispatch body signed with the same secret is not a card payload.
    expect((await handleCardGenerate(await signed({ filmId: CARD, attemptId: ATTEMPT }), env(create))).status).toBe(400);
    expect(create).not.toHaveBeenCalled();
    // Same signature accepted by both handlers.
    const filmCreate = vi.fn(async () => ({}));
    const filmRes = await handleDispatch(await signed({ filmId: CARD, attemptId: ATTEMPT }), { DISPATCH_SIGNING_SECRET: SECRET, YEAR_FILM_WORKFLOW: { create: filmCreate } } as unknown as Env);
    expect(filmRes.status).toBe(202);
    expect(filmCreate).toHaveBeenCalledTimes(1);
  });

  it('rejects malformed payloads', async () => {
    const create = vi.fn(async () => ({}));
    for (const body of ['not json', {}, { cardId: 'nope', attemptId: ATTEMPT }, { cardId: CARD, attemptId: 5 }]) {
      const res = await handleCardGenerate(await signed(body), env(create));
      expect(res.status).toBe(400);
    }
    expect(create).not.toHaveBeenCalled();
  });
});

describe('card Workflow -> YearFilmWorkflow (direct binding start, no HTTP)', () => {
  const FILM = '33333333-3333-4333-8333-333333333333';
  const FILM_ATTEMPT = '44444444-4444-4444-8444-444444444444';

  it('creates the film instance exactly like /dispatch (id = film attempt id); a duplicate is success', async () => {
    const create = vi.fn(async () => ({}));
    await startFilmWorkflow({ create }, FILM, FILM_ATTEMPT);
    expect(create).toHaveBeenCalledWith({
      id: FILM_ATTEMPT,
      params: { filmId: FILM, attemptId: FILM_ATTEMPT },
      retention: { successRetention: '1 day', errorRetention: '1 day' },
    });
    await expect(startFilmWorkflow({ create: async () => { throw new Error('instance.already_exists'); } }, FILM, FILM_ATTEMPT)).resolves.toBeUndefined();
    await expect(startFilmWorkflow({ create: async () => { throw new Error('platform down'); } }, FILM, FILM_ATTEMPT)).rejects.toThrow('platform down');
  });
});
