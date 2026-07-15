import { fireEvent, render } from '@testing-library/react-native';
import { router } from 'expo-router';

import ViewFamilyMemberScreen from '../../app/(app)/family/[id]';
import { useFamily } from '@/hooks/use-family';
import { useFamilyMembers } from '@/hooks/useFamilyMembers';
import { useMediaUrl } from '@/hooks/useMediaUrls';
import { useMemories } from '@/hooks/useMemories';
import { usePortraitVersions } from '@/hooks/usePortraitVersions';

jest.mock('expo-router', () => ({
  router: { back: jest.fn(), push: jest.fn() },
  useLocalSearchParams: () => ({ id: 'member-1' }),
}));
jest.mock('@/hooks/use-family', () => ({ useFamily: jest.fn() }));
jest.mock('@/hooks/useFamilyMembers', () => ({ useFamilyMembers: jest.fn() }));
jest.mock('@/hooks/useMediaUrls', () => ({ useMediaUrl: jest.fn() }));
jest.mock('@/hooks/useMemories', () => ({ useMemories: jest.fn() }));
jest.mock('@/hooks/usePortraitVersions', () => ({ usePortraitVersions: jest.fn() }));
jest.mock('@/hooks/useVideoThumbnail', () => ({ useVideoThumbnail: () => null }));
jest.mock('@/components/full-screen-media-viewer', () => ({
  FullScreenMediaViewer: ({ cacheVersion, items }: {
    cacheVersion: string;
    items: { uri?: string }[];
  }) => {
    const { Text } = jest.requireActual('react-native') as typeof import('react-native');
    return <Text testID="member-portrait-fullscreen-mock">{`${cacheVersion}:${items[0]?.uri}`}</Text>;
  },
}));

const mockedUseFamily = useFamily as jest.MockedFunction<typeof useFamily>;
const mockedUseFamilyMembers = useFamilyMembers as jest.MockedFunction<typeof useFamilyMembers>;
const mockedUseMediaUrl = useMediaUrl as jest.MockedFunction<typeof useMediaUrl>;
const mockedUseMemories = useMemories as jest.MockedFunction<typeof useMemories>;
const mockedUsePortraitVersions = usePortraitVersions as jest.MockedFunction<typeof usePortraitVersions>;
const mockPush = router.push as jest.MockedFunction<typeof router.push>;

const currentVersion = {
  id: 'ready-version',
  family_id: 'family-1',
  family_member_id: 'member-1',
  user_id: 'user-1',
  reference_date: '2026-06-01',
  date_source: 'manual' as const,
  profile_picture_key: 'version/photo.jpg',
  illustrated_profile_key: 'version/current.webp',
  illustrated_profile_status: 'ready' as const,
  generation_token: null,
  generation_started_at: null,
  generation_output_key: null,
  deletion_token: null,
  deletion_started_at: null,
  created_at: '2026-06-01T00:00:00.000Z',
  updated_at: '2026-06-02T00:00:00.000Z',
};

const failedVersion = {
  ...currentVersion,
  id: 'failed-version',
  reference_date: '2026-07-01',
  illustrated_profile_key: null,
  illustrated_profile_status: 'failed' as const,
  profile_picture_key: 'version/failed-photo.jpg',
};

describe('family member portrait entry', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockedUseFamily.mockReturnValue({ role: 'manager' } as ReturnType<typeof useFamily>);
    mockedUseFamilyMembers.mockReturnValue({
      members: [{
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
        created_at: '2024-01-01T00:00:00.000Z',
        updated_at: '2024-01-01T00:00:00.000Z',
        avatarImageKey: currentVersion.illustrated_profile_key,
        avatarStatus: 'ready',
        avatarUpdatedAt: currentVersion.updated_at,
        resolvedPortraitVersion: currentVersion,
        portraitVersions: [currentVersion, failedVersion],
      }],
      isLoading: false,
      deleteMember: jest.fn(),
      isDeleting: false,
    } as ReturnType<typeof useFamilyMembers>);
    mockedUsePortraitVersions.mockReturnValue({
      versions: [currentVersion, failedVersion],
    } as ReturnType<typeof usePortraitVersions>);
    mockedUseMemories.mockReturnValue({ memories: [] } as ReturnType<typeof useMemories>);
    mockedUseMediaUrl.mockImplementation((key) => ({
      url: key ? `https://media.test/${key}` : null,
      isLoading: false,
      isError: false,
    }) as ReturnType<typeof useMediaUrl>);
  });

  it('counts every visual record and opens the resolved current portrait', () => {
    const { getByLabelText, getByTestId } = render(<ViewFamilyMemberScreen />);

    expect(getByLabelText('Open portrait timeline, 2 portraits')).toBeTruthy();
    fireEvent.press(getByTestId('family-member-portrait'));
    expect(getByTestId('member-portrait-fullscreen-mock').props.children).toBe(
      '2026-06-02T00:00:00.000Z:https://media.test/version/current.webp',
    );

    fireEvent.press(getByTestId('family-member-portrait-history'));
    expect(mockPush).toHaveBeenCalledWith('/(app)/family/member-1/portraits');
  });
});
