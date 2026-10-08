import { render } from '@testing-library/react-native';

import {
  HolidayCardObject,
  holidayCardFrontObjectSize,
  holidayCardObjectSize,
} from '@/components/keepsakes/holiday-card-object';
import type { KeepsakesCardFront } from '@/services/keepsakes';

jest.mock('expo-linear-gradient', () => ({ LinearGradient: () => null }));
jest.mock('@/lib/supabase', () => ({ supabase: { rpc: jest.fn() } }));
let mockUrl: string | undefined;
jest.mock('@/hooks/useMediaUrls', () => ({
  useMediaUrl: jest.fn(() => ({ url: mockUrl, isLoading: false, isError: false })),
}));

describe('holidayCardObjectSize', () => {
  it('is ~1.27x wide and ~1.54x tall', () => {
    expect(holidayCardObjectSize(100)).toEqual({ width: 127, height: 154 });
  });
});

describe('holidayCardFrontObjectSize', () => {
  it('a portrait card is the 5:7 object; a landscape card is shorter and peeks by its shorter side', () => {
    expect(holidayCardFrontObjectSize({ orientation: 'portrait' }, 100)).toEqual({ width: 127, height: 154 });
    expect(holidayCardFrontObjectSize({ orientation: 'landscape' }, 150)).toEqual({ width: 179, height: 122 });
  });
});

const realFront: KeepsakesCardFront = {
  card_id: 'card-1',
  year: 2026,
  image_key: 'family/front.jpg',
  width: 4000,
  height: 3000,
  layout: 'full-bleed',
  orientation: 'landscape',
  focal: null,
  greeting: 'christmas',
  language: 'en',
  greeting_text: null,
  subline_text: null,
  greeting_position: 'bottom-left',
};

describe('HolidayCardObject', () => {
  beforeEach(() => {
    mockUrl = undefined;
  });

  it('generic preview: the default greeting and just the year', () => {
    const { getByText, getByTestId } = render(
      <HolidayCardObject imageKey={null} subline="2026" testID="card" width={154} />,
    );
    expect(getByText('Happy Holidays')).toBeTruthy();
    expect(getByText('2026')).toBeTruthy();
    expect(getByTestId('card').props.style).toEqual({ width: 196, height: 238 });
  });

  it('generic preview: a custom greeting, the picture once its URL is signed, no small line when omitted', () => {
    mockUrl = 'https://example.test/pic.jpg';
    const { getByText, queryByTestId, queryByText } = render(
      <HolidayCardObject greeting="Felices fiestas" imageKey="family/pic.jpg" testID="card" width={154} />,
    );
    expect(getByText('Felices fiestas')).toBeTruthy();
    expect(queryByText('2026')).toBeNull();
    expect(queryByTestId('card-image')).toBeTruthy();
  });

  it('generic preview: the wash (no image) without a key', () => {
    mockUrl = 'https://example.test/pic.jpg';
    const { queryByTestId } = render(<HolidayCardObject imageKey={null} subline="2026" testID="card" width={154} />);
    expect(queryByTestId('card-image')).toBeNull();
  });

  it('the real card replaces the generic one (landscape box, envelope behind it)', () => {
    mockUrl = 'https://example.test/front.jpg';
    const { getByTestId, getByText, queryByText } = render(
      <HolidayCardObject
        front={{ ...realFront, greeting_text: 'Merry Everything' }}
        greeting="Happy Holidays"
        imageKey="family/other.jpg"
        subline="1999"
        testID="card"
        width={150}
      />,
    );
    expect(getByTestId('card').props.style).toEqual({ width: 179, height: 122 });
    expect(getByTestId('card-envelope')).toBeTruthy();
    expect(getByTestId('card-front')).toBeTruthy();
    expect(getByTestId('card-front-image')).toBeTruthy();
    expect(getByText('Merry Everything')).toBeTruthy();
    expect(getByText('2026')).toBeTruthy();
    expect(queryByText('1999')).toBeNull();
    expect(queryByText('Happy Holidays')).toBeNull();
  });
});
