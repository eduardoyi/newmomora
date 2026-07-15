import { render } from '@testing-library/react-native';

import { FamilyProfilePortraitPhoto } from '@/components/family-profile-portrait-photo';
import { useMediaUrl } from '@/hooks/useMediaUrls';

jest.mock('expo-image', () => ({
  Image: ({ accessibilityLabel, source }: { accessibilityLabel?: string; source?: unknown }) => {
    const { Text } = require('react-native');
    return <Text testID="profile-portrait-image">{`${accessibilityLabel}:${JSON.stringify(source)}`}</Text>;
  },
}));

jest.mock('@/hooks/useMediaUrls', () => ({
  useMediaUrl: jest.fn(() => ({ url: 'https://signed.example/portrait', isLoading: false })),
}));

jest.mock('@/components/generating-visual-overlay', () => ({
  GeneratingVisualOverlay: ({ label }: { label: string }) => {
    const { Text } = require('react-native');
    return <Text>{label}</Text>;
  },
}));

const mockedUseMediaUrl = useMediaUrl as jest.MockedFunction<typeof useMediaUrl>;

describe('FamilyProfilePortraitPhoto resolved version state', () => {
  it('uses the enriched ready portrait without a legacy pending overlay', () => {
    const { getByTestId, queryByText } = render(
      <FamilyProfilePortraitPhoto
        member={{
          name: 'Maya',
          profile_picture_key: 'legacy-photo',
          illustrated_profile_key: null,
          illustrated_profile_status: 'pending',
          updated_at: 'legacy-time',
          avatarImageKey: 'version-portrait',
          avatarStatus: 'ready',
          avatarUpdatedAt: 'version-time',
        }}
        width={80}
      />,
    );

    expect(mockedUseMediaUrl).toHaveBeenCalledWith('version-portrait', 'version-time');
    expect(getByTestId('profile-portrait-image').props.children).toContain('"cacheKey":"version-portrait"');
    expect(queryByText('Portrait pending')).toBeNull();
  });

  it('preserves the legacy status fallback for an unenriched row', () => {
    const { getByText } = render(
      <FamilyProfilePortraitPhoto
        member={{
          name: 'Maya',
          profile_picture_key: 'legacy-photo',
          illustrated_profile_key: null,
          illustrated_profile_status: 'pending',
          updated_at: 'legacy-time',
        }}
        width={80}
      />,
    );

    expect(getByText('Portrait pending')).toBeTruthy();
  });
});
