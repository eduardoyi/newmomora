import { fireEvent, render } from '@testing-library/react-native';
import { StyleSheet } from 'react-native';

import { ARTWORK_NAIL_HEIGHT, getArtworkFrameSize } from '@/components/artwork-frame';
import { frameBodyBounds, frameVisualBounds } from '@/components/artwork/artwork-bounds';
import { fitArtWidthToHeight } from '@/components/artwork/artwork-piece';
import {
  GALLERY_WALK_TRACK_HEIGHT,
  GalleryWalk,
  getGalleryWalkArtWidth,
  getGalleryWalkLayout,
  indexForOffset,
} from '@/components/artwork/gallery-walk';
import {
  DETAIL_TILT_MAX,
  pickDetailTilt,
  pickFrameStyle,
  walkLeanDirection,
} from '@/components/artwork/frame-style';
import type { MemoryMediaAsset } from '@/services/memories';

function asset(index: number, aspectRatio: number | null = 0.75): MemoryMediaAsset {
  return {
    id: `asset-${index}`,
    memory_id: 'memory-1',
    object_key: `scan-${index}.jpg`,
    content_type: 'image/jpeg',
    duration_ms: null,
    aspect_ratio: aspectRatio,
    position: index,
    preview_object_key: null,
    share_card_key: null,
    waveform: null,
    created_at: '',
    updated_at: '',
  };
}

const ASSETS = [asset(0), asset(1, 1.5), asset(2, 1)];
const URLS = Object.fromEntries(ASSETS.map((a) => [a.object_key, `https://r2.test/${a.object_key}`]));
const SCREEN = 390;

function renderWalk(props: Partial<React.ComponentProps<typeof GalleryWalk>> = {}) {
  const onOpen = jest.fn();
  const onActiveIndexChange = jest.fn();
  const utils = render(
    <GalleryWalk
      assets={ASSETS}
      memoryId="memory-1"
      onActiveIndexChange={onActiveIndexChange}
      onOpen={onOpen}
      screenWidth={SCREEN}
      urls={URLS}
      {...props}
    />,
  );
  return { ...utils, onOpen, onActiveIndexChange };
}

describe('getGalleryWalkLayout', () => {
  it('spaces slides 0.67 of the screen apart and centers the first and last piece', () => {
    const layout = getGalleryWalkLayout(390);
    expect(layout.slideSpacing).toBe(261);
    // Content padding = (screen - spacing) / 2, so offset 0 centers piece 0
    // and nothing peeks past the ends.
    expect(layout.sidePadding).toBe(Math.round((390 - 261) / 2));
    expect(layout.trackHeight).toBe(GALLERY_WALK_TRACK_HEIGHT);
  });

  it('leaves 30-80px of each neighbour visible (tall pieces give a little to the lean)', () => {
    const layout = getGalleryWalkLayout(390);
    for (const ratio of [0.667, 1, 1.5]) {
      const frame = getArtworkFrameSize(getGalleryWalkArtWidth(layout, ratio), ratio);
      // The neighbour is one slide pitch away; its near edge sits this far
      // from the screen's edge.
      const visible = 390 - (390 / 2 + layout.slideSpacing - frame.width / 2);
      expect(visible).toBeGreaterThan(30);
      expect(visible).toBeLessThan(80);
    }
  });

  it('keeps every frame within its slide and the track, whatever the ratio', () => {
    const layout = getGalleryWalkLayout(390);
    for (const ratio of [0.3, 0.667, 1, 1.5, 3]) {
      const frame = getArtworkFrameSize(getGalleryWalkArtWidth(layout, ratio), ratio);
      expect(frame.width).toBeLessThan(layout.slideSpacing);
      expect(frame.height).toBeLessThan(layout.trackHeight);
    }
  });
});

