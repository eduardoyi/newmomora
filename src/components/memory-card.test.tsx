import { act, fireEvent, render } from '@testing-library/react-native';
import { useState } from 'react';
import { Pressable } from 'react-native';

import { MemoryCard } from '@/components/memory-card';
import { MemoryEngagementBar } from '@/components/memory-engagement-bar';
import { MemoryMediaCarousel } from '@/components/memory-media-carousel';
import { useAudioClipPlayback } from '@/hooks/useAudioClipPlayback';
import { useMediaUrl } from '@/hooks/useMediaUrls';
import type { MemoryWithTags } from '@/services/memories';

jest.mock('@/components/family-member-avatar', () => {
  const { Text } = jest.requireActual<typeof import('react-native')>('react-native');

  return {
    FamilyMemberAvatar: ({ member, testID }: { member: { name: string }; testID: string }) => (
      <Text testID={testID}>{member.name}</Text>
    ),
  };
});

// A jest.fn() child (rather than the usual `() => null`) doubles as the
// render-count probe for the memoization test below: MemoryCard is the only
// thing that renders it, so its call count mirrors MemoryCard's own render
// count.
jest.mock('@/components/memory-engagement-bar', () => ({
  MemoryEngagementBar: jest.fn(() => null),
}));

jest.mock('@/components/memory-media-carousel', () => ({
  MemoryMediaCarousel: jest.fn(() => null),
}));

jest.mock('@/hooks/useMediaUrls', () => ({
  useMediaUrl: jest.fn(() => ({ url: null })),
}));

jest.mock('@/hooks/useAudioClipPlayback', () => ({
  useAudioClipPlayback: jest.fn(() => ({
    playing: false,
    position: 0,
    duration: 0,
    progress: 0,
    loading: false,
    error: null,
    toggle: jest.fn(),
    seekTo: jest.fn(),
  })),
}));

const createMember = (index: number) => ({
  id: `member-${index}`,
  user_id: 'user-1',
  family_id: 'family-1',
  name: `Member ${index}`,
  nicknames: [],
  date_of_birth: null,
  gender: null,
  profile_picture_key: null,
  illustrated_profile_key: null,
  illustrated_profile_status: 'ready',
  additional_info: null,
  is_user_profile: false,
  created_at: '2026-07-14T00:00:00.000Z',
  updated_at: '2026-07-14T00:00:00.000Z',
});

const createMemory = (memberCount: number) => ({
  id: 'memory-1',
  user_id: 'user-1',
  family_id: 'family-1',
  content: 'A family memory',
  memory_date: '2026-07-14',
  memory_type: 'text_only',
  emotion: null,
  illustration_key: null,
  illustration_status: 'none',
  illustration_prompt: null,
  media_key: null,
  media_content_type: null,
  link_previews: {},
  created_at: '2026-07-14T00:00:00.000Z',
  updated_at: '2026-07-14T00:00:00.000Z',
  taggedMembers: Array.from({ length: memberCount }, (_, index) => createMember(index + 1)),
  mediaAssets: [],
  likeCount: 0,
  commentCount: 0,
  likedByMe: false,
}) as MemoryWithTags;

describe('MemoryCard media (Workstream C6)', () => {
  it('requests the preview key by passing preferPreview to MemoryMediaCarousel', () => {
    const mockedCarousel = MemoryMediaCarousel as jest.Mock;
    mockedCarousel.mockClear();

    const memory = {
      ...createMemory(0),
      memory_type: 'media',
      mediaAssets: [
        {
          id: 'asset-1',
          memory_id: 'memory-1',
          object_key: 'user-1/memories/memory-1/media/asset-1.jpg',
          preview_object_key: 'user-1/memories/memory-1/media/asset-1-preview.jpg',
          content_type: 'image/jpeg',
          duration_ms: null,
          aspect_ratio: null,
          position: 0,
          created_at: '2026-07-14T00:00:00.000Z',
          updated_at: '2026-07-14T00:00:00.000Z',
        },
      ],
    } as MemoryWithTags;

    render(<MemoryCard memory={memory} onOpenComments={jest.fn()} onPress={jest.fn()} />);

    expect(mockedCarousel.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({ preferPreview: true }),
    );
  });

  it('reports the tapped carousel page so the detail screen opens on it', () => {
    const mockedCarousel = MemoryMediaCarousel as jest.Mock;
    mockedCarousel.mockClear();

    const memory = {
      ...createMemory(0),
      memory_type: 'media',
      mediaAssets: [
        {
          id: 'asset-1',
          memory_id: 'memory-1',
          object_key: 'user-1/memories/memory-1/media/asset-1.jpg',
          content_type: 'image/jpeg',
          position: 0,
          created_at: '2026-07-14T00:00:00.000Z',
        },
        {
          id: 'asset-2',
          memory_id: 'memory-1',
          object_key: 'user-1/memories/memory-1/media/asset-2.jpg',
          content_type: 'image/jpeg',
          position: 1,
          created_at: '2026-07-14T00:00:00.000Z',
        },
      ],
    } as MemoryWithTags;
    const onPress = jest.fn();

    const { getByTestId } = render(
      <MemoryCard memory={memory} onOpenComments={jest.fn()} onPress={onPress} />,
    );

    // Tapping the second carousel page carries its index up...
    act(() => mockedCarousel.mock.calls[0]?.[0].onPress(1));
    expect(onPress).toHaveBeenCalledWith('memory-1', 1);

    // ...while the caption/footer below the carousel has no page context.
    onPress.mockClear();
    fireEvent.press(getByTestId('memory-card-content-memory-1'));
    expect(onPress).toHaveBeenCalledWith('memory-1');
  });
});

