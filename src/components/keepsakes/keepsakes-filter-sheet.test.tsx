import { fireEvent, render } from '@testing-library/react-native';
import type { ComponentProps } from 'react';

import { KeepsakesFilterSheet, keepsakesSheetFilterCount } from '@/components/keepsakes/keepsakes-filter-sheet';
import { DEFAULT_KEEPSAKES_FILTER, type ShelfItem } from '@/utils/keepsakes';

jest.mock('react-native-safe-area-context', () => {
  const actual = jest.requireActual('react-native-safe-area-context');
  return { ...actual, useSafeAreaInsets: () => ({ top: 0, right: 0, bottom: 0, left: 0 }) };
});

function film(id: string, year: number): ShelfItem {
  return { kind: 'film', id: `film:${id}`, year, date: `${year}-06-01`, memberId: null, badge: null } as unknown as ShelfItem;
}
function book(id: string, year: number): ShelfItem {
  return { kind: 'book', id: `book:${id}`, year, date: `${year}-06-01`, memberId: 'c1', badge: null } as unknown as ShelfItem;
}
function recap(year: number): ShelfItem {
  return { kind: 'upcoming-recap', id: 'upcoming-recap', year, date: `${year}-11-01`, memberId: null, badge: null } as unknown as ShelfItem;
}

const items = [recap(2026), film('a', 2026), film('b', 2025), book('x', 2025), book('y', 2024)];

describe('keepsakesSheetFilterCount', () => {
  it('counts type and year only (not the child chip)', () => {
    expect(keepsakesSheetFilterCount(DEFAULT_KEEPSAKES_FILTER)).toBe(0);
    expect(keepsakesSheetFilterCount({ memberId: 'c1', type: 'all', year: null })).toBe(0);
    expect(keepsakesSheetFilterCount({ memberId: null, type: 'books', year: 2025 })).toBe(2);
  });
});

describe('KeepsakesFilterSheet', () => {
  function renderSheet(overrides: Partial<ComponentProps<typeof KeepsakesFilterSheet>> = {}) {
    const onApply = jest.fn();
    const onClose = jest.fn();
    const utils = render(
      <KeepsakesFilterSheet
        canChooseType
        filter={DEFAULT_KEEPSAKES_FILTER}
        items={items}
        onApply={onApply}
        onClose={onClose}
        visible
        {...overrides}
      />,
    );
    return { ...utils, onApply, onClose };
  }

  it('shows the years that have items and a live count (the upcoming recap is not counted)', () => {
    const { getByTestId, queryByTestId } = renderSheet();
    expect(getByTestId('keepsakes-filter-year-2026')).toBeTruthy();
    expect(getByTestId('keepsakes-filter-year-2025')).toBeTruthy();
    expect(getByTestId('keepsakes-filter-year-2024')).toBeTruthy();
    expect(queryByTestId('keepsakes-filter-year-2023')).toBeNull();
    expect(getByTestId('keepsakes-filter-apply')).toHaveTextContent('Show 4 keepsakes');

    fireEvent.press(getByTestId('keepsakes-filter-type-books'));
    expect(getByTestId('keepsakes-filter-apply')).toHaveTextContent('Show 2 keepsakes');
    fireEvent.press(getByTestId('keepsakes-filter-year-2025'));
    expect(getByTestId('keepsakes-filter-apply')).toHaveTextContent('Show 1 keepsake');
  });

  it('applies the draft, keeping the child chip', () => {
    const { getByTestId, onApply } = renderSheet({ filter: { memberId: 'c1', type: 'all', year: null } });
    fireEvent.press(getByTestId('keepsakes-filter-type-books'));
    fireEvent.press(getByTestId('keepsakes-filter-year-2024'));
    fireEvent.press(getByTestId('keepsakes-filter-apply'));
    expect(onApply).toHaveBeenCalledWith({ memberId: 'c1', type: 'books', year: 2024 });
  });

  it('Reset clears type and year in the draft', () => {
    const { getByTestId } = renderSheet({ filter: { memberId: null, type: 'films', year: 2026 } });
    fireEvent.press(getByTestId('keepsakes-filter-reset'));
    expect(getByTestId('keepsakes-filter-apply')).toHaveTextContent('Show 4 keepsakes');
  });

  it('viewers get the Year section only, counted in films', () => {
    const { queryByTestId, getByTestId } = renderSheet({ canChooseType: false, items: [recap(2026), film('a', 2026), film('b', 2025)] });
    expect(queryByTestId('keepsakes-filter-type-books')).toBeNull();
    expect(getByTestId('keepsakes-filter-year-2025')).toBeTruthy();
    expect(getByTestId('keepsakes-filter-apply')).toHaveTextContent('Show 2 films');
  });

  it('the backdrop closes without applying', () => {
    const { getByTestId, onApply, onClose } = renderSheet();
    fireEvent.press(getByTestId('keepsakes-filter-sheet-backdrop', { includeHiddenElements: true }));
    expect(onClose).toHaveBeenCalled();
    expect(onApply).not.toHaveBeenCalled();
  });
});
