import { render } from '@testing-library/react-native';

import { Wordmark } from '@/components/wordmark';
import { colors, fonts } from '@/constants/theme';

describe('Wordmark', () => {
  it('renders "Momora" in the display-medium face with a primary-colored period', () => {
    const { getByTestId } = render(<Wordmark size={26} testID="wordmark" />);

    const root = getByTestId('wordmark');
    expect(root.props.children).toEqual(['Momora', expect.anything()]);

    const flatStyle = Object.assign({}, ...[root.props.style].flat());
    expect(flatStyle.fontFamily).toBe(fonts.displayMedium);
    expect(flatStyle.fontSize).toBe(26);
    expect(flatStyle.color).toBe(colors.ink);
    // Tight, negative tracking per the handoff (`letterSpacing: -0.025em`).
    expect(flatStyle.letterSpacing).toBeCloseTo(26 * -0.025);

    const dot = root.props.children[1];
    const dotStyle = Object.assign({}, ...[dot.props.style].flat());
    expect(dot.props.children).toBe('.');
    expect(dotStyle.color).toBe(colors.primary);
  });

  it('defaults to size 28 and colors.ink, and accepts a color override', () => {
    const { getByTestId } = render(<Wordmark color={colors.white} testID="wordmark" />);

    const root = getByTestId('wordmark');
    const flatStyle = Object.assign({}, ...[root.props.style].flat());
    expect(flatStyle.fontSize).toBe(28);
    expect(flatStyle.color).toBe(colors.white);
  });
});
