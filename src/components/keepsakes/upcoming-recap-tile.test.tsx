import { render } from '@testing-library/react-native';

import {
  UpcomingRecapTile,
  isUpcomingRecapLocked,
  upcomingRecapCaptionMeta,
  upcomingRecapHint,
  upcomingRecapTitle,
} from '@/components/keepsakes/upcoming-recap-tile';
import type { KeepsakesRecap } from '@/services/keepsakes';

let mockUrl: string | undefined;
jest.mock('@/hooks/useMediaUrls', () => ({
  useMediaUrl: jest.fn(() => ({ url: mockUrl, isLoading: false, isError: false })),
}));

const TODAY = '2026-10-07';

function recap(overrides: Partial<KeepsakesRecap> = {}): KeepsakesRecap {
  return {
    month_start: '2026-10-01',
    delivers_on: '2026-11-01',
    moments: 6,
    visuals: 4,
    min_moments: 10,
    min_visuals: 6,
    picture_key: null,
    ...overrides,
  };
}

describe('UpcomingRecapTile', () => {
  beforeEach(() => {
    mockUrl = undefined;
  });

  it('titles the tile from the owner-local month and not the device clock', () => {
    expect(upcomingRecapTitle(recap({ month_start: '2026-12-01' }))).toBe('December recap');
    const { getByText } = render(<UpcomingRecapTile todayIso={TODAY} recap={recap()} />);
    expect(getByText('October recap')).toBeTruthy();
  });

  it('locked: dashed tile, progress bar and the moments hint', () => {
    const { getByTestId, getByText, queryByText } = render(<UpcomingRecapTile todayIso={TODAY} recap={recap({ moments: 6 })} />);
    expect(getByTestId('keepsakes-upcoming-recap').props.style).toEqual(
      expect.arrayContaining([expect.objectContaining({ borderStyle: 'dashed' })]),
    );
    expect(getByText('4 more moments this month')).toBeTruthy();
    expect(getByTestId('keepsakes-upcoming-recap-progress').props.style).toEqual(
      expect.arrayContaining([expect.objectContaining({ width: '60%' })]),
    );
    expect(queryByText('arrives')).toBeNull();
  });

  it('singular hint at one moment short', () => {
    expect(upcomingRecapHint(recap({ moments: 9 }))).toBe('1 more moment this month');
  });

  it('visuals short: enough moments but not enough pictures', () => {
    const short = recap({ moments: 12, visuals: 4 });
    expect(isUpcomingRecapLocked(short)).toBe(true);
    expect(upcomingRecapHint(short)).toBe('2 more with a picture');
    const { getByText, getByTestId } = render(<UpcomingRecapTile todayIso={TODAY} recap={short} />);
    expect(getByText('2 more with a picture')).toBeTruthy();
    // The bar is capped at full.
    expect(getByTestId('keepsakes-upcoming-recap-progress').props.style).toEqual(
      expect.arrayContaining([expect.objectContaining({ width: '100%' })]),
    );
  });

  it('unlocked: solid tile with "arrives" and the delivery date', () => {
    const ready = recap({ moments: 23, visuals: 9 });
    expect(isUpcomingRecapLocked(ready)).toBe(false);
    const { getByTestId, getByText, queryByTestId } = render(<UpcomingRecapTile todayIso={TODAY} recap={ready} />);
    expect(getByText('arrives')).toBeTruthy();
    expect(getByText('Nov 1')).toBeTruthy();
    expect(queryByTestId('keepsakes-upcoming-recap-progress')).toBeNull();
    expect(getByTestId('keepsakes-upcoming-recap').props.style).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ borderStyle: 'dashed' })]),
    );
  });

  it('captions: progress while locked, the date and count once unlocked', () => {
    expect(upcomingRecapCaptionMeta(recap({ moments: 6 }), TODAY)).toBe('6 of 10 moments');
    expect(upcomingRecapCaptionMeta(recap({ moments: 23, visuals: 9 }), TODAY)).toBe('arrives Nov 1 · 23 moments so far');
  });

  describe('previous recap (last month’s, kept on the 1st until its film appears)', () => {
    const previous = (overrides: Partial<KeepsakesRecap> = {}) =>
      recap({ month_start: '2026-09-01', delivers_on: '2026-10-01', moments: 23, visuals: 9, ...overrides });

    it('is a solid "arrives today" tile titled with the previous month, with its own test id', () => {
      const { getByTestId, getByText, queryByTestId } = render(
        <UpcomingRecapTile previous recap={previous()} todayIso="2026-10-01" />,
      );
      const tile = getByTestId('keepsakes-upcoming-previous-recap');
      expect(tile.props.style).not.toEqual(expect.arrayContaining([expect.objectContaining({ borderStyle: 'dashed' })]));
      expect(tile.props.accessibilityLabel).toBe('September recap, arrives today · 23 moments');
      expect(getByText('September recap')).toBeTruthy();
      expect(getByText('arrives')).toBeTruthy();
      expect(getByText('today')).toBeTruthy();
      expect(queryByTestId('keepsakes-upcoming-previous-recap-progress')).toBeNull();
    });

    it('is always unlocked and "today", even below the floors or when the device day differs', () => {
      const low = previous({ moments: 3, visuals: 1 });
      expect(upcomingRecapCaptionMeta(low, '2026-10-01', true)).toBe('arrives today · 3 moments');
      expect(upcomingRecapCaptionMeta(previous({ moments: 1 }), '2026-09-30', true)).toBe('arrives today · 1 moment');
      const { getByText, queryByText } = render(<UpcomingRecapTile previous recap={low} todayIso="2026-09-30" />);
      expect(getByText('today')).toBeTruthy();
      expect(queryByText(/more moments/)).toBeNull();
    });
  });

  it('arrives today when delivers_on is today: no "so far", no date', () => {
    const ready = recap({ moments: 23, visuals: 9, delivers_on: '2026-11-01' });
    expect(upcomingRecapCaptionMeta(ready, '2026-11-01')).toBe('arrives today · 23 moments');
    const { getByText, queryByText } = render(<UpcomingRecapTile recap={ready} todayIso="2026-11-01" />);
    expect(getByText('today')).toBeTruthy();
    expect(queryByText('Nov 1')).toBeNull();
  });

  it('shows the faded picture only when a key resolves; otherwise a flat tile', () => {
    const flat = render(<UpcomingRecapTile todayIso={TODAY} recap={recap({ picture_key: 'pics/a.webp' })} />);
    expect(flat.queryByTestId('keepsakes-upcoming-recap-picture')).toBeNull();
    flat.unmount();

    mockUrl = 'https://r2/a.webp';
    const withPicture = render(<UpcomingRecapTile todayIso={TODAY} recap={recap({ picture_key: 'pics/a.webp' })} />);
    expect(withPicture.getByTestId('keepsakes-upcoming-recap-picture')).toBeTruthy();
    withPicture.unmount();

    const noKey = render(<UpcomingRecapTile todayIso={TODAY} recap={recap({ picture_key: null })} />);
    expect(noKey.queryByTestId('keepsakes-upcoming-recap-picture')).toBeNull();
  });
});
