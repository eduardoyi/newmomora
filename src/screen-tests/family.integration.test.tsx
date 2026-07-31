// Deliberately outside app/ -- see no-family.test.tsx's header comment on
// why screen tests live here and import the screen via a relative path.
import { fireEvent, render } from '@testing-library/react-native';
import { router } from 'expo-router';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import FamilyScreen from '../../app/(app)/(tabs)/family';
import { useFamily } from '@/hooks/use-family';
import { useFamilyMembers } from '@/hooks/useFamilyMembers';
import { useContentSafety } from '@/hooks/useContentSafety';
import type { FamilyMember } from '@/services/family-members';

jest.mock('expo-router', () => ({
  router: { push: jest.fn(), back: jest.fn() },
}));
jest.mock('@/hooks/use-family', () => ({ useFamily: jest.fn() }));
jest.mock('@/hooks/useFamilyMembers', () => ({ useFamilyMembers: jest.fn() }));
jest.mock('@/hooks/useContentSafety', () => ({ useContentSafety: jest.fn() }));
jest.mock('@/components/family-profile-portrait-photo', () => ({
  FamilyProfilePortraitPhoto: 'FamilyProfilePortraitPhoto',
}));

const mockedUseFamily = useFamily as jest.MockedFunction<typeof useFamily>;
const mockedUseFamilyMembers = useFamilyMembers as jest.MockedFunction<typeof useFamilyMembers>;
const mockedUseContentSafety = useContentSafety as jest.MockedFunction<typeof useContentSafety>;
const mockPush = router.push as jest.MockedFunction<typeof router.push>;

const contentSafetyStub = {
  isLoading: false,
  isError: false,
  isReporting: false,
  isTargetReported: () => false,
  hasActiveReport: () => false,
  isUserBlocked: () => false,
  revealTarget: jest.fn(),
  report: jest.fn(),
  refetch: jest.fn(),
};

const incompleteKid: FamilyMember = {
  additional_info: null,
  created_at: '2026-07-30T00:00:00.000Z',
  date_of_birth: null,
  family_id: 'family-1',
  gender: null,
  id: 'kid-1',
  illustrated_profile_key: null,
  illustrated_profile_status: 'pending',
  is_user_profile: false,
  name: 'Enzo',
  nicknames: [],
  profile_picture_key: null,
  updated_at: '2026-07-30T00:00:00.000Z',
  user_id: 'user-1',
};

const completeKid: FamilyMember = {
  ...incompleteKid,
  id: 'kid-2',
  name: 'Mara',
  date_of_birth: '2022-01-01',
  profile_picture_key: 'user-1/family/kid-2/photo.jpg',
  illustrated_profile_key: 'user-1/family/kid-2/portrait.webp',
  illustrated_profile_status: 'ready',
};

function renderScreen() {
  return render(
    <SafeAreaProvider
      initialMetrics={{
        frame: { height: 844, width: 390, x: 0, y: 0 },
        insets: { bottom: 34, left: 0, right: 0, top: 47 },
      }}
    >
      <FamilyScreen />
    </SafeAreaProvider>,
  );
}

function stubFamilyMembers(members: FamilyMember[]) {
  mockedUseFamilyMembers.mockReturnValue({
    members,
    isLoading: false,
    isRefetching: false,
    isError: false,
    refetch: jest.fn(),
  } as unknown as ReturnType<typeof useFamilyMembers>);
}

describe('FamilyScreen routing for incomplete profiles', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockedUseContentSafety.mockReturnValue(
      contentSafetyStub as unknown as ReturnType<typeof useContentSafety>,
    );
  });

  it('routes an owner to the edit screen for a name-only kid', () => {
    mockedUseFamily.mockReturnValue({ role: 'owner' } as ReturnType<typeof useFamily>);
    stubFamilyMembers([incompleteKid]);

    const { getByTestId } = renderScreen();
    fireEvent.press(getByTestId('family-member-card-info-kid-1'));

    expect(mockPush).toHaveBeenCalledWith('/(app)/family/kid-1/edit');
  });

  it('routes a manager to the edit screen for a name-only kid', () => {
    mockedUseFamily.mockReturnValue({ role: 'manager' } as ReturnType<typeof useFamily>);
    stubFamilyMembers([incompleteKid]);

    const { getByTestId } = renderScreen();
    fireEvent.press(getByTestId('family-member-card-info-kid-1'));

    expect(mockPush).toHaveBeenCalledWith('/(app)/family/kid-1/edit');
  });

  it('routes an owner to the normal detail screen once a profile is complete', () => {
    mockedUseFamily.mockReturnValue({ role: 'owner' } as ReturnType<typeof useFamily>);
    stubFamilyMembers([completeKid]);

    const { getByTestId } = renderScreen();
    fireEvent.press(getByTestId('family-member-card-info-kid-2'));

    expect(mockPush).toHaveBeenCalledWith('/(app)/family/kid-2');
  });

  it('never routes a viewer to the edit screen, even for a name-only kid', () => {
    mockedUseFamily.mockReturnValue({ role: 'viewer' } as ReturnType<typeof useFamily>);
    stubFamilyMembers([incompleteKid]);

    const { getByTestId } = renderScreen();
    fireEvent.press(getByTestId('family-member-card-info-kid-1'));

    expect(mockPush).toHaveBeenCalledWith('/(app)/family/kid-1');
  });

  it('routes the portrait-area tap the same as the info tap for an incomplete member', () => {
    mockedUseFamily.mockReturnValue({ role: 'owner' } as ReturnType<typeof useFamily>);
    stubFamilyMembers([incompleteKid]);

    const { getByTestId } = renderScreen();
    fireEvent.press(getByTestId('family-member-portrait'));

    expect(mockPush).toHaveBeenCalledWith('/(app)/family/kid-1/edit');
  });

  it('shows the quiet incomplete-profile prompt on the card for a name-only kid, for an owner', () => {
    mockedUseFamily.mockReturnValue({ role: 'owner' } as ReturnType<typeof useFamily>);
    stubFamilyMembers([incompleteKid]);

    const { getByTestId } = renderScreen();

    expect(getByTestId('family-member-incomplete-kid-1').props.children).toBe(
      "Tap to add Enzo's birthday & photo",
    );
  });

  it('shows the incomplete-profile prompt for a manager too', () => {
    mockedUseFamily.mockReturnValue({ role: 'manager' } as ReturnType<typeof useFamily>);
    stubFamilyMembers([incompleteKid]);

    const { getByTestId } = renderScreen();

    expect(getByTestId('family-member-incomplete-kid-1').props.children).toBe(
      "Tap to add Enzo's birthday & photo",
    );
  });

  // Grandparents invited right after the owner finishes onboarding are
  // exactly the audience most likely to land here as viewers while the
  // owner's kids are still name-only -- the prompt must not tell them to do
  // something their tap can never actually reach (the edit screen).
  it('never shows the incomplete-profile prompt to a viewer, even for a name-only kid', () => {
    mockedUseFamily.mockReturnValue({ role: 'viewer' } as ReturnType<typeof useFamily>);
    stubFamilyMembers([incompleteKid]);

    const { queryByTestId, queryByText } = renderScreen();

    expect(queryByTestId('family-member-incomplete-kid-1')).toBeNull();
    expect(queryByText(/Tap to add/)).toBeNull();
  });
});
