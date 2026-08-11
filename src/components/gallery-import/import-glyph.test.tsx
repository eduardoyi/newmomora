import { fireEvent, render } from '@testing-library/react-native';

import { ImportGlyph } from '@/components/gallery-import/import-glyph';
import { colors } from '@/constants/theme';

describe('ImportGlyph', () => {
  it('fires onPress when tapped', () => {
    const onPress = jest.fn();
    const { getByTestId } = render(<ImportGlyph onPress={onPress} state="none" />);

    fireEvent.press(getByTestId('timeline-gallery-import-glyph'));

    expect(onPress).toHaveBeenCalledTimes(1);
  });

  it('renders no status dot in the none state', () => {
    const { queryByTestId } = render(<ImportGlyph onPress={jest.fn()} state="none" />);
    expect(queryByTestId('import-glyph-dot')).toBeNull();
  });

  it.each([
    ['processing', colors.sea],
    ['ready', colors.primary],
    ['resume', colors.primary],
    ['attention', colors.sun],
    ['expiring', colors.sun],
  ] as const)('shows a %s-colored dot for the %s state', (state, expectedColor) => {
    const { getByTestId } = render(<ImportGlyph onPress={jest.fn()} state={state} />);
    const dot = getByTestId('import-glyph-dot');
    const flatStyle = Array.isArray(dot.props.style)
      ? Object.assign({}, ...dot.props.style)
      : dot.props.style;
    expect(flatStyle.backgroundColor).toBe(expectedColor);
  });

  it('copies the design accessibility labels verbatim', () => {
    expect(render(<ImportGlyph onPress={jest.fn()} state="processing" />).getByTestId('timeline-gallery-import-glyph').props.accessibilityLabel)
      .toBe('Photo suggestions, still working');
    expect(render(<ImportGlyph onPress={jest.fn()} state="resume" />).getByTestId('timeline-gallery-import-glyph').props.accessibilityLabel)
      .toBe('Photo suggestions, pick up where you left off');
    expect(render(<ImportGlyph onPress={jest.fn()} state="attention" />).getByTestId('timeline-gallery-import-glyph').props.accessibilityLabel)
      .toBe('Photo suggestions need your attention');
    expect(render(<ImportGlyph onPress={jest.fn()} state="expiring" />).getByTestId('timeline-gallery-import-glyph').props.accessibilityLabel)
      .toBe('Photo suggestions ending soon');
    expect(render(<ImportGlyph onPress={jest.fn()} state="none" />).getByTestId('timeline-gallery-import-glyph').props.accessibilityLabel)
      .toBe('Find memories in your photos');
  });

  it('includes the ready count in the ready-state label when known', () => {
    const { getByTestId } = render(<ImportGlyph onPress={jest.fn()} readyCount={5} state="ready" />);
    expect(getByTestId('timeline-gallery-import-glyph').props.accessibilityLabel).toBe('Photo suggestions ready, 5 waiting');
  });
});
