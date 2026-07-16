import { fireEvent, render, waitFor } from '@testing-library/react-native';

import PortraitTimelineScreen from '../../app/(app)/family/[id]/portraits';
import { useFamily } from '@/hooks/use-family';
import { useFamilyMembers } from '@/hooks/useFamilyMembers';
import { useMediaUrls } from '@/hooks/useMediaUrls';
import { usePortraitVersions } from '@/hooks/usePortraitVersions';
import { pickPortraitVersionPhoto } from '@/utils/family-profile-photo-picker';

const mockBack = jest.fn();
const mockCreateVersion = jest.fn(async () => ({}));

jest.mock('expo-router', () => ({
  router: { back: mockBack },
  useLocalSearchParams: () => ({ id: 'member-1' }),
}));

jest.mock('@/hooks/use-family', () => ({ useFamily: jest.fn() }));
jest.mock('@/hooks/useFamilyMembers', () => ({ useFamilyMembers: jest.fn() }));
jest.mock('@/hooks/usePortraitVersions', () => ({ usePortraitVersions: jest.fn() }));
jest.mock('@/hooks/useMediaUrls', () => ({ useMediaUrls: jest.fn() }));
jest.mock('@/hooks/useContentSafety', () => ({
  useContentSafety: () => ({
    isLoading: false, isError: false, isReporting: false,
    isTargetReported: () => false, hasActiveReport: () => false,
    revealTarget: jest.fn(), report: jest.fn(), refetch: jest.fn(),
  }),
}));
jest.mock('@/utils/family-profile-photo-picker', () => ({
  parsePendingPickerResult: jest.fn(),
  pickPortraitVersionPhoto: jest.fn(),
}));
jest.mock('@/components/full-screen-media-viewer', () => ({
  FullScreenMediaViewer: 'FullScreenMediaViewer',
}));

jest.mock('react-native-safe-area-context', () => {
  const actual = jest.requireActual('react-native-safe-area-context');
  return {
    ...actual,
    useSafeAreaInsets: () => ({ top: 0, right: 0, bottom: 0, left: 0 }),
  };
});

const mockedUseFamily = useFamily as jest.MockedFunction<typeof useFamily>;
const mockedUseFamilyMembers = useFamilyMembers as jest.MockedFunction<typeof useFamilyMembers>;
const mockedUsePortraitVersions = usePortraitVersions as jest.MockedFunction<typeof usePortraitVersions>;
const mockedUseMediaUrls = useMediaUrls as jest.MockedFunction<typeof useMediaUrls>;
const mockedPickPortraitVersionPhoto = pickPortraitVersionPhoto as jest.MockedFunction<typeof pickPortraitVersionPhoto>;

const member = {
  id: 'member-1',
  user_id: 'user-1',
  family_id: 'family-1',
  name: 'Lila',
  nicknames: [],
  date_of_birth: '2022-03-14',
  gender: null,
  profile_picture_key: 'legacy/photo.webp',
  illustrated_profile_key: 'legacy/portrait.webp',
  illustrated_profile_status: 'ready',
  additional_info: null,
  is_user_profile: false,
  created_at: '2026-01-01T00:00:00.000Z',
  updated_at: '2026-07-01T00:00:00.000Z',
};

const version = {
  id: 'portrait-1',
  family_id: 'family-1',
  family_member_id: 'member-1',
  user_id: 'user-1',
  reference_date: '2025-11-08',
  date_source: 'exif' as const,
  profile_picture_key: 'user-1/member-1/portrait-1/photo.jpg',
  illustrated_profile_key: 'user-1/member-1/portrait-1/output.webp',
  illustrated_profile_status: 'ready' as const,
  generation_token: null,
  generation_started_at: null,
  generation_output_key: null,
  deletion_token: null,
  deletion_started_at: null,
  created_at: '2025-11-08T00:00:00.000Z',
  updated_at: '2025-11-08T00:00:00.000Z',
};

describe('PortraitTimelineScreen', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockedUseFamily.mockReturnValue({ role: 'manager' } as ReturnType<typeof useFamily>);
    mockedUseFamilyMembers.mockReturnValue({
      members: [member],
      isLoading: false,
    } as ReturnType<typeof useFamilyMembers>);
    mockedUsePortraitVersions.mockReturnValue({
      versions: [version],
      isLoading: false,
      isRefetching: false,
      isError: false,
      error: null,
      refetch: jest.fn(),
      createVersion: mockCreateVersion,
      editVersionDate: jest.fn(async () => ({})),
      retryVersion: jest.fn(async () => undefined),
      regenerateVersion: jest.fn(async () => undefined),
      deleteVersion: jest.fn(async () => undefined),
      isCreating: false,
      editingVersionId: null,
      retryingVersionId: null,
      regeneratingVersionId: null,
      deletingVersionId: null,
    } as ReturnType<typeof usePortraitVersions>);
    mockedUseMediaUrls.mockImplementation((keys) => ({
      data: Object.fromEntries(keys.map((key) => [key, `https://media.test/${key}`])),
      isLoading: false,
      isError: false,
    }) as ReturnType<typeof useMediaUrls>);
    mockedPickPortraitVersionPhoto.mockResolvedValue({
      selection: {
        uri: 'file:///picked.jpg',
        contentType: 'image/jpeg',
        captureDate: '2024-06-03',
        referenceDate: '2024-06-03',
        dateSource: 'exif',
      },
    });
  });

  it('maps the current portrait and confirms an extracted date before creating', async () => {
    const { findByTestId, getByTestId } = render(<PortraitTimelineScreen />);

    expect(getByTestId('portrait-version-portrait-1-current')).toBeTruthy();
    fireEvent.press(getByTestId('portrait-timeline-add'));
    fireEvent.press(getByTestId('portrait-add-library'));

    expect(await findByTestId('portrait-date-sheet')).toBeTruthy();
    fireEvent.press(getByTestId('portrait-date-save'));

    await waitFor(() => expect(mockCreateVersion).toHaveBeenCalledWith({
      photoUri: 'file:///picked.jpg',
      photoContentType: 'image/jpeg',
      referenceDate: '2024-06-03',
      dateSource: 'exif',
      dateOfBirth: '2022-03-14',
    }));
  });
});
