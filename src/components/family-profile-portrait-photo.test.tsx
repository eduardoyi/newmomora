import { render } from '@testing-library/react-native';

import {
  FamilyProfilePortraitPhoto,
  type FamilyProfilePortraitMember,
} from '@/components/family-profile-portrait-photo';
import { useMediaUrl } from '@/hooks/useMediaUrls';

jest.mock('expo-image', () => ({
  Image: ({ accessibilityLabel, source }: { accessibilityLabel?: string; source?: unknown }) => {
    const { Text } = jest.requireActual<typeof import('react-native')>('react-native');
    return <Text testID="profile-portrait-image">{`${accessibilityLabel}:${JSON.stringify(source)}`}</Text>;
  },
}));

jest.mock('@/hooks/useMediaUrls', () => ({
  useMediaUrl: jest.fn(() => ({ url: 'https://signed.example/portrait', isLoading: false })),
}));

jest.mock('@/components/generating-visual-overlay', () => ({
  GeneratingVisualOverlay: ({ label }: { label: string }) => {
    const { Text } = jest.requireActual<typeof import('react-native')>('react-native');
    return <Text>{label}</Text>;
  },
}));

jest.mock('@/components/living-portrait-overlay', () => ({
  LivingPortraitOverlay: ({ motion }: { motion: { key: string; columns: number; rows: number } }) => {
    const { Text } = jest.requireActual<typeof import('react-native')>('react-native');
    return <Text testID="living-portrait-overlay">{`${motion.key}:${motion.columns}x${motion.rows}`}</Text>;
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

describe('FamilyProfilePortraitPhoto living portrait', () => {
  const readyVersion = {
    illustrated_profile_key: 'version-portrait',
    illustrated_profile_status: 'ready',
    motion_status: 'ready',
    motion_key: 'version-portrait-motion',
    motion_source_key: 'version-portrait',
    motion_columns: 3,
    motion_rows: 3,
  } as unknown as NonNullable<FamilyProfilePortraitMember['resolvedPortraitVersion']>;

  const animatedMember: FamilyProfilePortraitMember = {
    name: 'Maya',
    profile_picture_key: 'legacy-photo',
    illustrated_profile_key: null,
    illustrated_profile_status: 'pending',
    updated_at: 'legacy-time',
    avatarImageKey: 'version-portrait',
    avatarStatus: 'ready',
    avatarUpdatedAt: 'version-time',
    resolvedPortraitVersion: readyVersion,
  };

  beforeEach(() => {
    mockedUseMediaUrl.mockReturnValue({ url: 'https://signed.example/portrait', isLoading: false, isError: false });
  });

  it('overlays the loop over the ready portrait when animated', () => {
    const { getByTestId } = render(<FamilyProfilePortraitPhoto animated member={animatedMember} width={80} />);

    expect(getByTestId('living-portrait-overlay').props.children).toBe('version-portrait-motion:3x3');
  });

  it('stays still unless animation is asked for', () => {
    const { queryByTestId } = render(<FamilyProfilePortraitPhoto member={animatedMember} width={80} />);

    expect(queryByTestId('living-portrait-overlay')).toBeNull();
  });

  it('does not animate a local photo pick', () => {
    const { queryByTestId } = render(
      <FamilyProfilePortraitPhoto animated localPhotoUri="file:///picked.jpg" member={animatedMember} width={80} />,
    );

    expect(queryByTestId('living-portrait-overlay')).toBeNull();
  });

  it('does not animate while a portrait is generating', () => {
    const { queryByTestId } = render(
      <FamilyProfilePortraitPhoto animated forceGeneratingOverlay member={animatedMember} width={80} />,
    );
    expect(queryByTestId('living-portrait-overlay')).toBeNull();

    const regenerating = render(
      <FamilyProfilePortraitPhoto animated member={{ ...animatedMember, avatarStatus: 'generating' }} width={80} />,
    );
    expect(regenerating.queryByTestId('living-portrait-overlay')).toBeNull();
  });

  it('does not animate when the sheet was made from a different still', () => {
    const { queryByTestId } = render(
      <FamilyProfilePortraitPhoto
        animated
        member={{
          ...animatedMember,
          resolvedPortraitVersion: { ...readyVersion, motion_source_key: 'older-portrait' },
        }}
        width={80}
      />,
    );

    expect(queryByTestId('living-portrait-overlay')).toBeNull();
  });

  it('does not animate when the displayed image is not the resolved version still', () => {
    const { queryByTestId } = render(
      <FamilyProfilePortraitPhoto
        animated
        member={{ ...animatedMember, avatarImageKey: 'source-photo' }}
        width={80}
      />,
    );

    expect(queryByTestId('living-portrait-overlay')).toBeNull();
  });

  it('does not animate a member without a resolved version (legacy or cached rows)', () => {
    const { queryByTestId } = render(
      <FamilyProfilePortraitPhoto
        animated
        member={{ ...animatedMember, resolvedPortraitVersion: undefined }}
        width={80}
      />,
    );

    expect(queryByTestId('living-portrait-overlay')).toBeNull();
  });
});
