import { act, fireEvent, render } from '@testing-library/react-native';
import { AccessibilityInfo } from 'react-native';
import { State } from 'react-native-gesture-handler';
import { fireGestureHandler, getByGestureTestId } from 'react-native-gesture-handler/jest-utils';
import { withTiming } from 'react-native-reanimated';

import { ArtworkDeck } from '@/components/artwork/artwork-deck';
import {
  artworkTestDeckLayout,
  artworkTestPieces,
} from '@/components/artwork/artwork-test-fixtures';

jest.mock('expo-image', () => {
  const { View: MockView } = jest.requireActual<typeof import('react-native')>('react-native');
  return { Image: (props: { testID?: string }) => <MockView testID={props.testID} /> };
});

const mockedWithTiming = withTiming as jest.Mock;

function renderDeck(count: number, props: Partial<React.ComponentProps<typeof ArtworkDeck>> = {}) {
  const pieces = artworkTestPieces(count);
  const urls = Object.fromEntries(pieces.map((p) => [p.displayKey, `https://signed/${p.id}`]));
  const onOpen = jest.fn();
  const onFrontChange = jest.fn();
  const utils = render(
    <ArtworkDeck
      layout={artworkTestDeckLayout(count)}
      memoryId="memory-1"
      onFrontChange={onFrontChange}
      onOpen={onOpen}
      onUrlError={jest.fn()}
      pieces={pieces}
      urls={urls}
      {...props}
    />,
  );
  return { ...utils, onOpen, onFrontChange };
}

function swipe(translationX: number, velocityX = 0) {
  fireGestureHandler(getByGestureTestId('artwork-deck-pan'), [
    { state: State.BEGAN, translationX: 0, velocityX: 0 },
    { state: State.ACTIVE, translationX, velocityX },
    { state: State.END, translationX, velocityX },
  ]);
}

describe('ArtworkDeck', () => {
  beforeEach(() => {
    // The default Reanimated mock ignores animation callbacks; run them
    // immediately so a committed swipe finishes its exit.
    mockedWithTiming.mockImplementation((toValue: unknown, _config: unknown, callback?: (finished: boolean) => void) => {
      callback?.(true);
      return toValue;
    });
  });

  afterEach(() => {
    mockedWithTiming.mockReset();
    mockedWithTiming.mockImplementation((toValue: unknown) => toValue);
    jest.restoreAllMocks();
    // spyOn on the RN jest mock keeps the last implementation; put it back.
    (AccessibilityInfo.isReduceMotionEnabled as jest.Mock).mockResolvedValue(false);
  });

  it('draws the stack with the paper tag and the front frame test id on piece 1', () => {
    const { getByTestId, queryByTestId, getByText } = renderDeck(3);

    expect(getByText('1 of 3')).toBeTruthy();
    expect(getByTestId('memory-card-memory-1-artwork-frame')).toBeTruthy();
    expect(getByTestId('memory-card-memory-1-artwork-deck-card-0')).toBeTruthy();
    expect(getByTestId('memory-card-memory-1-artwork-deck-card-1')).toBeTruthy();
    expect(getByTestId('memory-card-memory-1-artwork-deck-card-2')).toBeTruthy();
    // Only one frame carries the plain test id.
    expect(queryByTestId('memory-card-memory-1-artwork-frame-opening')).toBeTruthy();
  });

  it('draws at most three frames but counts through all N', () => {
    const { queryByTestId, getByText } = renderDeck(5);

    expect(getByText('1 of 5')).toBeTruthy();
    expect(queryByTestId('memory-card-memory-1-artwork-deck-card-2')).toBeTruthy();
    expect(queryByTestId('memory-card-memory-1-artwork-deck-card-3')).toBeNull();
  });

  it('opens the detail on the front piece', () => {
    const { getByTestId, onOpen } = renderDeck(3);

    fireEvent.press(getByTestId('memory-card-memory-1-artwork-deck'));

    expect(onOpen).toHaveBeenCalledWith(0);
  });

  it('flings the front piece off, tucks it in at the back and brings the next one forward', () => {
    const { getByTestId, getByText, queryByText, onOpen, onFrontChange } = renderDeck(3);
    expect(onFrontChange).toHaveBeenLastCalledWith(0);

    act(() => swipe(-150));

    expect(getByText('2 of 3')).toBeTruthy();
    expect(queryByText('1 of 3')).toBeNull();
    expect(onFrontChange).toHaveBeenLastCalledWith(1);
    // The frame test id moved to the new front piece.
    expect(getByTestId('memory-card-memory-1-artwork-deck-card-1')).toBeTruthy();
    fireEvent.press(getByTestId('memory-card-memory-1-artwork-deck'));
    expect(onOpen).toHaveBeenCalledWith(1);
  });

  it('cycles all the way around', () => {
    const { getByText } = renderDeck(3);

    act(() => swipe(150));
    act(() => swipe(-150));
    act(() => swipe(150));

    expect(getByText('1 of 3')).toBeTruthy();
  });

  it('brings a hidden piece into the stack as the pile cycles', () => {
    const { getByTestId, queryByTestId } = renderDeck(4);
    expect(queryByTestId('memory-card-memory-1-artwork-deck-card-3')).toBeNull();

    act(() => swipe(-150));

    expect(getByTestId('memory-card-memory-1-artwork-deck-card-3')).toBeTruthy();
    // The piece that just left is now 4th and drops out of the drawn three.
    expect(queryByTestId('memory-card-memory-1-artwork-deck-card-0')).toBeNull();
  });

  it('springs back from a short, slow drag', () => {
    const { getByText } = renderDeck(3);

    act(() => swipe(-40));

    expect(getByText('1 of 3')).toBeTruthy();
  });

  it('commits a short but fast fling', () => {
    const { getByText } = renderDeck(3);

    act(() => swipe(-40, -1500));

    expect(getByText('2 of 3')).toBeTruthy();
  });

  it('offers the next piece as an accessibility action', () => {
    const { getByTestId, getByText } = renderDeck(3);
    const deck = getByTestId('memory-card-memory-1-artwork-deck');

    expect(deck.props.accessibilityActions).toEqual([{ name: 'increment', label: 'Next piece' }]);
    expect(deck.props.accessibilityHint).toEqual(expect.stringContaining('Swipe'));

    act(() => {
      fireEvent(deck, 'accessibilityAction', { nativeEvent: { actionName: 'increment' } });
    });

    expect(getByText('2 of 3')).toBeTruthy();
    expect(getByTestId('memory-card-memory-1-artwork-deck').props.accessibilityLabel).toBe(
      'Artwork, piece 2 of 3',
    );
  });

  it('still cycles on a swipe with reduce motion on, without animating the exit', async () => {
    jest.spyOn(AccessibilityInfo, 'isReduceMotionEnabled').mockResolvedValue(true);
    const { getByText } = renderDeck(3);
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    mockedWithTiming.mockClear();

    act(() => swipe(-150));

    expect(getByText('2 of 3')).toBeTruthy();
    expect(mockedWithTiming).not.toHaveBeenCalledWith(expect.any(Number), expect.objectContaining({ duration: 260 }), expect.anything());
  });

  it('has no gesture-driven cycling for a single piece', () => {
    const { queryByText } = renderDeck(1);

    expect(queryByText('1 of 1')).toBeTruthy();
    expect(() => act(() => swipe(-150))).not.toThrow();
    expect(queryByText('1 of 1')).toBeTruthy();
  });
});
