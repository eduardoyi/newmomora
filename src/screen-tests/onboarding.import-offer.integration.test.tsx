// Deliberately outside app/ -- see onboarding.kids.integration.test.tsx /
// no-family.test.tsx for why screen tests live here and import the screen
// via a relative path instead.
//
// S18 (2026-10-02): the gallery-import offer after the last portrait reveal.
// "Look through my photos" puts the journal underneath and opens the import
// flow (so leaving it lands on the timeline); "Maybe later" goes to the
// journal.
import { fireEvent, render } from '@testing-library/react-native';
import { router } from 'expo-router';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import ImportOfferScreen, { GALLERY_IMPORT_FROM_ONBOARDING } from '../../app/(onboarding)/import-offer';
import { useOnboardingKidPossessive } from '@/hooks/use-onboarding-kid-possessive';
import { timelineRoute } from '@/lib/routes';

jest.mock('expo-router', () => ({
  router: { replace: jest.fn(), push: jest.fn(), back: jest.fn() },
}));

jest.mock('@/hooks/use-onboarding-kid-possessive', () => ({
  useOnboardingKidPossessive: jest.fn(),
}));

const mockedUseOnboardingKidPossessive = useOnboardingKidPossessive as jest.MockedFunction<
  typeof useOnboardingKidPossessive
>;

function renderScreen() {
  return render(
    <SafeAreaProvider
      initialMetrics={{
        frame: { height: 844, width: 390, x: 0, y: 0 },
        insets: { bottom: 34, left: 0, right: 0, top: 47 },
      }}
    >
      <ImportOfferScreen />
    </SafeAreaProvider>,
  );
}

describe('ImportOfferScreen (S18)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockedUseOnboardingKidPossessive.mockReturnValue("Lila's");
  });

  it("names the kid's journal", () => {
    const { getByText } = renderScreen();

    expect(getByText("Lila's journal doesn’t have to start with one page.")).toBeTruthy();
  });

  it('opens gallery import on top of the journal', () => {
    const { getByTestId } = renderScreen();

    fireEvent.press(getByTestId('onb-import-offer-start-button'));

    expect(router.replace).toHaveBeenCalledWith(timelineRoute);
    expect(router.push).toHaveBeenCalledWith(GALLERY_IMPORT_FROM_ONBOARDING);
    expect(GALLERY_IMPORT_FROM_ONBOARDING.params.surface).toBe('onboarding');
  });

  it('"Maybe later" goes to the journal without opening import', () => {
    const { getByTestId } = renderScreen();

    fireEvent.press(getByTestId('onb-import-offer-later-link'));

    expect(router.replace).toHaveBeenCalledWith(timelineRoute);
    expect(router.push).not.toHaveBeenCalled();
  });
});
