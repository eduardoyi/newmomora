import { jest } from '@jest/globals';

const ORIGINAL_ENV = process.env;

interface MockPostHogModule {
  mockPostHogClient: {
    capture: jest.Mock;
    identify: jest.Mock;
    register: jest.Mock;
    setPersonProperties: jest.Mock;
    reset: jest.Mock;
  };
}

// The lazily-created singleton in src/services/analytics.ts reads env once
// per module instance, so exercising both the no-op and keyed paths in the
// same file requires `jest.resetModules()` + re-requiring at call time
// (rather than a single top-level `import`) to get a fresh module each time.
function loadAnalytics(): typeof import('@/services/analytics') {
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- see comment above; must re-require after jest.resetModules()
  return require('@/services/analytics');
}

function loadPostHogMock(): MockPostHogModule {
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- must re-require after jest.resetModules() to get the instance shared with the freshly-required analytics module
  return require('posthog-react-native');
}

describe('analytics', () => {
  beforeEach(() => {
    jest.resetModules();
    process.env = { ...ORIGINAL_ENV };
    delete process.env.EXPO_PUBLIC_POSTHOG_API_KEY;
    delete process.env.EXPO_PUBLIC_POSTHOG_HOST;
    delete process.env.EXPO_PUBLIC_APP_ENV;
  });

  afterAll(() => {
    process.env = ORIGINAL_ENV;
  });

  describe('without an API key', () => {
    it('trackEvent is a silent no-op', () => {
      const { trackEvent } = loadAnalytics();
      const { mockPostHogClient } = loadPostHogMock();

      expect(() => trackEvent('onboarding_step_viewed', { step: 'welcome', flow: 'owner' })).not.toThrow();
      expect(mockPostHogClient.capture).not.toHaveBeenCalled();
    });

    it('identifyUser, setPersonProperties, and resetAnalytics are silent no-ops', () => {
      const { identifyUser, setPersonProperties, resetAnalytics } = loadAnalytics();
      const { mockPostHogClient } = loadPostHogMock();

      expect(() => identifyUser('user-1')).not.toThrow();
      expect(() => setPersonProperties({ role: 'owner' })).not.toThrow();
      expect(() => resetAnalytics()).not.toThrow();

      expect(mockPostHogClient.identify).not.toHaveBeenCalled();
      expect(mockPostHogClient.setPersonProperties).not.toHaveBeenCalled();
      expect(mockPostHogClient.reset).not.toHaveBeenCalled();
    });
  });

  describe('with an API key', () => {
    beforeEach(() => {
      process.env.EXPO_PUBLIC_POSTHOG_API_KEY = 'phc_test_key';
    });

    it('captures the exact event name and properties', () => {
      const { trackEvent } = loadAnalytics();
      const { mockPostHogClient } = loadPostHogMock();

      trackEvent('memory_saved', {
        memory_type: 'text_only',
        used_voice: false,
        has_media: false,
        tagged_count: 2,
        illustration_enabled: false,
        source: 'fab_timeline',
      });

      expect(mockPostHogClient.capture).toHaveBeenCalledTimes(1);
      expect(mockPostHogClient.capture).toHaveBeenCalledWith('memory_saved', {
        memory_type: 'text_only',
        used_voice: false,
        has_media: false,
        tagged_count: 2,
        illustration_enabled: false,
        source: 'fab_timeline',
      });
    });

    it('captures Looking Back events with only closed, PII-safe properties', () => {
      const { trackEvent } = loadAnalytics();
      const { mockPostHogClient } = loadPostHogMock();
      trackEvent('looking_back_package_completed', {
        package_type: 'on_this_day', memory_count: 4, frame_count: 6,
      });
      expect(mockPostHogClient.capture).toHaveBeenCalledWith('looking_back_package_completed', {
        package_type: 'on_this_day', memory_count: 4, frame_count: 6,
      });
    });

    it('identifyUser calls posthog.identify with the given id and properties', () => {
      const { identifyUser } = loadAnalytics();
      const { mockPostHogClient } = loadPostHogMock();

      identifyUser('user-123', { role: 'owner', membership_count: 1 });

      expect(mockPostHogClient.identify).toHaveBeenCalledWith('user-123', {
        role: 'owner',
        membership_count: 1,
      });
    });

    it('setPersonProperties forwards to posthog.setPersonProperties', () => {
      const { setPersonProperties } = loadAnalytics();
      const { mockPostHogClient } = loadPostHogMock();

      setPersonProperties({ access_reason: 'trial' });

      expect(mockPostHogClient.setPersonProperties).toHaveBeenCalledWith({ access_reason: 'trial' });
    });

    it('resetAnalytics forwards to posthog.reset and re-registers the env super property', () => {
      const { resetAnalytics } = loadAnalytics();
      const { mockPostHogClient } = loadPostHogMock();

      resetAnalytics();

      expect(mockPostHogClient.reset).toHaveBeenCalledTimes(1);
      // posthog.reset() clears registered super properties, so `env` must be
      // re-registered or post-sign-out events vanish from env-filtered
      // dashboards: one register at client creation + one after reset.
      expect(mockPostHogClient.register).toHaveBeenCalledTimes(2);
      expect(mockPostHogClient.register).toHaveBeenLastCalledWith(
        expect.objectContaining({ env: expect.any(String) }),
      );
    });

    it('registers the env super property at client creation', () => {
      loadAnalytics().trackEvent('onboarding_step_viewed', { step: 'welcome', flow: 'owner' });
      const { mockPostHogClient } = loadPostHogMock();

      expect(mockPostHogClient.register).toHaveBeenCalledWith(expect.objectContaining({ env: expect.any(String) }));
    });

    // `__DEV__` is false when a dev-client runs its embedded release bundle
    // (standalone, no Metro), so EXPO_PUBLIC_APP_ENV is the authoritative
    // dev/prod signal -- only the production EAS environment maps to 'prod'.
    it('maps EXPO_PUBLIC_APP_ENV=production to env: prod', () => {
      process.env.EXPO_PUBLIC_APP_ENV = 'production';
      loadAnalytics().trackEvent('onboarding_step_viewed', { step: 'welcome', flow: 'owner' });
      const { mockPostHogClient } = loadPostHogMock();

      expect(mockPostHogClient.register).toHaveBeenCalledWith(expect.objectContaining({ env: 'prod' }));
    });

    it('maps any non-production EXPO_PUBLIC_APP_ENV to env: dev', () => {
      process.env.EXPO_PUBLIC_APP_ENV = 'preview';
      loadAnalytics().trackEvent('onboarding_step_viewed', { step: 'welcome', flow: 'owner' });
      const { mockPostHogClient } = loadPostHogMock();

      expect(mockPostHogClient.register).toHaveBeenCalledWith(expect.objectContaining({ env: 'dev' }));
    });

    it('helpers never throw when the underlying SDK throws', () => {
      const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
      const { trackEvent, identifyUser, setPersonProperties, resetAnalytics } = loadAnalytics();
      const { mockPostHogClient } = loadPostHogMock();

      mockPostHogClient.capture.mockImplementationOnce(() => {
        throw new Error('boom');
      });
      mockPostHogClient.identify.mockImplementationOnce(() => {
        throw new Error('boom');
      });
      mockPostHogClient.setPersonProperties.mockImplementationOnce(() => {
        throw new Error('boom');
      });
      mockPostHogClient.reset.mockImplementationOnce(() => {
        throw new Error('boom');
      });

      expect(() => trackEvent('onboarding_step_viewed', { step: 'welcome', flow: 'owner' })).not.toThrow();
      expect(() => identifyUser('user-1')).not.toThrow();
      expect(() => setPersonProperties({ role: 'owner' })).not.toThrow();
      expect(() => resetAnalytics()).not.toThrow();

      warnSpy.mockRestore();
    });
  });
});
