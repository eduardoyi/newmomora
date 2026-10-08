import { fireEvent, render } from '@testing-library/react-native';

import { MakeSomethingRow } from '@/components/keepsakes/make-something-row';
import type { KeepsakesCardFront, KeepsakesOverview } from '@/services/keepsakes';

jest.mock('@/lib/supabase', () => ({ supabase: { rpc: jest.fn() } }));
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
    card_front: null,
    ...overrides,
  };
}

const baseProps = {
  canEdit: true,
  cardFront: null as KeepsakesCardFront | null,
  firstChild: { id: 'child-1', name: 'Lila' },
  holidayCardEnabled: true,
  language: 'en' as const,
  onOpenProduct: jest.fn(),
  overview: overview(),
  year: 2026,
};

const realFront: KeepsakesCardFront = {
  card_id: 'card-1',
  year: 2026,
  image_key: 'family/front.jpg',
  width: 4000,
  height: 3000,
  layout: 'full-bleed',
  orientation: 'landscape',
  focal: { x: 0.5, y: 0.4 },
  greeting: 'christmas',
  language: 'en',
  greeting_text: 'Merry Christmas from us',
  subline_text: '',
  greeting_position: 'bottom-center',
};

describe('MakeSomethingRow', () => {
  beforeEach(() => jest.clearAllMocks());

  it('before a card exists: the generic preview with the language default greeting and just the year', () => {
    const { getByText, getByTestId, queryByTestId } = render(<MakeSomethingRow {...baseProps} />);
    expect(getByText('Happy Holidays')).toBeTruthy();
    expect(getByText('2026')).toBeTruthy();
    expect(queryByTestId('keepsakes-store-holiday-card-object-front')).toBeNull();
    expect(getByTestId('keepsakes-store-holiday-card-object')).toBeTruthy();
  });

  it('the generic preview greets in the family language', () => {
    const { getByText } = render(<MakeSomethingRow {...baseProps} language="es" />);
    expect(getByText('Felices fiestas')).toBeTruthy();
  });

  it('once a card exists: the real card front, sized to fit the tile (landscape, then portrait)', () => {
    const landscape = render(<MakeSomethingRow {...baseProps} cardFront={realFront} />);
    expect(landscape.getByTestId('keepsakes-store-holiday-card-object-front')).toBeTruthy();
    expect(landscape.getByText('Merry Christmas from us')).toBeTruthy();
    expect(landscape.queryByText('2026')).toBeNull(); // the family hid the small line
    expect(landscape.queryByText('Happy Holidays')).toBeNull();
    // Width-bound inside the 236-wide tile: a 174 x 124 card, object 207 x 141.
    expect(landscape.getByTestId('keepsakes-store-holiday-card-object').props.style).toEqual({ width: 207, height: 141 });
    landscape.unmount();

    const portrait = render(
      <MakeSomethingRow {...baseProps} cardFront={{ ...realFront, orientation: 'portrait', layout: 'bordered', subline_text: null }} />,
    );
    // Height-bound inside the 178-high tile: a 108 x 151 card, object 137 x 166.
    expect(portrait.getByTestId('keepsakes-store-holiday-card-object').props.style).toEqual({ width: 137, height: 166 });
    expect(portrait.getByText('2026')).toBeTruthy();
  });

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
