import * as Sentry from '@sentry/cloudflare';

import { verifySignedBody } from './crypto';
import { sentryOptions } from './sentry';
import { type DispatchPayload, type Env, ID_PATTERN } from './types';
import { YearFilmWorkflow } from './workflow';

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function isDuplicate(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /already exists|duplicate|unique/i.test(message);
}

export async function handleDispatch(request: Request, env: Env): Promise<Response> {
  const rawBody = await request.text();
  const verified = await verifySignedBody(
    env.DISPATCH_SIGNING_SECRET,
    request.headers.get('x-dispatch-timestamp'),
    request.headers.get('x-dispatch-nonce'),
    request.headers.get('x-dispatch-signature'),
    rawBody,
  );
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

export default Sentry.withSentry(sentryOptions, {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === 'GET' && url.pathname === '/health') return response({ ok: true });
    if (request.method === 'POST' && url.pathname === '/dispatch') return handleDispatch(request, env);
    return response({ error: 'Not found', code: 'NOT_FOUND' }, 404);
  },
});

const InstrumentedYearFilmWorkflow = Sentry.instrumentWorkflowWithSentry(sentryOptions, YearFilmWorkflow);
export { InstrumentedYearFilmWorkflow as YearFilmWorkflow };
