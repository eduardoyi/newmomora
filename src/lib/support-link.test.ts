import { Linking, Platform } from 'react-native';

import { buildSupportEmailUrl, openSupportEmail } from '@/lib/support-link';
import { trackEvent } from '@/services/analytics';

jest.mock('expo-constants', () => ({
  __esModule: true,
  default: { expoConfig: { version: '1.5.1' } },
}));
jest.mock('@/services/analytics', () => ({ trackEvent: jest.fn() }));

afterEach(() => {
  jest.restoreAllMocks();
  jest.clearAllMocks();
});

describe('buildSupportEmailUrl', () => {
  it('encodes the subject and carries only app version and platform in the body', () => {
    const url = buildSupportEmailUrl('save_failed');
    const [base, query] = url.split('?');
    const params = new URLSearchParams(query);

    expect(base).toBe('mailto:hello@usemomora.com');
    expect(url).toContain('subject=Momora%3A%20memory%20didn\'t%20save');
    expect(params.get('subject')).toBe("Momora: memory didn't save");
    expect(params.get('body')).toBe(`\n\n---\nApp version: 1.5.1\nPlatform: ${Platform.OS}`);
  });

  it('uses the illustration subject for illustration failures', () => {
    const params = new URLSearchParams(buildSupportEmailUrl('illustration_failed').split('?')[1]);
    expect(params.get('subject')).toBe('Momora: illustration problem');
  });
});

describe('openSupportEmail', () => {
  it('opens the mailto link and tracks the closed-enum source', async () => {
    const openURL = jest.spyOn(Linking, 'openURL').mockResolvedValue(true);

    await openSupportEmail('illustration_failed');

    expect(openURL).toHaveBeenCalledWith(buildSupportEmailUrl('illustration_failed'));
    expect(trackEvent).toHaveBeenCalledWith('support_link_opened', { source: 'illustration_failed' });
  });

  it('never throws when no mail app can open the link', async () => {
    jest.spyOn(Linking, 'openURL').mockRejectedValue(new Error('no mail app'));

    await expect(openSupportEmail('save_failed')).resolves.toBeUndefined();
    expect(trackEvent).not.toHaveBeenCalled();
  });
});
