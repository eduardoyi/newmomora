// App crash reporting (docs/features/observability.md).
//
// @sentry/react-native ships a native module, so it only exists in store
// builds from 1.4.2 on. OTA updates can still reach older binaries (1.4.1
// iOS / 1.4.0 Android) that lack it, so the SDK is only required after the
// native module is confirmed present -- never imported at module scope.
//
// Privacy (child/family PII): no default PII, no tracing/replay/profiling,
// no screenshots or view hierarchy, no console or touch breadcrumbs (touch
// breadcrumbs carry accessibility labels, which can contain names), and URLs
// lose their query strings (signed media URLs carry tokens there).
import { NativeModules, Platform, TurboModuleRegistry } from 'react-native';

type SentryModule = typeof import('@sentry/react-native');
type SentryEvent = Parameters<NonNullable<Parameters<SentryModule['init']>[0]['beforeSend']>>[0];
type SentryBreadcrumb = Parameters<NonNullable<Parameters<SentryModule['init']>[0]['beforeBreadcrumb']>>[0];

// The momora-app project DSN. Not a secret (it only permits sending events),
// and kept in code so OTA bundles carry it too -- EAS Update doesn't read the
// build profile's env from eas.json.
const MOMORA_APP_DSN = 'https://76ab349613bf25de92452dc0a25ec2d8@o4512160102547456.ingest.us.sentry.io/4512160114540544';

let sentry: SentryModule | null = null;

const KEPT_BREADCRUMB_CATEGORIES = new Set(['navigation', 'fetch', 'xhr', 'http']);

export function hasNativeSentryModule(): boolean {
  try {
    return Boolean(TurboModuleRegistry.get('RNSentry') ?? NativeModules.RNSentry);
  } catch {
    return false;
  }
}

export function stripQuery(url: string): string {
  const cut = url.search(/[?#]/);
  return cut === -1 ? url : url.slice(0, cut);
}

export function scrubEvent<T extends SentryEvent>(event: T): T {
  delete event.user;
  if (event.request) {
    event.request = event.request.url ? { url: stripQuery(event.request.url) } : undefined;
  }
  return event;
}

export function scrubBreadcrumb(breadcrumb: SentryBreadcrumb): SentryBreadcrumb | null {
  if (!breadcrumb.category || !KEPT_BREADCRUMB_CATEGORIES.has(breadcrumb.category)) return null;
  const data = breadcrumb.data;
  if (!data) return breadcrumb;
  const kept: Record<string, unknown> = {};
  if (typeof data.url === 'string') kept.url = stripQuery(data.url);
  if (typeof data.method === 'string') kept.method = data.method;
  if (typeof data.status_code === 'number') kept.status_code = data.status_code;
  if (typeof data.from === 'string') kept.from = stripQuery(data.from);
  if (typeof data.to === 'string') kept.to = stripQuery(data.to);
  return { ...breadcrumb, data: kept };
}

/** Starts crash reporting when this binary has the native SDK; otherwise a no-op. */
export function initSentry(): void {
  const dsn = process.env.EXPO_PUBLIC_SENTRY_DSN ?? MOMORA_APP_DSN;
  if (sentry || !dsn || __DEV__ || Platform.OS === 'web' || !hasNativeSentryModule()) return;

  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- must stay lazy (see top)
    const Sentry: SentryModule = require('@sentry/react-native');
    Sentry.init({
      dsn,
      environment: process.env.EXPO_PUBLIC_APP_ENV ?? 'production',
      sendDefaultPii: false,
      attachScreenshot: false,
      attachViewHierarchy: false,
      enableAutoPerformanceTracing: false,
      enableUserInteractionTracing: false,
      beforeSend: (event) => scrubEvent(event),
      beforeBreadcrumb: (breadcrumb) => scrubBreadcrumb(breadcrumb),
    });
    sentry = Sentry;
  } catch {
    sentry = null;
  }
}

/** Reports an error caught by a boundary; no-op when Sentry isn't running. */
export function captureException(error: unknown): void {
  sentry?.captureException(error);
}
