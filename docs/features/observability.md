# Feature: Observability (error reporting + CI)

**Status:** server-side `done` · app crash reporting `planned (next native build)`
**Last updated:** 2026-09-27

## Why

The data export was broken in production for two months (a select named
columns that don't exist) and nothing reported it. Two safety nets now exist:

1. **CI** catches it before it ships — see [TESTING.md § Continuous integration](../TESTING.md#continuous-integration),
   including the `scripts/check-select-columns.mjs` schema contract.
2. **Sentry** reports it the moment it happens in production.

## Sentry layout

Organization `momora` (sentry.io, US region), team `#momora`:

| Project | Platform | Covers | DSN secret lives in |
|---------|----------|--------|---------------------|
| `momora-edge-functions` | Deno | All 61 Supabase Edge Functions | Supabase secret `SENTRY_DSN` |
| `momora-workers` | Cloudflare | Every Cloudflare Worker + their Workflows (tag `worker` names which) | Worker secret `SENTRY_DSN` on each Worker |
| `momora-app` | React Native | The Expo app | not wired yet — see below |

What gets reported, everywhere:

- **Uncaught exceptions** (then rethrown — runtime behavior unchanged).
- **Every `console.error(...)`** via `captureConsoleIntegration`. That is the
  codebase's convention for handled failures (a PostgREST error mapped to a
  500, a failed email, a Workflow step error), which is exactly the class
  that used to fail silently.

Performance tracing, session replay, logs and profiling are **off**.

## Privacy (child/family PII)

- Organization settings: **Enhanced Privacy on**, **Require Data Scrubber**,
  **Require Using Default Scrubbers**, **Prevent Storing of IP Addresses**.
  Global sensitive fields scrubbed server-side: `email`, `token`,
  `authorization`, `content`, `audio_transcript`, `caption`,
  `comment_snippet`, `memory_excerpt`.
- Edge Functions: default integrations off (no request data at all).
- Workers: `beforeSend` keeps only request method + origin/path — **query
  strings are dropped** (export download links carry their token there) and
  headers/cookies/bodies are never sent. `sendDefaultPii` is always off in the
  Cloudflare SDK.
- The existing rule still applies and now matters more: **never put memory
  content, names, emails or tokens in `console.error`** — those messages
  leave the platform.

## Code

| Surface | File | Hook |
|---------|------|------|
| Edge Functions | `supabase/functions/_shared/sentry.ts` | every `index.ts` calls `serveWithSentry('<name>', handler)` instead of `Deno.serve(handler)`; inert without `SENTRY_DSN`; flushes via `EdgeRuntime.waitUntil` |
| Workers | `<worker>/src/sentry.ts` (small per-Worker copy, repo convention) | `export default Sentry.withSentry(sentryOptions, handler)`; each Workflow class exported through `Sentry.instrumentWorkflowWithSentry(sentryOptions, Class)` |

Deployed with Sentry (2026-09-27): all Edge Functions and every Worker —
`momora-export-worker`, `momora-memory-book-order-worker`,
`momora-memory-book-web`, `momora-memory-book-worker`,
`momora-memory-illustration-worker`, `momora-kindle-frame`,
`momora-memory-viewer`.

## Adding a new Edge Function or Worker

- Edge Function: use `serveWithSentry('<function-name>', handler)`, never bare
  `Deno.serve`.
- Worker: copy `src/sentry.ts` from another Worker, set its `worker` tag,
  wrap the default export and every Workflow class, add `SENTRY_DSN` to
  `secrets.required` in `wrangler.jsonc` and `wrangler secret put SENTRY_DSN`
  (same DSN as the other Workers).

## App crash reporting (next native build)

`@sentry/react-native` includes a native module, so it ships with a store
build, not an OTA update. When wiring it: use the Expo config plugin, the
`momora-app` DSN (safe as an `EXPO_PUBLIC_` value), `sendDefaultPii: false`,
no replay/tracing, and **guard the import behind a native-module presence
check** so OTA updates reaching older binaries without the module can't crash.
Source maps need a Sentry auth token as an EAS secret.
