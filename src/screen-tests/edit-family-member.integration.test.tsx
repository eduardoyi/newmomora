// The edit screen (app/(app)/family/[id]/edit.tsx) is the destination the
// family tab routes owners/managers to for an incomplete profile ("Tap to
// add {name}'s photo" -- src/components/cast-card.tsx). It used to have no
// photo field at all, so that prompt was a dead end. These tests cover the
// fix: a no-photo member can pick and save a photo (which must kick off
// portrait generation the same way app/(app)/add-family-member.tsx does,
// and must not newly require a date of birth -- onboarding's name-only kids
// have `date_of_birth: null`), a member who already has a photo gets a
// "Change photo" link to the portrait timeline instead of a picker, and the
// viewer role guard still bounces non-editors before any of this renders.
import { fireEvent, render, waitFor } from '@testing-library/react-native';
import { router } from 'expo-router';
import { ActionSheetIOS } from 'react-native';

import EditFamilyMemberScreen from '../../app/(app)/family/[id]/edit';
import { useFamily } from '@/hooks/use-family';
import { useFamilyMembers } from '@/hooks/useFamilyMembers';
import { pickFamilyProfilePhotoFromLibrary } from '@/utils/family-profile-photo-picker';

jest.mock('expo-router', () => ({
  router: { back: jest.fn(), push: jest.fn() },
  useLocalSearchParams: () => ({ id: 'member-1' }),
}));
jest.mock('@/hooks/use-family', () => ({ useFamily: jest.fn() }));
jest.mock('@/hooks/useFamilyMembers', () => ({ useFamilyMembers: jest.fn() }));
jest.mock('@/hooks/useMediaUrls', () => ({
  useMediaUrl: jest.fn(() => ({ url: 'https://media.test/photo.webp', isLoading: false, isError: false })),
}));
jest.mock('react-native-safe-area-context', () => {
  const actual = jest.requireActual('react-native-safe-area-context');
  return {
    ...actual,
    useSafeAreaInsets: () => ({ top: 0, right: 0, bottom: 0, left: 0 }),
  };
});
jest.mock('@/utils/family-profile-photo-picker', () => {
  const actual = jest.requireActual('@/utils/family-profile-photo-picker');
  return {
    ...actual,
    pickFamilyProfilePhotoFromCamera: jest.fn(),
    pickFamilyProfilePhotoFromLibrary: jest.fn(),
  };
});
jest.mock('@/components/date-picker-field', () => ({
  DatePickerField: ({ onChange, testID, value }: {
    onChange: (value: string) => void;
    testID: string;
    value: string;
  }) => {
    const { Pressable, Text } = jest.requireActual('react-native') as typeof import('react-native');
    // Fixed picks, keyed by field -- good enough to drive the screen's
    // state without a real native date picker (mirrors
    // add-family-member-photo-date.integration.test.tsx's identical mock).
    const fixedValue = testID === 'edit-family-member-photo-date' ? '2024-07-01' : '2022-06-15';
    return (
      <Pressable onPress={() => onChange(fixedValue)} testID={testID}>
        <Text>{value}</Text>
      </Pressable>
    );
  },
}));

const mockedUseFamily = useFamily as jest.MockedFunction<typeof useFamily>;
const mockedUseFamilyMembers = useFamilyMembers as jest.MockedFunction<typeof useFamilyMembers>;
const mockedPickFromLibrary = pickFamilyProfilePhotoFromLibrary as jest.MockedFunction<typeof pickFamilyProfilePhotoFromLibrary>;
const mockUpdateMember = jest.fn().mockResolvedValue({});
const mockDeleteMember = jest.fn();

const NO_PHOTO_MEMBER = {
  id: 'member-1',
  user_id: 'user-1',
  family_id: 'family-1',
  name: 'Mara',
  nicknames: [] as string[],
  date_of_birth: null as string | null,
  gender: null,
  profile_picture_key: null as string | null,
  illustrated_profile_key: null as string | null,
  illustrated_profile_status: null as string | null,
  additional_info: null,
  is_user_profile: false,
  created_at: '2026-07-01T00:00:00.000Z',
  updated_at: '2026-07-01T00:00:00.000Z',
};

const WITH_PHOTO_MEMBER = {
  ...NO_PHOTO_MEMBER,
  name: 'Theo',
  date_of_birth: '2022-01-01',
  profile_picture_key: 'family/theo/source.jpg',
  illustrated_profile_key: 'family/theo/portrait.webp',
  illustrated_profile_status: 'ready',
};

function mockMembers(members: (typeof NO_PHOTO_MEMBER)[]) {
  mockedUseFamilyMembers.mockReturnValue({
    members,
    isLoading: false,
    updateMember: mockUpdateMember,
    isUpdating: false,
    deleteMember: mockDeleteMember,
    isDeleting: false,
  } as unknown as ReturnType<typeof useFamilyMembers>);
}

