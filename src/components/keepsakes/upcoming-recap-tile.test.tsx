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
    const { getByText } = render(<UpcomingRecapTile recap={recap()} />);
    expect(getByText('October recap')).toBeTruthy();
  });

  it('locked: dashed tile, progress bar and the moments hint', () => {
    const { getByTestId, getByText, queryByText } = render(<UpcomingRecapTile recap={recap({ moments: 6 })} />);
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
    const { getByText, getByTestId } = render(<UpcomingRecapTile recap={short} />);
    expect(getByText('2 more with a picture')).toBeTruthy();
    // The bar is capped at full.
    expect(getByTestId('keepsakes-upcoming-recap-progress').props.style).toEqual(
      expect.arrayContaining([expect.objectContaining({ width: '100%' })]),
    );
  });

  it('unlocked: solid tile with "arrives" and the delivery date', () => {
    const ready = recap({ moments: 23, visuals: 9 });
    expect(isUpcomingRecapLocked(ready)).toBe(false);
    const { getByTestId, getByText, queryByTestId } = render(<UpcomingRecapTile recap={ready} />);
    expect(getByText('arrives')).toBeTruthy();
    expect(getByText('Nov 1')).toBeTruthy();
    expect(queryByTestId('keepsakes-upcoming-recap-progress')).toBeNull();
    expect(getByTestId('keepsakes-upcoming-recap').props.style).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ borderStyle: 'dashed' })]),
    );
  });

  it('captions: progress while locked, the date and count once unlocked', () => {
    expect(upcomingRecapCaptionMeta(recap({ moments: 6 }))).toBe('6 of 10 moments');
    expect(upcomingRecapCaptionMeta(recap({ moments: 23, visuals: 9 }))).toBe('arrives Nov 1 · 23 moments so far');
  });

  it('shows the faded picture only when a key resolves; otherwise a flat tile', () => {
    const flat = render(<UpcomingRecapTile recap={recap({ picture_key: 'pics/a.webp' })} />);
    expect(flat.queryByTestId('keepsakes-upcoming-recap-picture')).toBeNull();
    flat.unmount();

    mockUrl = 'https://r2/a.webp';
    const withPicture = render(<UpcomingRecapTile recap={recap({ picture_key: 'pics/a.webp' })} />);
    expect(withPicture.getByTestId('keepsakes-upcoming-recap-picture')).toBeTruthy();
    withPicture.unmount();

    const noKey = render(<UpcomingRecapTile recap={recap({ picture_key: null })} />);
    expect(noKey.queryByTestId('keepsakes-upcoming-recap-picture')).toBeNull();
  });
});
