import { fireEvent, render, waitFor } from '@testing-library/react-native';
import { router } from 'expo-router';

import AddFamilyMemberScreen from '../../app/(app)/add-family-member';
import { useFamily } from '@/hooks/use-family';
import { useFamilyMembers } from '@/hooks/useFamilyMembers';
import { useUserProfile } from '@/hooks/useUserProfile';

jest.mock('expo-router', () => ({
  router: { back: jest.fn() },
}));
jest.mock('@/hooks/use-family', () => ({ useFamily: jest.fn() }));
jest.mock('@/hooks/useFamilyMembers', () => ({ useFamilyMembers: jest.fn() }));
jest.mock('@/hooks/useUserProfile', () => ({ useUserProfile: jest.fn() }));
jest.mock('react-native-safe-area-context', () => {
  const actual = jest.requireActual('react-native-safe-area-context');
  return {
    ...actual,
    useSafeAreaInsets: () => ({ top: 0, right: 0, bottom: 0, left: 0 }),
  };
});
jest.mock('@/utils/e2e-fixtures', () => ({
  E2E_FAMILY_MEMBER_DOB: '2022-10-25',
  E2E_FAMILY_MEMBER_GENDER: 'Male',
  E2E_FAMILY_MEMBER_NAME: 'Maestro Test Child',
  E2E_FAMILY_MEMBER_NOTES: 'E2E profile upload',
  isE2eFixturesEnabled: () => true,
  loadE2eProfilePhoto: async () => ({
    uri: 'file:///fixture.jpg',
    contentType: 'image/jpeg',
    captureDate: '2024-06-03',
    referenceDate: '2024-06-03',
    dateSource: 'exif',
  }),
}));
jest.mock('@/components/date-picker-field', () => ({
  DatePickerField: ({ maximumDate, minimumDate, onChange, testID, value }: {
    maximumDate?: Date;
    minimumDate?: Date;
    onChange: (value: string) => void;
    testID: string;
    value: string;
  }) => {
    const { Pressable, Text } = jest.requireActual('react-native') as typeof import('react-native');
    const toLocalIso = (date?: Date) => date
      ? `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
      : '';
    return (
      <Pressable
        onPress={() => onChange(testID === 'add-family-member-photo-date' ? '2024-07-01' : value)}
        testID={testID}
      >
        <Text>{value}</Text>
        <Text testID={`${testID}-minimum`}>{toLocalIso(minimumDate)}</Text>
        <Text testID={`${testID}-maximum`}>{toLocalIso(maximumDate)}</Text>
      </Pressable>
    );
  },
}));

const mockedUseFamily = useFamily as jest.MockedFunction<typeof useFamily>;
const mockedUseFamilyMembers = useFamilyMembers as jest.MockedFunction<typeof useFamilyMembers>;
const mockedUseUserProfile = useUserProfile as jest.MockedFunction<typeof useUserProfile>;
const mockCreateMember = jest.fn(async () => ({}));

describe('initial family member photo date', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockedUseFamily.mockReturnValue({ role: 'manager' } as ReturnType<typeof useFamily>);
    mockedUseFamilyMembers.mockReturnValue({
      createMember: mockCreateMember,
      isCreating: false,
    } as ReturnType<typeof useFamilyMembers>);
    mockedUseUserProfile.mockReturnValue({
      updateProfile: jest.fn(),
    } as unknown as ReturnType<typeof useUserProfile>);
  });

  it('shows EXIF provenance, constrains the date, and saves a manual override', async () => {
    const { findByTestId, getByTestId, getByText } = render(<AddFamilyMemberScreen />);

    fireEvent.press(getByTestId('add-family-member-photo-fixture'));
    expect(await findByTestId('add-family-member-photo-date')).toBeTruthy();
    expect(getByText('2024-06-03')).toBeTruthy();
    expect(getByTestId('add-family-member-photo-date-source').props.children).toBe('From photo');
    expect(getByTestId('add-family-member-photo-date-minimum').props.children).toBe('2022-10-25');
    expect(getByTestId('add-family-member-photo-date-maximum').props.children).toMatch(/^\d{4}-\d{2}-\d{2}$/);

    fireEvent.press(getByTestId('add-family-member-photo-date'));
    expect(getByTestId('add-family-member-photo-date-source').props.children).toBe('Set manually');
    fireEvent.press(getByTestId('add-family-member-save'));

    await waitFor(() => expect(mockCreateMember).toHaveBeenCalledWith(expect.objectContaining({
      photoReferenceDate: '2024-07-01',
      photoDateSource: 'manual',
    })));
    expect(router.back).toHaveBeenCalled();
  });
});
