import { render } from '@testing-library/react-native';

import { OnbIllustration, kidTint } from '@/components/onboarding/onb-illustration';
import { onboardingIllustrations } from '@/constants/onboarding-illustrations';

// Real art now exists for every remaining slot (src/constants/
// onboarding-illustrations.ts -- the paywall-page-1/3/4 slots that never
// got art were removed instead), so there is no naturally assetless slot
// left to exercise the wash-fallback branch. This override manufactures
// one: 'join-door' keeps its real description/emotion/scene but loses its
// `asset` for this test file only, so OnbIllustration's fallback branch
// stays covered without asserting on a slot that could grow real art later
// and silently stop testing the branch at all.
jest.mock('@/constants/onboarding-illustrations', () => {
  const actual = jest.requireActual('@/constants/onboarding-illustrations') as typeof import('@/constants/onboarding-illustrations');
  return {
    ...actual,
    onboardingIllustrations: {
      ...actual.onboardingIllustrations,
      'join-door': { ...actual.onboardingIllustrations['join-door'], asset: undefined },
    },
  };
});

describe('OnbIllustration', () => {
  it('falls back to the watercolor wash when the slot has no asset', () => {
    const { getByTestId } = render(<OnbIllustration slot="join-door" testID="onb-illo" />);

    const node = getByTestId('onb-illo');
    expect(node.props.source).toBeUndefined();
    expect(node.props.accessibilityLabel).toBe(onboardingIllustrations['join-door'].description);
  });

  it('exposes the slot description as the accessibility label for the wash fallback', () => {
    const { getByTestId } = render(<OnbIllustration slot="join-door" testID="onb-illo-2" />);
    expect(getByTestId('onb-illo-2').props.accessibilityLabel).toBe(
      onboardingIllustrations['join-door'].description,
    );
  });

  it('renders the real asset (and its label) once a slot has one', () => {
    const { getByTestId } = render(<OnbIllustration slot="welcome" testID="onb-illo-welcome" />);

    const node = getByTestId('onb-illo-welcome');
    // Metro/jest-expo resolve a numeric `require(...)` asset id into an
    // asset descriptor object at render time, so this only asserts an
    // asset actually resolved (as opposed to the wash View, which never
    // has a `source` prop at all).
    expect(node.props.source).toBeTruthy();
    expect(node.props.accessibilityLabel).toBe(onboardingIllustrations.welcome.description);
  });
});

describe('kidTint', () => {
  it('cycles through the five kid tints in entry order', () => {
    expect(kidTint(0)).toBe('tender');
    expect(kidTint(1)).toBe('wonder');
    expect(kidTint(2)).toBe('joy');
    expect(kidTint(3)).toBe('calm');
    expect(kidTint(4)).toBe('mischief');
    expect(kidTint(5)).toBe('tender');
  });
});
