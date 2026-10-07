import { fireEvent, render } from '@testing-library/react-native';

import { MakeSomethingRow } from '@/components/keepsakes/make-something-row';
import type { KeepsakesOverview } from '@/services/keepsakes';

jest.mock('expo-symbols', () => ({ SymbolView: () => null }));
jest.mock('expo-linear-gradient', () => ({ LinearGradient: () => null }));
jest.mock('@/hooks/useMediaUrls', () => ({
  useMediaUrl: jest.fn(() => ({ url: undefined, isLoading: false, isError: false })),
}));

function overview(overrides: Partial<KeepsakesOverview> = {}): KeepsakesOverview {
  return {
    recap: null,
    has_viewers: null,
    year_moments: 40,
    holiday_pool: 30,
    holiday_min_pool: 20,
    holiday_ship_by_note: 'Order by Dec 10 for Christmas delivery in the US.',
    preview_key: null,
    book_preview_keys: {},
    orders: [],
    ...overrides,
  };
}

const baseProps = {
  canEdit: true,
  childNames: ['Lila'],
  firstChild: { id: 'child-1', name: 'Lila' },
  holidayCardEnabled: true,
  onOpenProduct: jest.fn(),
  overview: overview(),
  year: 2026,
};

describe('MakeSomethingRow', () => {
  beforeEach(() => jest.clearAllMocks());

  it('in season: the holiday card leads, then the Memory Book', () => {
    const { getAllByTestId } = render(<MakeSomethingRow {...baseProps} />);
    expect(getAllByTestId(/^keepsakes-store-(holiday-card|memory-book)$/).map((node) => node.props.testID)).toEqual([
      'keepsakes-store-holiday-card',
      'keepsakes-store-memory-book',
    ]);
  });

  it('out of season: no holiday card, only the Memory Book', () => {
    const { queryByTestId, getByTestId } = render(<MakeSomethingRow {...baseProps} holidayCardEnabled={false} />);
    expect(queryByTestId('keepsakes-store-holiday-card')).toBeNull();
    expect(getByTestId('keepsakes-store-memory-book')).toBeTruthy();
  });

  it('shows the ship-by note verbatim, and hides the pill when there is none', () => {
    const withNote = render(<MakeSomethingRow {...baseProps} />);
    expect(withNote.getByText('Order by Dec 10 for Christmas delivery in the US.')).toBeTruthy();
    withNote.unmount();

    const without = render(<MakeSomethingRow {...baseProps} overview={overview({ holiday_ship_by_note: null })} />);
    expect(without.queryByTestId('keepsakes-store-holiday-card-note')).toBeNull();
  });

  it('renders for owners and managers only, and never shows a price', () => {
    const viewer = render(<MakeSomethingRow {...baseProps} canEdit={false} />);
    expect(viewer.queryByTestId('keepsakes-store')).toBeNull();
    viewer.unmount();

    const owner = render(<MakeSomethingRow {...baseProps} />);
    expect(JSON.stringify(owner.toJSON())).not.toMatch(/\$\d/);
    expect(owner.getByText('A year of one child, printed and bound.')).toBeTruthy();
    expect(owner.getByText('Your card could look like this, with a letter from your year.')).toBeTruthy();
  });

  it('opens the tapped product', () => {
    const onOpenProduct = jest.fn();
    const { getByTestId } = render(<MakeSomethingRow {...baseProps} onOpenProduct={onOpenProduct} />);
    fireEvent.press(getByTestId('keepsakes-store-memory-book'));
    expect(onOpenProduct).toHaveBeenCalledWith('memory-book');
    fireEvent.press(getByTestId('keepsakes-store-holiday-card'));
    expect(onOpenProduct).toHaveBeenCalledWith('holiday-card');
  });
});