describe('leaning frames fit their slide and the track', () => {
  const SCREENS = [320, 360, 390, 430];
  const RATIOS = [0.5, 0.667, 1, 1.5, 2];

  it('keeps a frame leaning the full DETAIL_TILT_MAX either way inside its half of the slide', () => {
    for (const screen of SCREENS) {
      const layout = getGalleryWalkLayout(screen);
      for (const ratio of RATIOS) {
        const size = getArtworkFrameSize(getGalleryWalkArtWidth(layout, ratio), ratio);
        for (const tilt of [-DETAIL_TILT_MAX, DETAIL_TILT_MAX]) {
          const body = frameBodyBounds(size.width, size.height, tilt, true);
          const halfExtent = Math.max(size.width / 2 - body.left, body.right - size.width / 2);
          // Neighbours lean opposite ways, so each gets half the pitch.
          expect(halfExtent * 2).toBeLessThanOrEqual(layout.slideSpacing);
        }
      }
    }
  });

  it('keeps the leaning frame, nail, string and shadow inside the track (the list clips)', () => {
    for (const screen of SCREENS) {
      const layout = getGalleryWalkLayout(screen);
      for (const ratio of RATIOS) {
        const size = getArtworkFrameSize(getGalleryWalkArtWidth(layout, ratio), ratio);
        // The slide centers [nail room + frame] in the track.
        const frameTop = (layout.trackHeight - ARTWORK_NAIL_HEIGHT - size.height) / 2 + ARTWORK_NAIL_HEIGHT;
        for (const tilt of [-DETAIL_TILT_MAX, DETAIL_TILT_MAX, 0]) {
          const visual = frameVisualBounds(size.width, size.height, tilt, true);
          expect(frameTop + visual.top).toBeGreaterThanOrEqual(0);
          expect(frameTop + visual.bottom).toBeLessThanOrEqual(layout.trackHeight);
        }
      }
    }
  });
});

describe('indexForOffset', () => {
  it('rounds to the nearest slide and clamps into range', () => {
    expect(indexForOffset(0, 261, 3)).toBe(0);
    expect(indexForOffset(130, 261, 3)).toBe(0);
    expect(indexForOffset(140, 261, 3)).toBe(1);
    expect(indexForOffset(522, 261, 3)).toBe(2);
    expect(indexForOffset(9999, 261, 3)).toBe(2);
    expect(indexForOffset(-50, 261, 3)).toBe(0);
    expect(indexForOffset(100, 0, 3)).toBe(0);
    expect(indexForOffset(100, 261, 0)).toBe(0);
  });
});

describe('fitArtWidthToHeight', () => {
  it('keeps the target when it fits and shrinks tall art under the cap', () => {
    expect(fitArtWidthToHeight(250, 0.663, 480)).toBe(250);
    const fitted = fitArtWidthToHeight(250, 0.3, 480);
    expect(fitted).toBeLessThan(250);
    expect(getArtworkFrameSize(fitted, 0.3).height).toBeLessThanOrEqual(480);
    // ...and is close to the largest width that fits.
    expect(getArtworkFrameSize(fitted + 3, 0.3).height).toBeGreaterThan(480);
  });
});