describe('edit family member -- photo field', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockUpdateMember.mockResolvedValue({});
    mockedUseFamily.mockReturnValue({ role: 'manager' } as ReturnType<typeof useFamily>);
  });

  it('bounces a viewer back on mount, same guard as the rest of the screen', () => {
    mockedUseFamily.mockReturnValue({ role: 'viewer' } as ReturnType<typeof useFamily>);
    mockMembers([NO_PHOTO_MEMBER]);

    render(<EditFamilyMemberScreen />);

    // Mirrors the pre-existing "guard on mount" pattern (also used by
    // app/(app)/add-family-member.tsx): the effect fires router.back()
    // imperatively rather than gating the render tree, so real navigation
    // -- not a hidden photo field -- is what keeps a viewer from ever
    // seeing this screen's picker in production. The new photo field rides
    // on the same guard as the rest of the form; it does not add a
    // separate check a viewer could reach.
    expect(router.back).toHaveBeenCalled();
  });

  it('lets a name-only member with no photo pick one and save it without requiring a date of birth', async () => {
    mockMembers([NO_PHOTO_MEMBER]);
    mockedPickFromLibrary.mockResolvedValue({
      selection: {
        uri: 'file:///mara.jpg',
        contentType: 'image/jpeg',
        captureDate: null,
        referenceDate: '2026-07-01',
        dateSource: 'default_today',
      },
    });
    jest.spyOn(ActionSheetIOS, 'showActionSheetWithOptions').mockImplementation((_options, callback) => {
      callback(1); // "Choose from library"
    });

    const { getByTestId, findByTestId, queryByTestId } = render(<EditFamilyMemberScreen />);

    // The picker shows because this member has no photo yet; the
    // "Change photo" link (for members who already have one) must not.
    expect(getByTestId('edit-family-member-photo')).toBeTruthy();
    expect(queryByTestId('edit-family-member-change-photo')).toBeNull();

    fireEvent.press(getByTestId('edit-family-member-photo'));

    expect(await findByTestId('edit-family-member-photo-date-source', {}, { timeout: 2000 })).toBeTruthy();
    expect(mockedPickFromLibrary).toHaveBeenCalled();

    // Date of birth stays blank -- this member was created name-only and
    // the user is here only to add a photo.
    fireEvent.press(getByTestId('edit-family-member-save'));

    await waitFor(() => expect(mockUpdateMember).toHaveBeenCalled());
    const savedInput = mockUpdateMember.mock.calls[0][0];
    expect(savedInput).toMatchObject({
      memberId: 'member-1',
      name: 'Mara',
      photoUri: 'file:///mara.jpg',
      photoContentType: 'image/jpeg',
      photoReferenceDate: '2026-07-01',
      photoDateSource: 'default_today',
    });
    // Never sent as '' -- an untouched, still-blank DOB must not overwrite
    // the member's null date_of_birth with an invalid empty string.
    expect(savedInput).not.toHaveProperty('dateOfBirth');
    expect(router.back).toHaveBeenCalled();
  });

  it('shows a "Change photo" link instead of a picker for a member who already has a photo, and it opens the portrait timeline', () => {
    mockMembers([WITH_PHOTO_MEMBER]);

    const { getByTestId, queryByTestId } = render(<EditFamilyMemberScreen />);

    expect(queryByTestId('edit-family-member-photo')).toBeNull();
    fireEvent.press(getByTestId('edit-family-member-change-photo'));

    expect(router.push).toHaveBeenCalledWith('/(app)/family/member-1/portraits');
  });

  it('still enforces the photo-date-vs-birthday bound when the member does have a date of birth', async () => {
    // A member with a DOB but no photo yet -- WITH_PHOTO_MEMBER already has
    // a photo (renders the "Change photo" link instead), so this exercises
    // the picker's photo-date validation on a member who has a DOB but is
    // still missing a photo.
    mockMembers([{ ...NO_PHOTO_MEMBER, date_of_birth: '2022-06-15' }]);
    mockedPickFromLibrary.mockResolvedValue({
      selection: {
        uri: 'file:///mara.jpg',
        contentType: 'image/jpeg',
        captureDate: '2020-01-01',
        referenceDate: '2020-01-01', // before the 2022-06-15 date of birth
        dateSource: 'exif',
      },
    });
    jest.spyOn(ActionSheetIOS, 'showActionSheetWithOptions').mockImplementation((_options, callback) => {
      callback(1);
    });

    const { getByTestId, findByTestId, findByText } = render(<EditFamilyMemberScreen />);

    fireEvent.press(getByTestId('edit-family-member-photo'));
    await findByTestId('edit-family-member-photo-date-source', {}, { timeout: 2000 });

    fireEvent.press(getByTestId('edit-family-member-save'));

    expect(await findByText('Portrait date cannot be before date of birth')).toBeTruthy();
    expect(mockUpdateMember).not.toHaveBeenCalled();
  });
});