describe('MemoryCard share affordance (Workstream S4)', () => {
  it('passes the active carousel page as the share target and flags video pages', () => {
    const mockedCarousel = MemoryMediaCarousel as jest.Mock;
    const mockedEngagementBar = MemoryEngagementBar as jest.Mock;
    mockedCarousel.mockClear();
    mockedEngagementBar.mockClear();

    const memory = {
      ...createMemory(0),
      memory_type: 'media',
      mediaAssets: [
        {
          id: 'asset-1',
          memory_id: 'memory-1',
          object_key: 'user-1/memories/memory-1/media/asset-1.jpg',
          content_type: 'image/jpeg',
          position: 0,
          created_at: '2026-07-14T00:00:00.000Z',
        },
        {
          id: 'asset-2',
          memory_id: 'memory-1',
          object_key: 'user-1/memories/memory-1/media/asset-2.mp4',
          content_type: 'video/mp4',
          position: 1,
          created_at: '2026-07-14T00:00:00.000Z',
        },
      ],
    } as MemoryWithTags;

    render(<MemoryCard memory={memory} onOpenComments={jest.fn()} onPress={jest.fn()} />);

    // Initial (photo) page: shareable, enabled.
    expect(mockedEngagementBar.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({
        enableShare: true,
        currentMediaAssetId: 'asset-1',
        isCurrentPageVideo: false,
      }),
    );

    // Carousel reports the swipe over to the video page...
    act(() => mockedCarousel.mock.calls[0]?.[0].onActiveIndexChange(1));

    // ...and the bar re-renders with the video page disabling share.
    expect(mockedEngagementBar.mock.calls.at(-1)?.[0]).toEqual(
      expect.objectContaining({
        enableShare: true,
        currentMediaAssetId: 'asset-2',
        isCurrentPageVideo: true,
      }),
    );
  });

  it('enables share without a mediaAssetId for text-only memories', () => {
    const mockedEngagementBar = MemoryEngagementBar as jest.Mock;
    mockedEngagementBar.mockClear();

    render(<MemoryCard memory={createMemory(0)} onOpenComments={jest.fn()} onPress={jest.fn()} />);

    expect(mockedEngagementBar.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({ enableShare: true, currentMediaAssetId: null }),
    );
  });

  it('enables share without a mediaAssetId for illustrated memories', () => {
    const mockedEngagementBar = MemoryEngagementBar as jest.Mock;
    mockedEngagementBar.mockClear();

    const memory = {
      ...createMemory(0),
      memory_type: 'text_illustration',
      illustration_status: 'ready',
    } as MemoryWithTags;

    render(<MemoryCard memory={memory} onOpenComments={jest.fn()} onPress={jest.fn()} />);

    expect(mockedEngagementBar.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({ enableShare: true, currentMediaAssetId: null }),
    );
  });
});

describe('MemoryCard failed illustration overlay', () => {
  it('shows a tap-to-retry hint over a retained illustration that failed to regenerate', () => {
    (useMediaUrl as jest.Mock).mockReturnValueOnce({
      url: 'https://example.com/illustration.webp',
    });

    const memory = {
      ...createMemory(0),
      memory_type: 'text_illustration',
      illustration_key: 'user-1/memories/memory-1/illustration.webp',
      illustration_status: 'failed',
    } as MemoryWithTags;

    const { getByText } = render(
      <MemoryCard memory={memory} onOpenComments={jest.fn()} onPress={jest.fn()} />,
    );

    expect(getByText('Illustration failed — tap to retry')).toBeTruthy();
  });
});

