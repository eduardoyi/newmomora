import { fireEvent, render } from '@testing-library/react-native';
import { router } from 'expo-router';
import { ScrollView } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import OnboardingYearScreen from '../../app/(onboarding)/year';
import { useOnboardingFlow } from '@/hooks/use-onboarding-flow';
import { onboardingNotificationsRoute } from '@/lib/onboarding-routes';
import { createEmptyOnboardingDraft } from '@/utils/onboarding-progress';

jest.mock('expo-router', () => ({
  router: { push: jest.fn(), replace: jest.fn(), back: jest.fn() },
  // This screen's focus effect only controls a decorative drift animation;
  // leave that native-navigation concern out of this layout integration test.
  useFocusEffect: jest.fn(),
}));

jest.mock('lucide-react-native', () => ({
  Play: () => null,
}));

jest.mock('@/hooks/use-onboarding-flow', () => ({
  useOnboardingFlow: jest.fn(),
}));

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
      <OnboardingYearScreen />
    </SafeAreaProvider>,
  );
}

describe('OnboardingYearScreen (S10b)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockedUseOnboardingFlow.mockReturnValue({
      draft: createEmptyOnboardingDraft('year'),
      isHydrated: true,
      patch: jest.fn(),
      clear: jest.fn(),
    });
  });

  // Device-testing fix: this screen used to render inside OnbShell, whose
  // body is a KeyboardAwareScrollView -- so the "fixed" header/body copy
  // could actually be dragged around with the rest of the content, and only
  // the CTA was reliably pinned. This screen has no text input and needs no
  // keyboard handling, so it now builds its own small fixed layout instead
  // of using OnbShell at all. These assertions are the regression test for
  // that: no scrollable container exists anywhere in the tree, and the
  // header/footer are plain, non-scrolling siblings of the animated stage.
  it('has no scrollable container anywhere -- the whole screen is a fixed, non-interactive layout', () => {
    const { queryByTestId, UNSAFE_queryAllByType } = renderScreen();

    expect(queryByTestId('onb-shell-scroll')).toBeNull();
    expect(UNSAFE_queryAllByType(ScrollView)).toHaveLength(0);
  });

  it('keeps the headline a fixed sibling of the timeline, not nested inside it (or vice versa)', () => {
    const { getByTestId } = renderScreen();

    const header = getByTestId('onboarding-year-header');
    const stage = getByTestId('onboarding-year-stage');

    // Ancestor-walk in both directions (same pattern as onb-shell.test.tsx)
    // rather than an exact `.children` shape, which would be fragile across
    // the composite-vs-host layers SafeAreaView/OnbBody/OnbButton add.
    let ancestor = header.parent;
    while (ancestor) {
      expect(ancestor).not.toBe(stage);
      ancestor = ancestor.parent;
    }
    ancestor = stage.parent;
    while (ancestor) {
      expect(ancestor).not.toBe(header);
      ancestor = ancestor.parent;
    }
  });

  it('pins the body copy directly above the CTA in a fixed footer, reachable without scrolling', () => {
    const { getByTestId, getByText } = renderScreen();

    const footer = getByTestId('onboarding-year-footer');
    const cta = getByTestId('onboarding-year-continue');
    const body = getByText('Talk, type, photos, video. Some become illustrated pages. All of it lands in your journal.');

    // Both the body copy and the CTA live inside the same fixed footer.
    let bodyAncestor = body.parent;
    let bodyInFooter = false;
    while (bodyAncestor) {
      if (bodyAncestor === footer) {
        bodyInFooter = true;
        break;
      }
      bodyAncestor = bodyAncestor.parent;
    }
    expect(bodyInFooter).toBe(true);

    let ctaAncestor = cta.parent;
    let ctaInFooter = false;
    while (ctaAncestor) {
      if (ctaAncestor === footer) {
        ctaInFooter = true;
        break;
      }
      ctaAncestor = ctaAncestor.parent;
    }
    expect(ctaInFooter).toBe(true);

    fireEvent.press(cta);
    expect(router.push).toHaveBeenCalledWith(onboardingNotificationsRoute);
  });

  it('does not render the user\'s own captured memory in the timeline -- only the demo cards', () => {
    mockedUseOnboardingFlow.mockReturnValue({
      draft: {
        ...createEmptyOnboardingDraft('year'),
        kidNames: ['Nora'],
        capture: { text: 'She stacked every block in the house.', taggedKidIndexes: [0] },
      },
      isHydrated: true,
      patch: jest.fn(),
      clear: jest.fn(),
    });

    const { queryByTestId, queryByText } = renderScreen();

    expect(queryByTestId('onboarding-year-real-card')).toBeNull();
    expect(queryByText('She stacked every block in the house.')).toBeNull();
  });

  it("personalizes the fixed body copy to the tagged kid's journal when exactly one kid is tagged", () => {
    mockedUseOnboardingFlow.mockReturnValue({
      draft: {
        ...createEmptyOnboardingDraft('year'),
        kidNames: ['Nora'],
        capture: { text: 'She stacked every block in the house.', taggedKidIndexes: [0] },
      },
      isHydrated: true,
      patch: jest.fn(),
      clear: jest.fn(),
    });

    const { getByText } = renderScreen();

    expect(
      getByText("Talk, type, photos, video. Some become illustrated pages. All of it lands in Nora's journal."),
    ).toBeTruthy();
  });

  it('personalizes the fixed body copy to "your journal" (not "their") when two kids are tagged', () => {
    mockedUseOnboardingFlow.mockReturnValue({
      draft: {
        ...createEmptyOnboardingDraft('year'),
        kidNames: ['Nora', 'Sam'],
        capture: { text: 'They built a blanket fort.', taggedKidIndexes: [0, 1] },
      },
      isHydrated: true,
      patch: jest.fn(),
      clear: jest.fn(),
    });

    const { getByText, queryByText } = renderScreen();

    expect(
      getByText('Talk, type, photos, video. Some become illustrated pages. All of it lands in your journal.'),
    ).toBeTruthy();
    expect(queryByText(/lands in their journal/)).toBeNull();
  });

  it('personalizes the fixed body copy to "your journal" when three or more kids are tagged', () => {
    mockedUseOnboardingFlow.mockReturnValue({
      draft: {
        ...createEmptyOnboardingDraft('year'),
        kidNames: ['Nora', 'Sam', 'Ana'],
        capture: { text: 'They built a blanket fort.', taggedKidIndexes: [0, 1, 2] },
      },
      isHydrated: true,
      patch: jest.fn(),
      clear: jest.fn(),
    });

    const { getByText } = renderScreen();

    expect(
      getByText('Talk, type, photos, video. Some become illustrated pages. All of it lands in your journal.'),
    ).toBeTruthy();
  });
});
