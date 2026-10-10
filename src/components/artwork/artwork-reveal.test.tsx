import { act, render } from '@testing-library/react-native';
import { AccessibilityInfo, Text } from 'react-native';
import * as Reanimated from 'react-native-reanimated';

import {
  ArtworkRevealDriver,
  REVEAL_DROP_PX,
  REVEAL_SPRING,
  REVEAL_START_TILT,
  useShouldRevealArtwork,
} from '@/components/artwork/artwork-reveal';
import { markArtworkForReveal, resetArtworkReveals } from '@/utils/artwork-reveal';

function Probe({ memoryId, onReveal }: { memoryId: string; onReveal: (value: boolean) => void }) {
  onReveal(useShouldRevealArtwork(memoryId));
  return null;
}

describe('useShouldRevealArtwork', () => {
  beforeEach(() => resetArtworkReveals());

  it('is true once for a marked memory and false on a later mount', () => {
    markArtworkForReveal('memory-1');
    const first = jest.fn();
    const second = jest.fn();

    render(<Probe memoryId="memory-1" onReveal={first} />);
    render(<Probe memoryId="memory-1" onReveal={second} />);

    expect(first).toHaveBeenLastCalledWith(true);
    expect(second).toHaveBeenLastCalledWith(false);
  });

  it('keeps its answer across re-renders of the same mount', () => {
    markArtworkForReveal('memory-1');
    const onReveal = jest.fn();
    const { rerender } = render(<Probe memoryId="memory-1" onReveal={onReveal} />);

    rerender(<Probe memoryId="memory-1" onReveal={onReveal} />);

    expect(onReveal.mock.calls.map(([value]) => value)).toEqual([true, true]);
  });

  it('is false for a memory that was never marked', () => {
    const onReveal = jest.fn();
    render(<Probe memoryId="memory-2" onReveal={onReveal} />);
    expect(onReveal).toHaveBeenLastCalledWith(false);
  });
});

describe('ArtworkRevealDriver', () => {
  beforeEach(() => {
    // The shared Reanimated mock's animation helpers are jest.fns that keep
    // their calls across tests.
    (Reanimated.withTiming as jest.Mock).mockClear();
  });
  afterEach(() => {
    jest.restoreAllMocks();
    // spyOn on the RN jest mock keeps the last implementation; put it back.
    (AccessibilityInfo.isReduceMotionEnabled as jest.Mock).mockResolvedValue(false);
  });

  function renderDriver(tilt = -2) {
    let latest: Parameters<React.ComponentProps<typeof ArtworkRevealDriver>['children']>[0] | null = null;
    const tree = () => (
      <ArtworkRevealDriver tilt={tilt}>
        {(styles) => {
          latest = styles;
          return <Text>child</Text>;
        }}
      </ArtworkRevealDriver>
    );
    const utils = render(tree());
    // Shared-value writes don't re-render under the Reanimated mock; a
    // re-render reads the settled styles.
    return { ...utils, styles: () => latest, settle: () => utils.rerender(tree()) };
  }

  it('starts hidden, 40px up and tilted 9 degrees, before the motion setting is known', () => {
    jest.spyOn(AccessibilityInfo, 'isReduceMotionEnabled').mockReturnValue(new Promise(() => {}));
    const { styles } = renderDriver(-2);

    expect(styles()?.frame).toEqual({
      opacity: 0,
      transform: [{ translateY: -REVEAL_DROP_PX }, { rotate: `${REVEAL_START_TILT + 2}deg` }],
    });
    expect(styles()?.label).toEqual({ opacity: 0 });
  });

  it('drops in and swings with a spring, then settles at its own tilt', async () => {
    jest.spyOn(AccessibilityInfo, 'isReduceMotionEnabled').mockResolvedValue(false);
    const withSpring = jest.spyOn(Reanimated, 'withSpring');
    const withTiming = jest.spyOn(Reanimated, 'withTiming');
    const { styles, settle } = renderDriver(-2);

    await act(async () => {});
    settle();

    // Drop: 380ms. Swing: an underdamped spring back to the piece's own tilt
    // (the delta is 0). Label: fades in last.
    expect(withTiming).toHaveBeenCalledWith(0, expect.objectContaining({ duration: 380 }));
    expect(withSpring).toHaveBeenCalledWith(0, REVEAL_SPRING);
    expect(REVEAL_SPRING.damping).toBeLessThan(2 * Math.sqrt(REVEAL_SPRING.stiffness * REVEAL_SPRING.mass));
    expect(styles()?.frame).toEqual({
      opacity: 1,
      transform: [{ translateY: 0 }, { rotate: '0deg' }],
    });
    expect(styles()?.label).toEqual({ opacity: 1 });
  });

  it('is a plain fade with reduce motion on: no drop, no spring', async () => {
    jest.spyOn(AccessibilityInfo, 'isReduceMotionEnabled').mockResolvedValue(true);
    const withSpring = jest.spyOn(Reanimated, 'withSpring');
    const withTiming = jest.spyOn(Reanimated, 'withTiming');
    const { styles, settle } = renderDriver(-2);

    await act(async () => {});
    settle();

    expect(withSpring).not.toHaveBeenCalled();
    expect(withTiming).toHaveBeenCalledWith(1, { duration: 250 });
    expect(withTiming).not.toHaveBeenCalledWith(0, expect.objectContaining({ duration: 380 }));
    expect(styles()?.frame).toEqual({
      opacity: 1,
      transform: [{ translateY: 0 }, { rotate: '0deg' }],
    });
  });

  it('does not start if it unmounts before the motion setting resolves', async () => {
    let resolve: (value: boolean) => void = () => {};
    jest
      .spyOn(AccessibilityInfo, 'isReduceMotionEnabled')
      .mockReturnValue(new Promise<boolean>((r) => (resolve = r)));
    const withSpring = jest.spyOn(Reanimated, 'withSpring');
    const { unmount } = renderDriver();

    unmount();
    await act(async () => resolve(false));

    expect(withSpring).not.toHaveBeenCalled();
  });
});
