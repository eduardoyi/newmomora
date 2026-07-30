import { render } from '@testing-library/react-native';

import { OnbIllustration, kidTint } from '@/components/onboarding/onb-illustration';
import { onboardingIllustrations } from '@/constants/onboarding-illustrations';

// Real art doesn't exist yet (WP0 §0.2 ships every slot with no `asset`),
// so this override is the only way to exercise the "renders the real
// asset" branch -- every other slot in this file still falls through to
// the watercolor-wash fallback, which is the behavior WP0 actually ships.
jest.mock('@/constants/onboarding-illustrations', () => {
  const actual = jest.requireActual('@/constants/onboarding-illustrations') as typeof import('@/constants/onboarding-illustrations');
  return {
    ...actual,
    onboardingIllustrations: {
      ...actual.onboardingIllustrations,
      welcome: { ...actual.onboardingIllustrations.welcome, asset: 1 },
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
    const { getByTestId } = render(<OnbIllustration slot="founders" testID="onb-illo-founders" />);
    expect(getByTestId('onb-illo-founders').props.accessibilityLabel).toBe(
      onboardingIllustrations.founders.description,
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
