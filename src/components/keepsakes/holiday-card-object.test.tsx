import { render } from '@testing-library/react-native';

import {
  HolidayCardObject,
  holidayCardFamilyLine,
  holidayCardObjectSize,
} from '@/components/keepsakes/holiday-card-object';

jest.mock('expo-linear-gradient', () => ({ LinearGradient: () => null }));
let mockUrl: string | undefined;
jest.mock('@/hooks/useMediaUrls', () => ({
  useMediaUrl: jest.fn(() => ({ url: mockUrl, isLoading: false, isError: false })),
}));

describe('holidayCardFamilyLine', () => {
  it('formats one, two and three names', () => {
    expect(holidayCardFamilyLine(['Tomás'], 2026)).toBe('Tomás · 2026');
    expect(holidayCardFamilyLine(['Tomás', 'Lucía'], 2026)).toBe('Tomás & Lucía · 2026');
    expect(holidayCardFamilyLine(['A', 'B', 'C'], 2026)).toBe('A, B & C · 2026');
  });

  it('falls back to the year alone', () => {
    expect(holidayCardFamilyLine([], 2026)).toBe('2026');
    expect(holidayCardFamilyLine(['  ', ''], 2026)).toBe('2026');
  });

  it('trims names and drops blank ones', () => {
    expect(holidayCardFamilyLine([' Ana ', '', 'Leo'], 2025)).toBe('Ana & Leo · 2025');
  });
});

describe('holidayCardObjectSize', () => {
  it('is ~1.27x wide and ~1.54x tall', () => {
    expect(holidayCardObjectSize(100)).toEqual({ width: 127, height: 154 });
  });
});

describe('HolidayCardObject', () => {
  beforeEach(() => {
    mockUrl = undefined;
  });

  it('renders the default greeting and the uppercase family line', () => {
    const { getByText, getByTestId } = render(
      <HolidayCardObject familyLine="Tomás · 2026" imageKey={null} testID="card" width={154} />,
    );
    expect(getByText('Happy holidays')).toBeTruthy();
    expect(getByText('TOMÁS · 2026')).toBeTruthy();
    expect(getByTestId('card').props.style).toEqual({ width: 196, height: 237 });
  });

  it('uses a custom greeting and shows the picture once its URL is signed', () => {
    mockUrl = 'https://example.test/pic.jpg';
    const { getByText, queryByTestId } = render(
      <HolidayCardObject familyLine="2026" greeting="Merry Christmas" imageKey="family/pic.jpg" testID="card" width={154} />,
    );
    expect(getByText('Merry Christmas')).toBeTruthy();
    expect(queryByTestId('card-image')).toBeTruthy();
  });

  it('renders the wash (no image) without a key', () => {
    mockUrl = 'https://example.test/pic.jpg';
    const { queryByTestId } = render(<HolidayCardObject familyLine="2026" imageKey={null} testID="card" width={154} />);
    expect(queryByTestId('card-image')).toBeNull();
  });
});
