import { act, fireEvent, render } from '@testing-library/react-native';
import { AccessibilityInfo, StyleSheet } from 'react-native';
import * as Reanimated from 'react-native-reanimated';

import { ArtworkCard } from '@/components/artwork/artwork-card';
import { artworkMemory } from '@/components/artwork/artwork-test-fixtures';
import { pickFrameStyle } from '@/components/artwork/frame-style';
import { MemoryEngagementBar } from '@/components/memory-engagement-bar';
import {
  consumeArtworkReveal,
  markArtworkForReveal,
  resetArtworkReveals,
} from '@/utils/artwork-reveal';

jest.mock('@/components/family-member-avatar', () => {
  const { Text } = jest.requireActual<typeof import('react-native')>('react-native');
  return {
    FamilyMemberAvatar: ({ member, testID }: { member: { name: string }; testID: string }) => (
      <Text testID={testID}>{member.name}</Text>
    ),
  };
});

jest.mock('@/components/memory-engagement-bar', () => ({
  MemoryEngagementBar: jest.fn(() => null),
}));

const mockRefetch = jest.fn();
jest.mock('@/hooks/useMediaUrls', () => ({
  useMediaUrls: jest.fn(() => ({
    data: {
      'user-1/memories/memory-1/media/asset-1-preview.jpg': 'https://signed/asset-1',
      'user-1/memories/memory-1/media/asset-2-preview.jpg': 'https://signed/asset-2',
    },
    refetch: mockRefetch,
  })),
  useMediaUrl: jest.fn(() => ({ url: null })),
}));

jest.mock('expo-image', () => {
  const { View: MockView } = jest.requireActual<typeof import('react-native')>('react-native');
  return {
    Image: (props: { testID?: string; onError?: () => void }) => (
      <MockView onTouchCancel={props.onError} testID={props.testID} />
    ),
  };
});

const mockedEngagementBar = MemoryEngagementBar as jest.Mock;

function renderCard(
  memory = artworkMemory(1),
  handlers: { onPress?: jest.Mock; onOpenComments?: jest.Mock } = {},
) {
  const onPress = handlers.onPress ?? jest.fn();
  const onOpenComments = handlers.onOpenComments ?? jest.fn();
  const utils = render(
    <ArtworkCard memory={memory} onOpenComments={onOpenComments} onPress={onPress} />,
  );
  return { ...utils, onPress, onOpenComments };
}

