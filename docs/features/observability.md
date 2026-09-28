# Feature: Observability (error reporting + CI)

**Status:** server-side `done` · app crash reporting `wired, ships in 1.4.2`
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
| `momora-app` | React Native | The Expo app (store builds ≥ 1.4.2) | DSN is not secret — constant in `src/lib/sentry.ts` |

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

## App crash reporting

`@sentry/react-native` includes a native module, so it only exists in store
builds from **1.4.2** on (1.4.1 iOS / 1.4.0 Android don't have it).

| Piece | File |
|-------|------|
| Guarded init + scrubbing | `src/lib/sentry.ts` (`initSentry`, `captureException`) |
| Called from | `app/_layout.tsx` — `initSentry()` at module scope; the exported `ErrorBoundary` reports render errors (they never reach the global handler), then renders expo-router's boundary |
| Native config | `app.json` plugin `@sentry/react-native/expo` (org `momora`, project `momora-app`) |
| Source-map debug IDs | `metro.config.js` → `getSentryExpoConfig` |

Rules:

- **Never import `@sentry/react-native` at module scope.** `initSentry()`
  requires it only after `TurboModuleRegistry.get('RNSentry')` /
  `NativeModules.RNSentry` confirms the native module, so OTA updates that
  still reach older binaries stay a no-op instead of crashing. Also off in
  `__DEV__` and on web.
- The DSN is a constant in code (overridable by `EXPO_PUBLIC_SENTRY_DSN`) so
  OTA bundles carry it; `environment` comes from `EXPO_PUBLIC_APP_ENV`.
- Reported: native crashes, uncaught JS errors, unhandled rejections, render
  errors caught by the root `ErrorBoundary`. Release health sessions are on
  (crash-free rate). No console capture — the app doesn't use `console.error`
  for handled failures.
- Privacy: `sendDefaultPii: false`, no tracing/replay/profiling, no
  screenshots or view hierarchy, `event.user` dropped. Breadcrumbs keep only
  `navigation` and network (`fetch`/`xhr`/`http`) with URL, method and status —
  **query strings stripped** (signed media URLs carry tokens); console and
  touch breadcrumbs (accessibility labels can contain names) are dropped.

Source maps: store builds upload them (and iOS dSYMs / Android mappings)
during the EAS build using the EAS secret `SENTRY_AUTH_TOKEN` (a Sentry
organization auth token) — **the build fails without it** (or set
`SENTRY_DISABLE_AUTO_UPLOAD=true` to skip). After an `eas update`, upload that
update's maps with:

```bash
SENTRY_AUTH_TOKEN=… npx sentry-expo-upload-sourcemaps dist
```
