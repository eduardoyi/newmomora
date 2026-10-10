import { render } from '@testing-library/react-native';
import { StyleSheet, Text } from 'react-native';

import { ARTWORK_NAIL_HEIGHT, ArtworkFrame, getArtworkFrameSize } from '@/components/artwork-frame';
import { frameMetrics, type FrameKind } from '@/components/artwork/frame-geometry';
import { FRAME_KINDS } from '@/components/artwork/frame-style';
import { colors } from '@/constants/theme';

// react-native-svg renders as RNSVG* host nodes in the test renderer (see
// sound-trace.test.tsx); colors arrive pre-parsed, so assertions here stick
// to structure, geometry and the props that stay literal.
function findByType(node: any, typeName: string): any[] {
  if (!node || typeof node === 'string') return [];
  const matches: any[] = node.type === typeName ? [node] : [];
  for (const child of node.children ?? []) matches.push(...findByType(child, typeName));
  return matches;
}

const COLOR = colors.frameBlush;

function renderFrame(props: Partial<React.ComponentProps<typeof ArtworkFrame>> = {}) {
  return render(
    <ArtworkFrame
      artWidth={196}
      aspectRatio={0.66}
      color={COLOR}
      kind="scallop"
      testID="frame"
      {...props}
    >
      <Text testID="child">drawing</Text>
    </ArtworkFrame>,
  );
}

describe('getArtworkFrameSize', () => {
  it('derives the art height from the ratio and wraps it in band + mat', () => {
    const size = getArtworkFrameSize(196, 0.66);
    const artH = Math.round(196 / 0.66);
    const m = frameMetrics(196, artH);
    expect(size).toEqual({
      width: m.w,
      height: m.h,
      artWidth: 196,
      artHeight: artH,
      inset: m.band + m.mat,
    });
  });

  it('rounds a fractional width and tolerates a bad ratio', () => {
    expect(getArtworkFrameSize(195.6, 1).artWidth).toBe(196);
    expect(getArtworkFrameSize(100, 0).artHeight).toBe(100);
  });
});