describe('ArtworkCard', () => {
  beforeEach(() => {
    resetArtworkReveals();
    mockedEngagementBar.mockClear();
    mockRefetch.mockClear();
    // The shared Reanimated mock's animation helpers are jest.fns that keep
    // their calls across tests.
    (Reanimated.withTiming as jest.Mock).mockClear();
  });
  afterEach(() => {
    jest.restoreAllMocks();
    // spyOn on the RN jest mock keeps the last implementation; put it back.
    (AccessibilityInfo.isReduceMotionEnabled as jest.Mock).mockResolvedValue(false);
  });

  describe('single piece', () => {
    it('hangs a framed piece with no white card, under the memory-card test id', () => {
      const { getByTestId } = renderCard();

      const root = getByTestId('memory-card-memory-1');
      expect(getByTestId('memory-card-memory-1-artwork-frame')).toBeTruthy();
      const flat = StyleSheet.flatten(root.props.style);
      expect(flat.backgroundColor).toBeUndefined();
      expect(flat.borderWidth).toBeUndefined();
    });

    it('draws the scan from the list-sized preview key', () => {
      const { getByTestId } = renderCard();
      expect(getByTestId('memory-card-memory-1-artwork-image-0')).toBeTruthy();
    });

    it('wears the frame derived from the asset id', () => {
      const { getByTestId } = renderCard();
      const { tilt } = pickFrameStyle('asset-1');

      const frame = getByTestId('memory-card-memory-1-artwork-frame');
      const rotate = StyleSheet.flatten(frame.props.style).transform?.[0];
      expect(rotate).toEqual({ rotate: `${tilt}deg` });
    });

    it('opens the detail on piece 0 when the frame is tapped', () => {
      const { getByTestId, onPress } = renderCard();

      fireEvent.press(getByTestId('memory-card-memory-1-artwork'));

      expect(onPress).toHaveBeenCalledWith('memory-1', 0);
    });

    it('opens the detail without a piece index from the label and the footer', () => {
      const { getByTestId, onPress } = renderCard();

      fireEvent.press(getByTestId('memory-card-content-memory-1'));
      expect(onPress).toHaveBeenLastCalledWith('memory-1');
      fireEvent.press(getByTestId('memory-card-footer-memory-1'));
      expect(onPress).toHaveBeenLastCalledWith('memory-1');
      expect(onPress).toHaveBeenCalledTimes(2);
    });

    it('refetches the signed URLs when the image fails to load', () => {
      const { getByTestId } = renderCard();
      fireEvent(getByTestId('memory-card-memory-1-artwork-image-0'), 'touchCancel');
      expect(mockRefetch).toHaveBeenCalledTimes(1);
    });
  });

  describe('label', () => {
    it('shows the caption as a handwritten title and "Artist, age"', () => {
      const { getByTestId } = renderCard();

      expect(getByTestId('memory-card-memory-1-artwork-title')).toHaveTextContent('“A dragon for Daddy”');
      expect(getByTestId('memory-card-memory-1-artwork-artist')).toHaveTextContent('Mara, 2 years');
    });

    it('omits the title when the caption is empty', () => {
      const { queryByTestId, getByTestId } = renderCard(artworkMemory(1, { content: '' }));

      expect(queryByTestId('memory-card-memory-1-artwork-title')).toBeNull();
      expect(getByTestId('memory-card-memory-1-artwork-artist')).toBeTruthy();
    });

    it('omits the artist line when nobody is tagged', () => {
      const { queryByTestId, getByTestId } = renderCard(artworkMemory(1, { taggedMembers: [] }));

      expect(getByTestId('memory-card-memory-1-artwork-title')).toBeTruthy();
      expect(queryByTestId('memory-card-memory-1-artwork-artist')).toBeNull();
    });

    it('omits the whole label with no caption and no artist', () => {
      const { queryByTestId } = renderCard(artworkMemory(1, { content: null, taggedMembers: [] }));

      expect(queryByTestId('memory-card-content-memory-1')).toBeNull();
    });
  });

  describe('chrome', () => {
    it('shows the medium chip (never the emotion chip) and the date footer', () => {
      const { getByTestId, queryByText, getByText } = renderCard();

      expect(getByTestId('artwork-medium-chip')).toHaveTextContent('crayon');
      expect(queryByText('joy')).toBeNull();
      expect(getByText(/Oct/i)).toBeTruthy();
    });

    it('falls back to the "Artwork" badge before the medium is known', () => {
      const { getByTestId } = renderCard(artworkMemory(1, { artwork_medium: null }));
      expect(getByTestId('artwork-badge')).toHaveTextContent('Artwork');
    });

    it('passes the engagement bar the share target and opens comments by id', () => {
      const { onOpenComments } = renderCard();

      const props = mockedEngagementBar.mock.calls[0]?.[0];
      expect(props).toEqual(
        expect.objectContaining({
          currentMediaAssetId: 'asset-1',
          enableShare: true,
          isCurrentPageVideo: false,
        }),
      );
      props.onOpenComments();
      expect(onOpenComments).toHaveBeenCalledWith('memory-1');
    });

    it('survives a legacy row with no asset rows', () => {
      const { getByTestId } = renderCard(artworkMemory(0, { media_key: 'user-1/legacy.jpg' }));
      expect(getByTestId('memory-card-memory-1-artwork-frame')).toBeTruthy();
    });
  });

  describe('batch', () => {
    it('renders the deck for two or more pieces, with the "n of N" tag', () => {
      const { getByTestId, getByText, queryByTestId } = renderCard(artworkMemory(3));

      expect(getByTestId('memory-card-memory-1-artwork-deck')).toBeTruthy();
      expect(getByText('1 of 3')).toBeTruthy();
      expect(getByTestId('memory-card-memory-1-artwork-frame')).toBeTruthy();
      expect(queryByTestId('memory-card-memory-1-artwork')).toBeNull();
    });

    it('opens the detail on the front piece', () => {
      const { getByTestId, onPress } = renderCard(artworkMemory(3));

      fireEvent.press(getByTestId('memory-card-memory-1-artwork-deck'));

      expect(onPress).toHaveBeenCalledWith('memory-1', 0);
    });

    it('keeps the label, engagement bar and footer under the deck', () => {
      const { getByTestId } = renderCard(artworkMemory(3));

      expect(getByTestId('memory-card-memory-1-artwork-title')).toBeTruthy();
      expect(getByTestId('artwork-medium-chip')).toBeTruthy();
      expect(mockedEngagementBar).toHaveBeenCalled();
    });

    it('points the share target at the front piece as the deck cycles', () => {
      const { getByTestId } = renderCard(artworkMemory(3));

      act(() => {
        fireEvent(getByTestId('memory-card-memory-1-artwork-deck'), 'accessibilityAction', {
          nativeEvent: { actionName: 'increment' },
        });
      });

      expect(mockedEngagementBar.mock.calls.at(-1)?.[0]).toEqual(
        expect.objectContaining({ currentMediaAssetId: 'asset-2' }),
      );
    });
  });

  describe('reveal', () => {
    it('consumes the reveal mark on mount and swings in', async () => {
      jest.spyOn(AccessibilityInfo, 'isReduceMotionEnabled').mockResolvedValue(false);
      const withSpring = jest.spyOn(Reanimated, 'withSpring');
      markArtworkForReveal('memory-1');

      renderCard();
      await act(async () => {});

      expect(consumeArtworkReveal('memory-1')).toBe(false);
      expect(withSpring).toHaveBeenCalledTimes(1);
    });

    it('plays once: a later mount of the same memory does not reveal', async () => {
      jest.spyOn(AccessibilityInfo, 'isReduceMotionEnabled').mockResolvedValue(false);
      const withSpring = jest.spyOn(Reanimated, 'withSpring');
      markArtworkForReveal('memory-1');

      const first = renderCard();
      await act(async () => {});
      first.unmount();
      withSpring.mockClear();
      renderCard();
      await act(async () => {});

      expect(withSpring).not.toHaveBeenCalled();
    });

    it('does not animate a memory that was never marked (loaded from the server)', async () => {
      const withSpring = jest.spyOn(Reanimated, 'withSpring');
      const withTiming = jest.spyOn(Reanimated, 'withTiming');

      renderCard();
      await act(async () => {});

      expect(withSpring).not.toHaveBeenCalled();
      expect(withTiming).not.toHaveBeenCalled();
    });

    it('takes the fade path with reduce motion on', async () => {
      jest.spyOn(AccessibilityInfo, 'isReduceMotionEnabled').mockResolvedValue(true);
      const withSpring = jest.spyOn(Reanimated, 'withSpring');
      const withTiming = jest.spyOn(Reanimated, 'withTiming');
      markArtworkForReveal('memory-1');

      renderCard();
      await act(async () => {});

      expect(withSpring).not.toHaveBeenCalled();
      expect(withTiming).toHaveBeenCalledWith(1, { duration: 250 });
    });

    it('reveals a posted batch too', async () => {
      jest.spyOn(AccessibilityInfo, 'isReduceMotionEnabled').mockResolvedValue(false);
      const withSpring = jest.spyOn(Reanimated, 'withSpring');
      markArtworkForReveal('memory-1');

      const { getByText } = renderCard(artworkMemory(3));
      await act(async () => {});

      expect(withSpring).toHaveBeenCalledTimes(1);
      expect(getByText('1 of 3')).toBeTruthy();
    });
  });
});
