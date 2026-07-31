// Deliberately outside app/ -- see onboarding.kids.integration.test.tsx /
// no-family.test.tsx for why screen tests live here and import the screen
// via a relative path instead.
//
// Regression coverage for three device-reported S10 rendering bugs
// (docs/plans/onboarding-design-brief.md S10):
//
// 1. No emotion analysis has run yet at this point in the flow (it's a
//    fire-and-forget kicked off by commitOnboarding's createMemory,
//    post-auth) -- the screen used to hardcode an emotion chip labelled
//    "joy" regardless of what the user wrote. It must never show one.
// 2. The text-only card's watermark quote mark used to be absolutely
//    positioned behind the memory text instead of sitting above it as a
//    normal-flow watermark (the app/(app)/memory/[id]/index.tsx editorial
//    detail screen's treatment -- src/components/memory-card.tsx's own
//    QuoteCard has no such glyph at all).
// 3. The media card's photo used to be force-cropped to a hardcoded 4:3
//    aspectRatio. It must measure the real image (aspectRatioFromDimensions
//    + clampMediaAspectRatio, same helpers app/(app)/memory/[id]/index.tsx
//    uses for its framed illustration) and fall back to the same neutral
//    DEFAULT_MEDIA_ASPECT_RATIO placeholder before it has.
import { fireEvent, render } from '@testing-library/react-native';
import { router } from 'expo-router';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import OnboardingAhaScreen from '../../app/(onboarding)/aha';
import { useOnboardingFlow } from '@/hooks/use-onboarding-flow';
import { onboardingYearRoute } from '@/lib/onboarding-routes';
import { DEFAULT_MEDIA_ASPECT_RATIO, MIN_MEDIA_ASPECT_RATIO } from '@/utils/media-aspect';
import { createEmptyOnboardingDraft, type OnboardingDraft } from '@/utils/onboarding-progress';

jest.mock('expo-router', () => ({
  router: { replace: jest.fn(), push: jest.fn(), back: jest.fn() },
}));

jest.mock('@/hooks/use-onboarding-flow', () => ({
  useOnboardingFlow: jest.fn(),
}));

// createEmptyOnboardingDraft lives in the same module as the real
// AsyncStorage-backed persistence helpers (src/utils/onboarding-progress.ts)
// -- swap in the maintained mock so importing it doesn't pull in the native
// module under Jest (same pattern as onboarding.included.integration.test.tsx).
jest.mock('@react-native-async-storage/async-storage', () =>
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- jest.mock factories cannot use ESM imports
  require('@react-native-async-storage/async-storage/jest/async-storage-mock'),
);

const mockedUseOnboardingFlow = useOnboardingFlow as jest.MockedFunction<typeof useOnboardingFlow>;

function renderScreen() {
  return render(
    <SafeAreaProvider
      initialMetrics={{
        frame: { height: 844, width: 390, x: 0, y: 0 },
        insets: { bottom: 34, left: 0, right: 0, top: 47 },
      }}
    >
      <OnboardingAhaScreen />
    </SafeAreaProvider>,
  );
}

function mockDraft(overrides: Partial<OnboardingDraft>) {
  mockedUseOnboardingFlow.mockReturnValue({
    draft: { ...createEmptyOnboardingDraft('aha'), ...overrides },
    isHydrated: true,
    patch: jest.fn(),
    clear: jest.fn(),
  });
}

describe('OnboardingAhaScreen (S10) -- text-only quote card', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockDraft({
      kidNames: ['Lila'],
      capture: { text: 'She narrated the whole bath in a tiny robot voice.', taggedKidIndexes: [0] },
    });
  });

  it('never shows a hardcoded emotion chip or the word "joy"', () => {
    const { queryByText } = renderScreen();

    expect(queryByText('joy')).toBeNull();
  });

  it('renders the watermark quote mark in normal flow above the text, not absolutely positioned behind it', () => {
    const { getByTestId } = renderScreen();

    const quoteMark = getByTestId('onboarding-aha-quote-mark');
    expect(quoteMark).not.toHaveStyle({ position: 'absolute' });
    expect(quoteMark).toHaveStyle({ opacity: 0.18 });
  });

  it('shows the captured text and advances "Keep it going" to the year screen', () => {
    const { getByText, getByTestId } = renderScreen();

    expect(getByText('She narrated the whole bath in a tiny robot voice.')).toBeTruthy();

    fireEvent.press(getByTestId('onboarding-aha-continue'));

    expect(router.push).toHaveBeenCalledWith(onboardingYearRoute);
  });
});