describe('MemoryCard illustration cacheKey (Workstream O5)', () => {
  it('pins expo-image cacheKey to the illustration object key, not the signed URL', () => {
    (useMediaUrl as jest.Mock).mockReturnValueOnce({
      url: 'https://example.com/illustration.webp?sig=abc',
    });

    const memory = {
      ...createMemory(0),
      memory_type: 'text_illustration',
      illustration_key: 'user-1/memories/memory-1/illustration.webp',
      illustration_status: 'ready',
    } as MemoryWithTags;

    const { getByTestId } = render(
      <MemoryCard memory={memory} onOpenComments={jest.fn()} onPress={jest.fn()} />,
    );

    expect(getByTestId('memory-card-memory-1-illustration').props.source).toEqual([{
      uri: 'https://example.com/illustration.webp?sig=abc',
      cacheKey: 'user-1/memories/memory-1/illustration.webp',
    }]);
  });

  it('omits cacheKey when there is no illustration key (defensive -- illustration_key drives the fetch itself)', () => {
    (useMediaUrl as jest.Mock).mockReturnValueOnce({
      url: 'https://example.com/illustration.webp',
    });

    const memory = {
      ...createMemory(0),
      memory_type: 'text_illustration',
      illustration_key: null,
      illustration_status: 'ready',
    } as MemoryWithTags;

    const { getByTestId } = render(
      <MemoryCard memory={memory} onOpenComments={jest.fn()} onPress={jest.fn()} />,
    );

    expect(getByTestId('memory-card-memory-1-illustration').props.source).toEqual([{
      uri: 'https://example.com/illustration.webp',
    }]);
  });
});

describe('MemoryCard tagged member avatars', () => {
  it('shows all six tagged members without an overflow indicator', () => {
    const { getByTestId, queryByTestId } = render(
      <MemoryCard
        memory={createMemory(6)}
        onOpenComments={jest.fn()}
        onPress={jest.fn()}
      />,
    );

    expect(getByTestId('memory-card-member-member-6')).toBeTruthy();
    expect(queryByTestId('memory-card-member-overflow')).toBeNull();
  });

  it('shows six tagged members and a count for the remaining members', () => {
    const { getByLabelText, getByTestId, queryByTestId } = render(
      <MemoryCard
        memory={createMemory(8)}
        onOpenComments={jest.fn()}
        onPress={jest.fn()}
      />,
    );

    expect(getByTestId('memory-card-member-member-6')).toBeTruthy();
    expect(queryByTestId('memory-card-member-member-7')).toBeNull();
    expect(getByTestId('memory-card-member-overflow')).toHaveTextContent('+2');
    expect(getByLabelText('2 more tagged members')).toBeTruthy();
  });
});

describe('MemoryCard audio variant (P3.1, docs/plans/audio-memories-v1.md)', () => {
  const audioMemory = (overrides: Partial<MemoryWithTags> = {}) => ({
    ...createMemory(0),
    memory_type: 'audio',
    content: 'Lila singing Twinkle Twinkle in the bath.',
    media_key: 'user-1/memories/memory-1/media/clip-1.m4a',
    media_content_type: 'audio/mp4',
    mediaAssets: [
      {
        id: 'clip-1',
        memory_id: 'memory-1',
        object_key: 'user-1/memories/memory-1/media/clip-1.m4a',
        content_type: 'audio/mp4',
        duration_ms: 42_000,
        aspect_ratio: null,
        position: 0,
        preview_object_key: null,
        share_card_key: null,
        created_at: '2026-07-14T00:00:00.000Z',
        updated_at: '2026-07-14T00:00:00.000Z',
      },
    ],
    ...overrides,
  }) as MemoryWithTags;

  const mockedUseAudioClipPlayback = useAudioClipPlayback as jest.Mock;

  beforeEach(() => {
    mockedUseAudioClipPlayback.mockReturnValue({
      playing: false,
      position: 0,
      duration: 42,
      progress: 0,
      loading: false,
      error: null,
      toggle: jest.fn(),
      seekTo: jest.fn(),
    });
  });

  it('renders the stub band idle, with the caption and no share affordance', () => {
    const mockedEngagementBar = MemoryEngagementBar as jest.Mock;
    mockedEngagementBar.mockClear();

    const memory = audioMemory();
    const { getByTestId, getByText } = render(
      <MemoryCard memory={memory} onOpenComments={jest.fn()} onPress={jest.fn()} />,
    );

    expect(getByTestId('memory-card-memory-1-stub')).toBeTruthy();
    expect(getByTestId('memory-card-memory-1-stub-seal')).toBeTruthy();
    expect(getByText('Lila singing Twinkle Twinkle in the bath.')).toBeTruthy();
    expect(mockedEngagementBar.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({ enableShare: false }),
    );
  });

  it('toggles playback via the seal without navigating to detail', () => {
    const toggle = jest.fn();
    mockedUseAudioClipPlayback.mockReturnValue({
      playing: true,
      position: 12,
      duration: 42,
      progress: 12 / 42,
      loading: false,
      error: null,
      toggle,
      seekTo: jest.fn(),
    });

    const onPress = jest.fn();
    const memory = audioMemory();
    const { getByTestId } = render(
      <MemoryCard memory={memory} onOpenComments={jest.fn()} onPress={onPress} />,
    );

    fireEvent.press(getByTestId('memory-card-memory-1-stub-seal'));
    expect(toggle).toHaveBeenCalledTimes(1);
    expect(onPress).not.toHaveBeenCalled();
  });

  it('opens the memory detail screen when the card body is tapped', () => {
    const onPress = jest.fn();
    const memory = audioMemory();
    const { getByTestId } = render(
      <MemoryCard memory={memory} onOpenComments={jest.fn()} onPress={onPress} />,
    );

    fireEvent.press(getByTestId('memory-card-content-memory-1'));
    expect(onPress).toHaveBeenCalledWith('memory-1');
  });

  it('omits the caption block for a clip with no description', () => {
    const memory = audioMemory({ content: null });
    const { queryByText } = render(
      <MemoryCard memory={memory} onOpenComments={jest.fn()} onPress={jest.fn()} />,
    );

    expect(queryByText('Lila singing Twinkle Twinkle in the bath.')).toBeNull();
  });

  it('renders the neutral graphite treatment before emotion analysis lands', () => {
    const memory = audioMemory({ emotion: null });
    const { getByTestId } = render(
      <MemoryCard memory={memory} onOpenComments={jest.fn()} onPress={jest.fn()} />,
    );

    // Renders without an emotion chip and without crashing on a null
    // emotion -- the kit's resolveAudioEmotionColors neutral fallback.
    expect(getByTestId('memory-card-memory-1-stub')).toBeTruthy();
  });
});

