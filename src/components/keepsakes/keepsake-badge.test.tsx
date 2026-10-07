import { render } from '@testing-library/react-native';

import { KeepsakeBadge } from '@/components/keepsakes/keepsake-badge';
import { colors } from '@/constants/theme';

describe('KeepsakeBadge', () => {
  it('needsYou is raspberry', () => {
    const { getByTestId, getByText } = render(<KeepsakeBadge label="Ready to order" testID="b" tone="needsYou" />);
    expect(getByText('Ready to order')).toBeTruthy();
    expect(getByTestId('b').props.style).toEqual(
      expect.arrayContaining([expect.objectContaining({ backgroundColor: colors.primaryTint })]),
    );
  });

  it('progress is lavender', () => {
    const { getByTestId } = render(<KeepsakeBadge label="Being made" testID="b" tone="progress" />);
    expect(getByTestId('b').props.style).toEqual(
      expect.arrayContaining([expect.objectContaining({ backgroundColor: colors.surface2 })]),
    );
  });
});
