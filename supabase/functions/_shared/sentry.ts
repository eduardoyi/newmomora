// Error reporting for Edge Functions (docs/features/observability.md).
//
// Every function's entrypoint calls `serveWithSentry('<function-name>',
// handler)` instead of `Deno.serve(handler)`. When the SENTRY_DSN secret is
// set, that reports:
//   - uncaught exceptions thrown by the handler (then rethrown, so the
//     runtime's own 500 behavior is unchanged), and
//   - every `console.error(...)` -- the codebase's convention for handled
//     failures (e.g. a PostgREST error mapped to a 500), which would
//     otherwise only ever reach the Supabase log viewer.
// Without SENTRY_DSN (local dev, tests, CI) it is a plain Deno.serve.
//
// Privacy: no request/response bodies, headers, IPs or user data are
// attached (default integrations off; the Deno SDK has no request-data
// integration to begin with). Code must keep
// following the existing rule of never logging memory content, names or
// tokens in console.error -- those messages now leave the platform.
import * as Sentry from 'npm:@sentry/deno@11.0.0';

type Handler = (request: Request, info: Deno.ServeHandlerInfo) => Response | Promise<Response>;

let enabled: boolean | null = null;

function ensureInitialized(functionName: string): boolean {
  if (enabled !== null) return enabled;
  const dsn = Deno.env.get('SENTRY_DSN');
  enabled = Boolean(dsn);
  if (!dsn) return false;
  Sentry.init({
    dsn,
    environment: Deno.env.get('SENTRY_ENVIRONMENT') ?? 'production',
    // Nothing automatic: no request data, breadcrumbs of other calls, or
    // global handlers that could attach PII. Only what's listed here.
    defaultIntegrations: false,
    integrations: [Sentry.captureConsoleIntegration({ levels: ['error'] })],
    tracesSampleRate: 0,
    // Each Edge Function runs in its own isolate, so a global tag is safe.
    initialScope: { tags: { function: functionName, runtime: 'supabase-edge' } },
  });
  return true;
}

function waitUntil(task: Promise<unknown>): void {
  const runtime = (globalThis as unknown as { EdgeRuntime?: { waitUntil?: (task: Promise<unknown>) => void } })
    .EdgeRuntime;
  if (runtime?.waitUntil) runtime.waitUntil(task);
  else void task;
}

/** `Deno.serve(handler)`, reporting errors to Sentry when SENTRY_DSN is set. */
export function serveWithSentry(functionName: string, handler: Handler): Deno.HttpServer {
  if (!ensureInitialized(functionName)) return Deno.serve(handler);

  return Deno.serve(async (request, info) => {
    try {
      return await handler(request, info);
    } catch (error) {
      Sentry.captureException(error);
      throw error;
    } finally {
      // Deliver anything captured during this request before the isolate
      // can be frozen; waitUntil keeps it alive without delaying the response.
      waitUntil(Sentry.flush(2000));
    }
  });
}
