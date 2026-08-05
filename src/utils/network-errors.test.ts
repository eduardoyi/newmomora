import { onlineManager } from '@tanstack/react-query';

import { isNetworkFailure } from '@/utils/network-errors';

describe('isNetworkFailure', () => {
  afterEach(() => {
    onlineManager.setOnline(true);
  });

  it('treats RN fetch\'s "Network request failed" as a network failure', () => {
    expect(isNetworkFailure(new Error('Network request failed'))).toBe(true);
  });

  it.each(['Failed to fetch', 'The request timed out.', 'No internet connection'])(
    'treats "%s" as a network failure',
    (message) => {
      expect(isNetworkFailure(new Error(message))).toBe(true);
    },
  );

  it('does not treat a content-safety rejection as a network failure while online', () => {
    onlineManager.setOnline(true);
    expect(isNetworkFailure(new Error('This content violates our community guidelines'))).toBe(
      false,
    );
  });

  it('does not treat a validation error as a network failure while online', () => {
    onlineManager.setOnline(true);
    expect(isNetworkFailure(new Error('Memory content is required'))).toBe(false);
  });

  it('does not treat a usage-limit error as a network failure while online', () => {
    onlineManager.setOnline(true);
    expect(isNetworkFailure(new Error("You've reached your monthly memory limit"))).toBe(false);
  });

  it('falls back to the current onlineManager state for an unfamiliar message', () => {
    onlineManager.setOnline(false);
    expect(isNetworkFailure(new Error('Something unexpected happened'))).toBe(true);

    onlineManager.setOnline(true);
    expect(isNetworkFailure(new Error('Something unexpected happened'))).toBe(false);
  });

  it('returns false for a non-Error rejection while online', () => {
    onlineManager.setOnline(true);
    expect(isNetworkFailure('a string rejection')).toBe(false);
  });
});