describe('GalleryWalk', () => {
  it('lays out a snapping horizontal list with centered content padding', () => {
    const { getByTestId } = renderWalk();
    const list = getByTestId('memory-detail-gallery-walk');
    const layout = getGalleryWalkLayout(SCREEN);

    expect(list.props.horizontal).toBe(true);
    expect(list.props.snapToInterval).toBe(layout.slideSpacing);
    expect(list.props.decelerationRate).toBe('fast');
    expect(list.props.contentContainerStyle).toEqual({ paddingHorizontal: layout.sidePadding });
    expect(list.props.getItemLayout(null, 2)).toEqual({
      index: 2,
      length: layout.slideSpacing,
      offset: layout.slideSpacing * 2,
    });
  });

  it('renders one nailed slide per piece, in the style picked from its asset id', () => {
    const { getAllByTestId, getByTestId } = renderWalk();

    expect(getAllByTestId(/^memory-media-image-/)).toHaveLength(3);
    // Current slide carries the shared testID; the others a numbered one.
    expect(getByTestId('memory-detail-artwork-frame')).toBeTruthy();
    expect(getByTestId('memory-detail-gallery-walk-slide-1')).toBeTruthy();
    expect(getByTestId('memory-detail-gallery-walk-slide-2')).toBeTruthy();
    // Same deterministic pick the Timeline makes.
    expect(pickFrameStyle('asset-1')).toEqual(pickFrameStyle('asset-1'));
  });

  it('leans every frame its own 1.5 to 4 degrees and neighbours opposite ways', () => {
    const { getByTestId } = renderWalk();
    const rotation = (testID: string) => {
      const transform = StyleSheet.flatten(getByTestId(testID).props.style).transform;
      return parseFloat(transform?.[0]?.rotate ?? 'NaN');
    };
    const tilts = [
      rotation('memory-detail-artwork-frame'),
      rotation('memory-detail-gallery-walk-slide-1'),
      rotation('memory-detail-gallery-walk-slide-2'),
    ];
    const first = ASSETS[0].id;
    expect(tilts).toEqual(
      ASSETS.map((a, index) => pickDetailTilt(a.id, walkLeanDirection(first, index))),
    );
    expect(Math.sign(tilts[0])).toBe(-Math.sign(tilts[1]));
    expect(Math.sign(tilts[1])).toBe(-Math.sign(tilts[2]));
    for (const tilt of tilts) {
      expect(Math.abs(tilt)).toBeGreaterThanOrEqual(1.5);
      expect(Math.abs(tilt)).toBeLessThanOrEqual(4);
    }
  });

  it('wears a lean of its own on the wall, not the Timeline tilt', () => {
    const { getByTestId } = renderWalk();
    const frame = getByTestId('memory-detail-artwork-frame');
    const timeline = pickFrameStyle(ASSETS[0].id);
    // Kind and color are the Timeline's pick; the tilt is replaced (bolder on the wall).
    expect(StyleSheet.flatten(frame.props.style).transform?.[0].rotate).not.toBe(`${timeline.tilt}deg`);
  });

  it('reports the initial index on mount and opens on it', () => {
    const { getByTestId, onActiveIndexChange } = renderWalk({ initialIndex: 2 });

    expect(onActiveIndexChange).toHaveBeenCalledWith(2);
    expect(getByTestId('memory-detail-gallery-walk').props.initialScrollIndex).toBe(2);
    expect(getByTestId('memory-detail-artwork-frame')).toBeTruthy();
  });

  it('clamps an out-of-range initial index', () => {
    const { onActiveIndexChange, getByTestId } = renderWalk({ initialIndex: 9 });
    expect(onActiveIndexChange).toHaveBeenCalledWith(2);
    expect(getByTestId('memory-detail-gallery-walk').props.initialScrollIndex).toBe(2);
  });

  it('reports the settled page after a scroll', () => {
    const { getByTestId, onActiveIndexChange } = renderWalk();
    onActiveIndexChange.mockClear();

    fireEvent(getByTestId('memory-detail-gallery-walk'), 'momentumScrollEnd', {
      nativeEvent: { contentOffset: { x: getGalleryWalkLayout(SCREEN).slideSpacing, y: 0 } },
    });

    expect(onActiveIndexChange).toHaveBeenCalledTimes(1);
    expect(onActiveIndexChange).toHaveBeenCalledWith(1);
  });

  it('opens the current piece on tap and scrolls to a peeking one', () => {
    const { getByLabelText, onOpen, onActiveIndexChange } = renderWalk();
    onActiveIndexChange.mockClear();

    fireEvent.press(getByLabelText('View artwork full screen'));
    expect(onOpen).toHaveBeenCalledWith(0);

    fireEvent.press(getByLabelText('Show piece 3 of 3'));
    expect(onOpen).toHaveBeenCalledTimes(1);
    expect(onActiveIndexChange).toHaveBeenCalledWith(2);
    // The tapped piece is now the current one.
    expect(getByLabelText('View artwork full screen')).toBeTruthy();
  });

  it('shows a spinner in a frame whose URL has not resolved yet', () => {
    const { queryByTestId } = renderWalk({ urls: {} });
    expect(queryByTestId('memory-media-image-asset-0')).toBeNull();
  });
});
