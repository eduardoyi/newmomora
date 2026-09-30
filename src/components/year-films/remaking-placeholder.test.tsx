import { render } from '@testing-library/react-native';
import * as Reanimated from 'react-native-reanimated';

import { RemakingPlaceholder } from '@/components/year-films/remaking-placeholder';

describe('RemakingPlaceholder', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('card: paper frame at 9:16 with a spinner, the title and the reassurance line', () => {
    const { getByTestId, getByText } = render(<RemakingPlaceholder testID="ph" variant="card" width={90} />);
    expect(getByTestId('ph').props.style).toEqual(
      expect.arrayContaining([expect.objectContaining({ width: 90, height: 160, borderRadius: 12 })]),
    );
    expect(getByTestId('ph-spinner')).toBeTruthy();
    expect(getByText('Remaking your film…')).toBeTruthy();
    expect(getByText('This takes a few minutes')).toBeTruthy();
  });

  it('tile: one short line only, honouring height and radius', () => {
    const { getByTestId, getByText, queryByText } = render(
      <RemakingPlaceholder height={100} radius={20} testID="ph" variant="tile" width={90} />,
    );
    expect(getByTestId('ph').props.style).toEqual(
      expect.arrayContaining([expect.objectContaining({ width: 90, height: 100, borderRadius: 20 })]),
    );
    expect(getByText('Remaking…')).toBeTruthy();
    expect(queryByText('This takes a few minutes')).toBeNull();
  });

  it('Reduce Motion: static frame, no spinner, no repeating animation', () => {
    jest.spyOn(Reanimated, 'useReducedMotion').mockReturnValue(true);
    const withRepeat = jest.spyOn(Reanimated, 'withRepeat');
    const { queryByTestId, getByText } = render(<RemakingPlaceholder testID="ph" variant="card" width={90} />);
    expect(queryByTestId('ph-spinner')).toBeNull();
    expect(withRepeat).not.toHaveBeenCalled();
    expect(getByText('Remaking your film…')).toBeTruthy();
  });
});
