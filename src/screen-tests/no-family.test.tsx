// Deliberately outside app/ -- expo-router's require.context picks up every
// .ts(x) file under app/ as a route (see node_modules/expo-router/_ctx.js),
// so a `*.test.tsx` file placed there would ship into the app as a garbage
// route. Screen-level tests live here and import the screen via a relative
// path instead.
import { fireEvent, render, waitFor } from '@testing-library/react-native';
import { router } from 'expo-router';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import NoFamilyScreen from '../../app/(app)/no-family';
import { useFamily } from '@/hooks/use-family';
import { createFamily } from '@/services/family';
import { timelineRoute } from '@/lib/routes';

jest.mock('expo-router', () => ({
  router: {
    replace: jest.fn(),
    push: jest.fn(),
    back: jest.fn(),
  },
}));

jest.mock('@/hooks/use-family', () => ({
  useFamily: jest.fn(),
}));

jest.mock('@/services/family', () => ({
  createFamily: jest.fn(),
}));

const mockedUseFamily = useFamily as jest.MockedFunction<typeof useFamily>;
const mockedCreateFamily = createFamily as jest.MockedFunction<typeof createFamily>;

function renderScreen() {
  return render(
    <SafeAreaProvider
      initialMetrics={{
        frame: { height: 844, width: 390, x: 0, y: 0 },
        insets: { bottom: 34, left: 0, right: 0, top: 47 },
      }}
    >
      <NoFamilyScreen />
    </SafeAreaProvider>,
  );
}

describe('NoFamilyScreen', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockedUseFamily.mockReturnValue({
      family: null,
      familyId: null,
      role: null,
      memberships: [],
      isLoading: false,
      setActiveFamily: jest.fn(),
      refetchMemberships: jest.fn().mockResolvedValue(undefined),
      justLostAccess: false,
    });
  });

  it('shows the first-run copy when the user never had a family', () => {
    const { getByText } = renderScreen();
    expect(getByText('Start your family journal')).toBeTruthy();
  });

  it('shows the removed-access notice when justLostAccess is true', () => {
    mockedUseFamily.mockReturnValue({
      family: null,
      familyId: null,
      role: null,
      memberships: [],
      isLoading: false,
      setActiveFamily: jest.fn(),
      refetchMemberships: jest.fn().mockResolvedValue(undefined),
      justLostAccess: true,
    });

    const { getByText } = renderScreen();
    expect(getByText('You no longer have access')).toBeTruthy();
  });

  it('requires a name before creating a family', async () => {
    const { getByTestId, findByText } = renderScreen();

    fireEvent.press(getByTestId('no-family-create-button'));

    expect(await findByText('Give your family journal a name')).toBeTruthy();
    expect(mockedCreateFamily).not.toHaveBeenCalled();
  });

  it('creates a family, refetches memberships, and navigates to the timeline', async () => {
    mockedCreateFamily.mockResolvedValue({
      data: {
        id: 'family-1',
        owner_id: 'user-1',
        name: 'The Rivera family',
        illustration_style: 'default',
        deleted_at: null,
        created_at: '2026-05-28T00:00:00Z',
        updated_at: '2026-05-28T00:00:00Z',
      },
      error: null,
    });

    const { getByTestId } = renderScreen();

    fireEvent.changeText(getByTestId('no-family-name-input'), 'The Rivera family');
    fireEvent.press(getByTestId('no-family-create-button'));

    await waitFor(() => {
      expect(mockedCreateFamily).toHaveBeenCalledWith('The Rivera family');
    });
    await waitFor(() => {
      expect(router.replace).toHaveBeenCalledWith(timelineRoute);
    });
  });

  it('surfaces the family cap error from create_family', async () => {
    mockedCreateFamily.mockResolvedValue({
      data: null,
      error: { message: 'Maximum 5 owned families', code: 'P0001' },
    });

    const { getByTestId, findByText } = renderScreen();

    fireEvent.changeText(getByTestId('no-family-name-input'), 'One too many');
    fireEvent.press(getByTestId('no-family-create-button'));

    expect(
      await findByText("You've reached the limit of 5 family journals for one account."),
    ).toBeTruthy();
  });
});
