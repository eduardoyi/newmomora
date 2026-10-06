import { NativeModules, TurboModuleRegistry } from 'react-native';

const mockInit = jest.fn();
const mockCaptureException = jest.fn();
jest.mock('@sentry/react-native', () => ({ init: mockInit, captureException: mockCaptureException }));

type SentryLib = typeof import('./sentry');

function loadFresh(): SentryLib {
  let lib: SentryLib | undefined;
  jest.isolateModules(() => {
    lib = require('./sentry');
  });
  return lib!;
}

describe('sentry', () => {
  const globals = globalThis as unknown as { __DEV__: boolean };
  const originalDev = globals.__DEV__;

  beforeEach(() => {
    jest.clearAllMocks();
    globals.__DEV__ = false;
  });

  afterEach(() => {
    globals.__DEV__ = originalDev;
    jest.restoreAllMocks();
    delete (NativeModules as Record<string, unknown>).RNSentry;
  });

  it('does nothing on binaries without the native module (OTA to pre-1.4.2 builds)', () => {
    jest.spyOn(TurboModuleRegistry, 'get').mockReturnValue(null);
    const lib = loadFresh();

    lib.initSentry();
    lib.captureException(new Error('boom'));

    expect(lib.hasNativeSentryModule()).toBe(false);
    expect(mockInit).not.toHaveBeenCalled();
    expect(mockCaptureException).not.toHaveBeenCalled();
  });

  it('does nothing in development', () => {
    globals.__DEV__ = true;
    jest.spyOn(TurboModuleRegistry, 'get').mockReturnValue({} as never);
    const lib = loadFresh();

    lib.initSentry();

    expect(mockInit).not.toHaveBeenCalled();
  });

  it('initializes once with privacy options when the native module exists', () => {
    jest.spyOn(TurboModuleRegistry, 'get').mockReturnValue({} as never);
    const lib = loadFresh();

    lib.initSentry();
    lib.initSentry();
    lib.captureException(new Error('boom'));

    expect(mockInit).toHaveBeenCalledTimes(1);
    expect(mockInit.mock.calls[0][0]).toMatchObject({
      dsn: expect.stringContaining('ingest.us.sentry.io'),
      sendDefaultPii: false,
      attachScreenshot: false,
      attachViewHierarchy: false,
      enableAutoPerformanceTracing: false,
    });
    expect(mockInit.mock.calls[0][0].tracesSampleRate).toBeUndefined();
    expect(mockCaptureException).toHaveBeenCalledTimes(1);
  });

  it('falls back to the legacy NativeModules lookup', () => {
    jest.spyOn(TurboModuleRegistry, 'get').mockReturnValue(null);
    (NativeModules as Record<string, unknown>).RNSentry = {};
    expect(loadFresh().hasNativeSentryModule()).toBe(true);
  });

  it('strips query strings and user data from events', () => {
    const { scrubEvent } = loadFresh();
    const event = scrubEvent({
      user: { id: 'u1', email: 'parent@example.com' },
      request: { url: 'https://media.example/a.jpg?token=secret', headers: { authorization: 'Bearer x' } },
    });

    expect(event.user).toBeUndefined();
    expect(event.request).toEqual({ url: 'https://media.example/a.jpg' });
  });

  it('keeps only navigation and network breadcrumbs, without query strings or bodies', () => {
    const { scrubBreadcrumb } = loadFresh();

    expect(scrubBreadcrumb({ category: 'console', message: 'Lucía said hi' })).toBeNull();
    expect(scrubBreadcrumb({ category: 'touch', message: "Open Lucía's memory" })).toBeNull();
    expect(scrubBreadcrumb({ message: 'no category' })).toBeNull();
    expect(
      scrubBreadcrumb({
        category: 'fetch',
        data: { url: 'https://x.supabase.co/rest/v1/memories?content=eq.secret', method: 'GET', status_code: 200, body: 'x' },
      }),
    ).toEqual({
      category: 'fetch',
      data: { url: 'https://x.supabase.co/rest/v1/memories', method: 'GET', status_code: 200 },
    });
  });
});
