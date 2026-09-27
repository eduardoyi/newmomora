// Error reporting (docs/features/observability.md). Mirrors the other
// Workers' copy of this file -- each Worker is its own bundle, so this is a
// small per-Worker copy rather than a shared import (repo convention).
//
// Enabled only when the SENTRY_DSN secret is set. Reports uncaught errors
// from fetch/scheduled/Workflow steps plus every console.error (the
// codebase's convention for handled failures). Privacy: request URLs keep
// only origin + path (download links carry their token in the query), and
// headers, cookies and bodies are never sent.
import * as Sentry from '@sentry/cloudflare';

export function sentryOptions(env: { SENTRY_DSN?: string }) {
  return {
    dsn: env.SENTRY_DSN,
    enabled: Boolean(env.SENTRY_DSN),
    environment: 'production',
    // One Sentry project covers every Worker; this says which one (Workflow
    // events have no request URL to tell them apart).
    initialScope: { tags: { worker: 'momora-export-worker' } },
    // (sendDefaultPii is always off in the Cloudflare SDK -- it rejects the option.)
    tracesSampleRate: 0,
    integrations: [Sentry.captureConsoleIntegration({ levels: ['error'] })],
    beforeSend(event: Sentry.ErrorEvent) {
      if (event.request) {
        const url = event.request.url ? event.request.url.split('?')[0] : undefined;
        event.request = { method: event.request.method, url };
      }
      return event;
    },
  };
}