describe('ArtworkFrame', () => {
  it('renders the child inside the mat opening with the inner-shadow overlay on top', () => {
    const { getByTestId, toJSON } = renderFrame();

    const opening = getByTestId('frame-opening');
    expect(opening).toContainElement(getByTestId('child'));
    expect(opening).toContainElement(getByTestId('frame-inner-shadow'));
    expect(getByTestId('frame')).toContainElement(opening);
    expect(findByType(toJSON(), 'RNSVGSvgView')).toHaveLength(1);

    const shadow = StyleSheet.flatten(getByTestId('frame-inner-shadow').props.style);
    expect(shadow.borderTopWidth).toBeGreaterThan(0);
    expect(getByTestId('frame-inner-shadow').props.pointerEvents).toBe('none');
  });

  it('sizes the box to the frame and positions the opening at band + mat', () => {
    const { getByTestId } = renderFrame();
    const size = getArtworkFrameSize(196, 0.66);

    const box = StyleSheet.flatten(getByTestId('frame').props.style);
    expect(box.width).toBe(size.width);
    expect(box.height).toBe(size.height);

    const opening = StyleSheet.flatten(getByTestId('frame-opening').props.style);
    expect(opening).toMatchObject({
      position: 'absolute',
      left: size.inset,
      top: size.inset,
      width: size.artWidth,
      height: size.artHeight,
      overflow: 'hidden',
    });
  });

  it('pads the SVG viewport past the frame box so the shadow is not clipped', () => {
    const { toJSON } = renderFrame();
    const size = getArtworkFrameSize(196, 0.66);
    const [svg] = findByType(toJSON(), 'RNSVGSvgView');
    expect(svg.props.width).toBeGreaterThan(size.width);
    expect(svg.props.height).toBeGreaterThan(size.height);
    const style = StyleSheet.flatten(svg.props.style);
    expect(style.position).toBe('absolute');
    expect(style.left).toBeLessThan(0);
    expect(style.top).toBeLessThan(0);
  });

  it('draws three stacked cast-shadow copies of the body under it', () => {
    const { toJSON } = renderFrame();
    const paths = findByType(toJSON(), 'RNSVGPath');
    const shadows = paths.filter((p) => p.props.fillOpacity !== undefined);
    expect(shadows.map((p) => p.props.fillOpacity)).toEqual([0.1, 0.07, 0.04]);
    const body = paths[paths.indexOf(shadows[2]) + 1];
    for (const shadow of shadows) {
      expect(shadow.props.d).toBe(body.props.d);
    }
  });

  it('rotates about top-center by default', () => {
    const { getByTestId } = renderFrame({ tilt: -2.5 });
    const box = StyleSheet.flatten(getByTestId('frame').props.style);
    expect(box.transform).toEqual([{ rotate: '-2.5deg' }]);
    expect(box.transformOrigin).toEqual(['50%', 0, 0]);
  });

  it('with a nail: draws the nail and string and rotates about the nail', () => {
    const plain = renderFrame();
    const nailed = renderFrame({ nail: true, tilt: 1.5 });
    const size = getArtworkFrameSize(196, 0.66);

    expect(findByType(plain.toJSON(), 'RNSVGCircle')).toHaveLength(0);
    const circles = findByType(nailed.toJSON(), 'RNSVGCircle');
    expect(circles).toHaveLength(2);
    expect(circles[0].props.cx).toBe(size.width / 2);
    expect(circles[0].props.cy).toBe(-30);

    const strings = findByType(nailed.toJSON(), 'RNSVGPath').filter((p) => p.props.d.includes(' -30 '));
    expect(strings).toHaveLength(1);

    const box = StyleSheet.flatten(nailed.getByTestId('frame').props.style);
    expect(box.transformOrigin).toEqual([size.width / 2, -30, 0]);
    // The viewport reaches up far enough to show the nail.
    const [svg] = findByType(nailed.toJSON(), 'RNSVGSvgView');
    expect(-StyleSheet.flatten(svg.props.style).top).toBeGreaterThanOrEqual(ARTWORK_NAIL_HEIGHT);
  });

  it('only gingham defines a check pattern; only bobble draws beads', () => {
    for (const kind of FRAME_KINDS) {
      const { toJSON } = renderFrame({ kind });
      expect(findByType(toJSON(), 'RNSVGPattern')).toHaveLength(kind === 'gingham' ? 1 : 0);
    }
    const bobble = findByType(renderFrame({ kind: 'bobble' }).toJSON(), 'RNSVGPath');
    const scallop = findByType(renderFrame({ kind: 'scallop' }).toJSON(), 'RNSVGPath');
    // bobble: 3 shadows + body + 2 bead paths + outline + lip + mat
    expect(bobble).toHaveLength(9);
    // scallop: 3 shadows + body + lip + mat
    expect(scallop).toHaveLength(6);
  });

  it('renders every kind in every position without throwing', () => {
    const kinds: FrameKind[] = [...FRAME_KINDS];
    for (const kind of kinds) {
      for (const [artWidth, aspectRatio] of [[120, 1.5], [196, 0.66], [250, 1]] as const) {
        const { getByTestId, unmount } = renderFrame({ kind, artWidth, aspectRatio, nail: true });
        expect(getByTestId('frame-opening')).toBeTruthy();
        unmount();
      }
    }
  });

  it('merges a caller style onto the outer box', () => {
    const { getByTestId } = renderFrame({ style: { marginTop: 3 } });
    expect(StyleSheet.flatten(getByTestId('frame').props.style).marginTop).toBe(3);
  });

  it('is memoized so unchanged props skip re-rendering', () => {
    expect((ArtworkFrame as unknown as { $$typeof: symbol }).$$typeof).toBe(Symbol.for('react.memo'));
  });
});
