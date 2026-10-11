import { fireEvent, render } from '@testing-library/react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { computeReactionTrayPosition, ReactionTray } from './reaction-tray';

const insets = { top: 47, bottom: 34, left: 0, right: 0 };
const window = { width: 390, height: 844 };

describe('computeReactionTrayPosition', () => {
  it('sits above the anchor when there is room', () => {
    const { top, left } = computeReactionTrayPosition({ x: 20, y: 500, width: 30, height: 36 }, window, insets);
    expect(top).toBeLessThan(500);
    expect(left).toBe(20);
  });

  it('flips below the anchor near the top of the screen', () => {
    const { top } = computeReactionTrayPosition({ x: 20, y: 60, width: 30, height: 36 }, window, insets);
    expect(top).toBeGreaterThan(60);
  });

  it('clamps horizontally inside the safe area', () => {
    const { left } = computeReactionTrayPosition({ x: 380, y: 500, width: 30, height: 36 }, window, insets);
    expect(left).toBeLessThan(380);
    expect(left).toBeGreaterThanOrEqual(8);
  });

  it('clamps vertically above the bottom inset', () => {
    const { top } = computeReactionTrayPosition({ x: 20, y: 5, width: 30, height: 900 }, window, insets);
    expect(top).toBeLessThanOrEqual(844 - 34 - 8 - 56);
  });
});

describe('ReactionTray', () => {
  const anchor = { x: 20, y: 500, width: 30, height: 36 };

  function renderTray(props: Partial<React.ComponentProps<typeof ReactionTray>> = {}) {
    const handlers = { onSelect: jest.fn(), onOpenPicker: jest.fn(), onClose: jest.fn() };
    const view = render(
      <SafeAreaProvider
        initialMetrics={{ frame: { height: 844, width: 390, x: 0, y: 0 }, insets }}
      >
        <ReactionTray anchor={anchor} currentEmoji={null} visible {...handlers} {...props} />
      </SafeAreaProvider>,
    );
    return { ...view, ...handlers };
  }

  it('renders nothing when hidden', () => {
    const { queryByTestId } = renderTray({ visible: false });
    expect(queryByTestId('reaction-tray')).toBeNull();
  });

  it('renders the six quick reactions and reports picks', () => {
    const { getByTestId, onSelect } = renderTray();
    for (const emoji of ['❤️', '😂', '😮', '😢', '🙏', '👍']) {
      expect(getByTestId(`reaction-tray-${emoji}`)).toBeTruthy();
    }
    fireEvent.press(getByTestId('reaction-tray-🙏'));
    expect(onSelect).toHaveBeenCalledWith('🙏');
  });

  it('highlights the current reaction and labels it as removable', () => {
    const { getByTestId } = renderTray({ currentEmoji: '😂' });
    expect(getByTestId('reaction-tray-😂').props.accessibilityLabel).toBe('Remove reaction 😂');
    expect(getByTestId('reaction-tray-😂').props.accessibilityState.selected).toBe(true);
    expect(getByTestId('reaction-tray-😮').props.accessibilityState.selected).toBe(false);
  });

  it('opens the full picker and closes on backdrop tap', () => {
    const { getByTestId, onOpenPicker, onClose } = renderTray();
    fireEvent.press(getByTestId('reaction-tray-more'));
    expect(onOpenPicker).toHaveBeenCalledTimes(1);
    fireEvent.press(getByTestId('reaction-tray-backdrop', { includeHiddenElements: true }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
