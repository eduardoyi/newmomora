import { render } from '@testing-library/react-native';
import { StyleSheet } from 'react-native';

import { HolidayCardFront, holidayCardFrontSize } from '@/components/keepsakes/holiday-card-front';
import type { KeepsakesCardFront } from '@/services/keepsakes';

jest.mock('@/lib/supabase', () => ({ supabase: { rpc: jest.fn() } }));
jest.mock('expo-linear-gradient', () => {
  const { createElement } = jest.requireActual<typeof import('react')>('react');
  const { View } = jest.requireActual<typeof import('react-native')>('react-native');
  return {
    LinearGradient: ({ testID, style }: { testID?: string; style?: unknown }) => createElement(View, { testID, style }),
  };
});
let mockUrl: string | undefined;
jest.mock('@/hooks/useMediaUrls', () => ({
  useMediaUrl: jest.fn(() => ({ url: mockUrl, isLoading: false, isError: false })),
}));

function front(overrides: Partial<KeepsakesCardFront> = {}): KeepsakesCardFront {
  return {
    card_id: 'card-1',
    year: 2026,
    image_key: 'family/front.jpg',
    width: 4000,
    height: 3000,
    layout: 'full-bleed',
    orientation: 'landscape',
    focal: { x: 0.25, y: 0.75 },
    greeting: 'holidays',
    language: 'en',
    greeting_text: null,
    subline_text: null,
    greeting_position: 'top-center',
    ...overrides,
  };
}

describe('holidayCardFrontSize', () => {
  it('is exported from the component with the trim aspect', () => {
    expect(holidayCardFrontSize({ orientation: 'landscape' }, 150)).toEqual({ width: 150, height: 107 });
  });
});

describe('HolidayCardFront', () => {
  beforeEach(() => {
    mockUrl = 'https://example.test/front.jpg';
  });

  it('full-bleed landscape: the picture with its focal crop, the scrim, the default greeting and the year', () => {
    const { getByTestId, getByText } = render(<HolidayCardFront front={front()} testID="front" width={150} />);
    expect(StyleSheet.flatten(getByTestId('front').props.style)).toMatchObject({ width: 150, height: 107 });
    expect(getByText('Happy Holidays')).toBeTruthy();
    expect(getByText('2026')).toBeTruthy();
    expect(getByTestId('front-image').props.contentPosition).toEqual({ left: '25%', top: '75%' });
    // 42% of the page (135 mm) minus the bleed = 52.7 mm at 150 / 177.8 px per mm.
    const scrim = StyleSheet.flatten(getByTestId('front-scrim').props.style);
    expect(scrim.height).toBeCloseTo(52.7 * (150 / 177.8), 3);
    expect(scrim.top).toBe(0);
  });

  it('bottom positions hang the scrim and the text from the bottom', () => {
    const { getByTestId } = render(
      <HolidayCardFront front={front({ greeting_position: 'bottom-right' })} testID="front" width={150} />,
    );
    expect(StyleSheet.flatten(getByTestId('front-scrim').props.style).bottom).toBe(0);
  });

  it('shows the edited texts and the Spanish default; an empty small line is hidden', () => {
    const edited = render(
      <HolidayCardFront
        front={front({ greeting_text: 'Con mucho cariño', subline_text: 'Los Pérez' })}
        testID="front"
        width={150}
      />,
    );
    expect(edited.getByText('Con mucho cariño')).toBeTruthy();
    expect(edited.getByText('Los Pérez')).toBeTruthy();
    edited.unmount();

    const spanish = render(
      <HolidayCardFront front={front({ language: 'es', greeting: 'christmas', subline_text: '' })} testID="front" width={150} />,
    );
    expect(spanish.getByText('Feliz Navidad')).toBeTruthy();
    expect(spanish.queryByTestId('front-subline')).toBeNull();
  });

  it('bordered portrait: paper card, picture box, one line of greeting and small line, no scrim', () => {
    const { getByTestId, getByText, queryByTestId } = render(
      <HolidayCardFront
        front={front({ layout: 'bordered', orientation: 'portrait', width: 3000, height: 4000, greeting: 'new-year' })}
        testID="front"
        width={104}
      />,
    );
    expect(StyleSheet.flatten(getByTestId('front').props.style)).toMatchObject({ width: 104, height: 146 });
    expect(getByText('Happy New Year')).toBeTruthy();
    expect(getByText('2026')).toBeTruthy();
    expect(queryByTestId('front-scrim')).toBeNull();
    // 111 x 148.8 mm picture box at 8, 8 mm in a 127 mm wide trim, drawn at 104 px.
    const image = StyleSheet.flatten(getByTestId('front-image').props.style);
    expect(image.left).toBeCloseTo(8 * (104 / 127), 3);
    expect(image.width).toBeCloseTo(111 * (104 / 127), 3);
    expect(image.height).toBeCloseTo(148.8 * (104 / 127), 3);
  });

  it('renders the warm wash when the picture has no key or is not signed yet', () => {
    const noKey = render(<HolidayCardFront front={front({ image_key: null })} testID="front" width={150} />);
    expect(noKey.queryByTestId('front-image')).toBeNull();
    expect(noKey.getByTestId('front-wash')).toBeTruthy();
    noKey.unmount();

    mockUrl = undefined;
    const unsigned = render(<HolidayCardFront front={front()} testID="front" width={150} />);
    expect(unsigned.queryByTestId('front-image')).toBeNull();
  });
});