describe('MemoryCard unknown memory_type (P0.1 forward-compat fallback)', () => {
  it('renders the caption as text and offers no share button when content is present', () => {
    const mockedEngagementBar = MemoryEngagementBar as jest.Mock;
    mockedEngagementBar.mockClear();

    const memory = {
      ...createMemory(0),
      memory_type: 'hologram',
      content: 'A giggle worth keeping',
    } as unknown as MemoryWithTags;

    const { getByText, queryByTestId } = render(
      <MemoryCard memory={memory} onOpenComments={jest.fn()} onPress={jest.fn()} />,
    );

    expect(getByText('A giggle worth keeping')).toBeTruthy();
    expect(queryByTestId('memory-card-memory-1-unavailable')).toBeNull();
    expect(mockedEngagementBar.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({ enableShare: false }),
    );
  });

  it('shows a muted update notice instead of an empty box when content is missing', () => {
    const memory = {
      ...createMemory(0),
      memory_type: 'hologram',
      content: null,
    } as unknown as MemoryWithTags;

    const { getByTestId } = render(
      <MemoryCard memory={memory} onOpenComments={jest.fn()} onPress={jest.fn()} />,
    );

    expect(getByTestId('memory-card-memory-1-unavailable')).toHaveTextContent(
      'Update Momora to play this memory.',
    );
  });

  it('still opens the detail screen on press, like every other card', () => {
    const memory = {
      ...createMemory(0),
      memory_type: 'hologram',
      content: 'A giggle worth keeping',
    } as unknown as MemoryWithTags;
    const onPress = jest.fn();

    const { getByTestId } = render(
      <MemoryCard memory={memory} onOpenComments={jest.fn()} onPress={onPress} />,
    );

    fireEvent.press(getByTestId('memory-card-content-memory-1'));
    expect(onPress).toHaveBeenCalledWith('memory-1');
  });
});

describe('MemoryCard memoization (Workstream B1)', () => {
  it('does not re-render when a parent re-renders on unrelated state', () => {
    const mockedEngagementBar = MemoryEngagementBar as jest.Mock;
    mockedEngagementBar.mockClear();

    // Defined once and reused across renders (not recreated inside Harness)
    // so the props MemoryCard receives stay referentially equal -- the
    // condition React.memo needs to actually bail out.
    const memory = createMemory(1);
    const onPress = jest.fn();
    const onOpenComments = jest.fn();

    function Harness() {
      const [, setTick] = useState(0);
      return (
        <>
          <MemoryCard memory={memory} onOpenComments={onOpenComments} onPress={onPress} />
          <Pressable onPress={() => setTick((t) => t + 1)} testID="bump-unrelated-state" />
        </>
      );
    }

    const { getByTestId } = render(<Harness />);
    expect(mockedEngagementBar).toHaveBeenCalledTimes(1);

    act(() => {
      fireEvent.press(getByTestId('bump-unrelated-state'));
    });

    expect(mockedEngagementBar).toHaveBeenCalledTimes(1);
  });
});
