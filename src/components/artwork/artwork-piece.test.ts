import { ARTWORK_NAIL_HEIGHT, getArtworkFrameSize } from '@/components/artwork-frame';
import { frameBodyBounds, frameVisualBounds } from '@/components/artwork/artwork-bounds';
import {
  DETAIL_SINGLE_MAX_FRAME_HEIGHT,
  DETAIL_SINGLE_WIDTH_RATIO,
  getDetailSingleLayout,
} from '@/components/artwork/artwork-piece';
import { DETAIL_TILT_MAX } from '@/components/artwork/frame-style';

describe('getDetailSingleLayout', () => {
  const SCREENS = [320, 360, 390, 430, 768];
  const RATIOS = [0.5, 0.667, 1, 1.5, 2];

  it('keeps the 64% width and 480px height clamp for ordinary art', () => {
    const layout = getDetailSingleLayout(390, 0.75);
    expect(layout.artWidth).toBeLessThanOrEqual(Math.round(390 * DETAIL_SINGLE_WIDTH_RATIO));
    expect(getArtworkFrameSize(layout.artWidth, 0.75).height).toBeLessThanOrEqual(
      DETAIL_SINGLE_MAX_FRAME_HEIGHT,
    );
  });

  it('keeps the frame leaning the full DETAIL_TILT_MAX either way inside the screen', () => {
    for (const screen of SCREENS) {
      for (const ratio of RATIOS) {
        const { artWidth } = getDetailSingleLayout(screen, ratio);
        const size = getArtworkFrameSize(artWidth, ratio);
        for (const tilt of [-DETAIL_TILT_MAX, DETAIL_TILT_MAX]) {
          const body = frameBodyBounds(size.width, size.height, tilt, true);
          expect(size.width / 2 - body.left).toBeLessThanOrEqual(screen / 2);
          expect(body.right - size.width / 2).toBeLessThanOrEqual(screen / 2);
        }
      }
    }
  });

  it('reserves the nail and the lean\'s lift above the frame', () => {
    for (const screen of SCREENS) {
      for (const ratio of RATIOS) {
        const { artWidth, topPad } = getDetailSingleLayout(screen, ratio);
        const size = getArtworkFrameSize(artWidth, ratio);
        expect(topPad).toBeGreaterThanOrEqual(ARTWORK_NAIL_HEIGHT + 8);
        for (const tilt of [-DETAIL_TILT_MAX, 0, DETAIL_TILT_MAX]) {
          expect(-frameVisualBounds(size.width, size.height, tilt, true).top).toBeLessThanOrEqual(topPad);
        }
      }
    }
  });
});
