import { onboardingPortraitPairs } from '@/constants/onboarding-portrait-pairs';

describe('onboardingPortraitPairs', () => {
  it('has more than one pair so the S16 rotation has something to rotate through', () => {
    expect(onboardingPortraitPairs.length).toBeGreaterThan(1);
  });

  it('gives every pair a truthy bundled photo and portrait asset', () => {
    for (const pair of onboardingPortraitPairs) {
      expect(pair.photo).toBeTruthy();
      expect(pair.portrait).toBeTruthy();
    }
  });

  it('never pairs the same asset as both the photo and the portrait', () => {
    for (const pair of onboardingPortraitPairs) {
      expect(pair.photo).not.toBe(pair.portrait);
    }
  });

  it('has unique keys', () => {
    const keys = onboardingPortraitPairs.map((pair) => pair.key);
    expect(new Set(keys).size).toBe(keys.length);
  });
});