describe('OnboardingAhaScreen (S10) -- media card', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockDraft({
      kidNames: ['Lila'],
      capture: {
        text: 'Puddle jumping in the good boots.',
        mediaUri: 'file:///var/mobile/onboarding-capture.jpg',
        mediaContentType: 'image/jpeg',
        taggedKidIndexes: [0],
      },
    });
  });

  it('never shows a hardcoded emotion chip', () => {
    const { queryByText } = renderScreen();

    expect(queryByText('joy')).toBeNull();
  });

  it('starts at the neutral 4:3 placeholder ratio before the image has measured, with no fixed crop applied', () => {
    const { getByTestId } = renderScreen();

    expect(getByTestId('onboarding-aha-media-image')).toHaveStyle({
      aspectRatio: DEFAULT_MEDIA_ASPECT_RATIO,
    });
  });

  it('adopts the real measured (clamped) aspect ratio for a non-4:3 (portrait) photo once it loads, instead of cropping it', () => {
    const { getByTestId } = renderScreen();

    fireEvent(getByTestId('onboarding-aha-media-image'), 'load', {
      nativeEvent: { source: { width: 1080, height: 1920 } },
    });

    // 1080/1920 = 0.5625, narrower than MIN_MEDIA_ASPECT_RATIO (3/4) -- clamped
    // up to the minimum rather than left uncropped-but-extreme, same as
    // app/(app)/memory/[id]/index.tsx's framed illustration.
    expect(getByTestId('onboarding-aha-media-image')).toHaveStyle({
      aspectRatio: MIN_MEDIA_ASPECT_RATIO,
    });
  });

  it('adopts a square photo exactly, unlike the previous hardcoded 4:3 crop', () => {
    const { getByTestId } = renderScreen();

    fireEvent(getByTestId('onboarding-aha-media-image'), 'load', {
      nativeEvent: { source: { width: 1200, height: 1200 } },
    });

    expect(getByTestId('onboarding-aha-media-image')).toHaveStyle({ aspectRatio: 1 });
  });
});

// Device-reported bug (2026-07-31): the "saved · {X} journal" caption used
// to render "saved · Their journal" for several tagged kids -- correct
// pronoun choice, wrong pronoun *person*. journalPossessive flavors the
// neutral multi-kid case "Your" instead (see its doc comment in
// onboarding-copy.ts for the full reconciliation).
describe('OnboardingAhaScreen (S10) -- saved caption journal wording', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('names the single tagged kid', () => {
    mockDraft({
      kidNames: ['Lila'],
      capture: { text: 'Bath time giggles.', taggedKidIndexes: [0] },
    });

    const { getByText } = renderScreen();

    expect(getByText("saved · Lila's journal")).toBeTruthy();
  });

  it('applies the s-ending possessive rule for the single tagged kid', () => {
    mockDraft({
      kidNames: ['Chris'],
      capture: { text: 'Bath time giggles.', taggedKidIndexes: [0] },
    });

    const { getByText } = renderScreen();

    expect(getByText("saved · Chris' journal")).toBeTruthy();
  });

  it('uses "Your" (not "Their") when two kids are tagged', () => {
    mockDraft({
      kidNames: ['Lila', 'Miguel'],
      capture: { text: 'Bath time giggles.', taggedKidIndexes: [0, 1] },
    });

    const { getByText, queryByText } = renderScreen();

    expect(getByText('saved · Your journal')).toBeTruthy();
    expect(queryByText('saved · Their journal')).toBeNull();
  });

  it('uses "Your" when three or more kids are tagged', () => {
    mockDraft({
      kidNames: ['Lila', 'Miguel', 'Teo'],
      capture: { text: 'Bath time giggles.', taggedKidIndexes: [0, 1, 2] },
    });

    const { getByText } = renderScreen();

    expect(getByText('saved · Your journal')).toBeTruthy();
  });
});
