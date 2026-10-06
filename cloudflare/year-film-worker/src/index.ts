import * as Sentry from '@sentry/cloudflare';

import { verifySignedBody } from './crypto';
import { sentryOptions } from './sentry';
import { isDuplicate } from './util';
import { type CardGeneratePayload, type DispatchPayload, type Env, ID_PATTERN } from './types';
import { HolidayCardWorkflow } from './card-workflow';
import { YearFilmWorkflow } from './workflow';

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

/** Both signed routes (/dispatch and /holiday-cards/generate) authenticate the
 * same way: DISPATCH_SIGNING_SECRET over `${timestamp}.${nonce}.${body}`
 * (x-dispatch-timestamp / x-dispatch-nonce / x-dispatch-signature). */
function verifyDispatch(request: Request, env: Env, rawBody: string): Promise<boolean> {
  return verifySignedBody(
    env.DISPATCH_SIGNING_SECRET,
    request.headers.get('x-dispatch-timestamp'),
    request.headers.get('x-dispatch-nonce'),
    request.headers.get('x-dispatch-signature'),
    rawBody,
  );
}

export async function handleDispatch(request: Request, env: Env): Promise<Response> {
  const rawBody = await request.text();
  const verified = await verifyDispatch(request, env, rawBody);
  if (!verified) return response({ error: 'Unauthorized', code: 'UNAUTHORIZED' }, 401);

  let payload: Partial<DispatchPayload>;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return response({ error: 'Invalid JSON body', code: 'INVALID_BODY' }, 400);
  }
  if (typeof payload.filmId !== 'string' || !ID_PATTERN.test(payload.filmId) ||
    typeof payload.attemptId !== 'string' || !ID_PATTERN.test(payload.attemptId)) {
    return response({ error: 'Invalid dispatch payload', code: 'INVALID_BODY' }, 400);
  }

  try {
    // Instance id = attempt id: a retried dispatch of the same attempt is
    // idempotent; a new attempt gets its own instance.
    await env.YEAR_FILM_WORKFLOW.create({
      id: payload.attemptId,
      params: { filmId: payload.filmId, attemptId: payload.attemptId },
      retention: { successRetention: '1 day', errorRetention: '1 day' },
    });
    return response({ accepted: true }, 202);
  } catch (error) {
    if (isDuplicate(error)) return response({ accepted: true, duplicate: true }, 202);
    return response({ error: 'Workflow dispatch failed', code: 'DISPATCH_FAILED' }, 502);
  }
}

/** POST /holiday-cards/generate {cardId, attemptId}: starts one
 * HolidayCardWorkflow per generation attempt (instance id = attempt id, so a
 * retried dispatch of the same attempt is a 202 duplicate). The caller has
 * already written the card's lease (attempt_id, status 'generating'); the
 * Workflow's bridge calls refuse a card that is deleted or on another attempt. */
export async function handleCardGenerate(request: Request, env: Env): Promise<Response> {
  const rawBody = await request.text();
  const verified = await verifyDispatch(request, env, rawBody);
  if (!verified) return response({ error: 'Unauthorized', code: 'UNAUTHORIZED' }, 401);

  let payload: Partial<CardGeneratePayload>;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return response({ error: 'Invalid JSON body', code: 'INVALID_BODY' }, 400);
  }
  if (typeof payload.cardId !== 'string' || !ID_PATTERN.test(payload.cardId) ||
    typeof payload.attemptId !== 'string' || !ID_PATTERN.test(payload.attemptId)) {
    return response({ error: 'Invalid generate payload', code: 'INVALID_BODY' }, 400);
  }

  try {
    await env.HOLIDAY_CARD_WORKFLOW.create({
      id: payload.attemptId,
      params: { cardId: payload.cardId, attemptId: payload.attemptId },
      retention: { successRetention: '1 day', errorRetention: '1 day' },
    });
    return response({ accepted: true }, 202);
  } catch (error) {
    if (isDuplicate(error)) return response({ accepted: true, duplicate: true }, 202);
    return response({ error: 'Workflow dispatch failed', code: 'DISPATCH_FAILED' }, 502);
  }
}

export default Sentry.withSentry(sentryOptions, {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === 'GET' && url.pathname === '/health') return response({ ok: true });
    if (request.method === 'POST' && url.pathname === '/dispatch') return handleDispatch(request, env);
    if (request.method === 'POST' && url.pathname === '/holiday-cards/generate') return handleCardGenerate(request, env);
    return response({ error: 'Not found', code: 'NOT_FOUND' }, 404);
  },
});

const InstrumentedYearFilmWorkflow = Sentry.instrumentWorkflowWithSentry(sentryOptions, YearFilmWorkflow);
export { InstrumentedYearFilmWorkflow as YearFilmWorkflow };

const InstrumentedHolidayCardWorkflow = Sentry.instrumentWorkflowWithSentry(sentryOptions, HolidayCardWorkflow);
export { InstrumentedHolidayCardWorkflow as HolidayCardWorkflow };
