import { render } from '@testing-library/react-native';

import { UpcomingFilmTile, upcomingFilmTestID } from '@/components/keepsakes/upcoming-film-tile';
import type { KeepsakesUpcomingFilm } from '@/services/keepsakes';

let mockUrl: string | undefined;
jest.mock('@/hooks/useMediaUrls', () => ({
  useMediaUrl: jest.fn(() => ({ url: mockUrl, isLoading: false, isError: false })),
}));

const members = [
  { id: 'c1', name: 'Lila' },
  { id: 'c2', name: 'Jesus' },
];

function birthday(overrides: Partial<KeepsakesUpcomingFilm> = {}): KeepsakesUpcomingFilm {
  return {
    kind: 'birthday',
    member_id: 'c1',
    age_year: 4,
    film_date: '2026-11-20',
    scope_start: '2025-11-20',
    scope_end_excl: '2026-11-20',
    moments: 12,
    visuals: 9,
    min_moments: 15,
    min_visuals: 8,
    quarters: null,
    min_quarters: null,
    picture_key: null,
    ...overrides,
  };
}

function yearEnd(overrides: Partial<KeepsakesUpcomingFilm> = {}): KeepsakesUpcomingFilm {
  return birthday({
    kind: 'family_year',
    member_id: null,
    age_year: null,
    film_date: '2027-01-01',
    scope_start: '2026-01-01',
    scope_end_excl: '2027-01-01',
    moments: 40,
    visuals: 20,
    min_moments: 30,
    min_visuals: 15,
    quarters: 3,
    min_quarters: 3,
    ...overrides,
  });
}

const dashed = expect.arrayContaining([expect.objectContaining({ borderStyle: 'dashed' })]);

describe('UpcomingFilmTile', () => {
  beforeEach(() => {
    mockUrl = undefined;
  });

  it('test ids: per child for a birthday, per window year for the year-end film', () => {
    expect(upcomingFilmTestID(birthday())).toBe('keepsakes-upcoming-birthday-c1');
    expect(upcomingFilmTestID(yearEnd())).toBe('keepsakes-upcoming-year-2026');
  });

  it('birthday, locked on moments: dashed tile, "{Name} turns {age}", progress bar and the moments hint', () => {
    const { getByTestId, getByText, queryByText } = render(<UpcomingFilmTile film={birthday()} members={members} />);
    const tile = getByTestId('keepsakes-upcoming-birthday-c1');
    expect(tile.props.style).toEqual(dashed);
    expect(tile.props.accessibilityLabel).toBe('Lila turns 4, 12 of 15 moments');
    expect(getByText('Lila turns 4')).toBeTruthy();
    expect(getByText('3 more moments')).toBeTruthy();
    expect(getByTestId('keepsakes-upcoming-birthday-c1-progress').props.style).toEqual(
      expect.arrayContaining([expect.objectContaining({ width: '80%' })]),
    );
    expect(queryByText('arrives')).toBeNull();
  });

  it('hint priority: moments, then pictures, then seasons', () => {
    const moments = render(<UpcomingFilmTile film={birthday({ visuals: 1, moments: 14 })} members={members} />);
    expect(moments.getByText('1 more moment')).toBeTruthy();
    moments.unmount();

    const pictures = render(<UpcomingFilmTile film={birthday({ moments: 20, visuals: 5 })} members={members} />);
    expect(pictures.getByText('3 more with a picture')).toBeTruthy();
    // The bar is capped at full once the moments are there.
    expect(pictures.getByTestId('keepsakes-upcoming-birthday-c1-progress').props.style).toEqual(
      expect.arrayContaining([expect.objectContaining({ width: '100%' })]),
    );
    pictures.unmount();

    const oneSeason = render(<UpcomingFilmTile film={yearEnd({ quarters: 2 })} members={members} />);
    expect(oneSeason.getByText('Needs moments from one more season')).toBeTruthy();
    oneSeason.unmount();

    const manySeasons = render(<UpcomingFilmTile film={yearEnd({ quarters: 1 })} members={members} />);
    expect(manySeasons.getByText('2 more seasons')).toBeTruthy();
  });

  it('year-end: "Your {year}" from the window start, locked by seasons even with enough moments', () => {
    const { getByTestId, getByText } = render(<UpcomingFilmTile film={yearEnd({ quarters: 2 })} members={members} />);
    expect(getByTestId('keepsakes-upcoming-year-2026').props.style).toEqual(dashed);
    expect(getByText('Your 2026')).toBeTruthy();
  });

  it('unlocked: solid tile with "arrives" and the film date, no bar', () => {
    const { getByTestId, getByText, queryByTestId } = render(
      <UpcomingFilmTile film={birthday({ moments: 16 })} members={members} />,
    );
    const tile = getByTestId('keepsakes-upcoming-birthday-c1');
    expect(tile.props.style).not.toEqual(dashed);
    expect(tile.props.accessibilityLabel).toBe('Lila turns 4, arrives Nov 20 · 16 moments');
    expect(getByText('arrives')).toBeTruthy();
    expect(getByText('Nov 20')).toBeTruthy();
    expect(queryByTestId('keepsakes-upcoming-birthday-c1-progress')).toBeNull();
  });

  it('shows the faded picture only when a key resolves; otherwise a flat tile', () => {
    const flat = render(<UpcomingFilmTile film={birthday({ picture_key: 'pics/a.webp' })} members={members} />);
    expect(flat.queryByTestId('keepsakes-upcoming-birthday-c1-picture')).toBeNull();
    flat.unmount();

    mockUrl = 'https://r2/a.webp';
    const withPicture = render(<UpcomingFilmTile film={birthday({ picture_key: 'pics/a.webp' })} members={members} />);
    expect(withPicture.getByTestId('keepsakes-upcoming-birthday-c1-picture')).toBeTruthy();
    withPicture.unmount();

    const noKey = render(<UpcomingFilmTile film={yearEnd({ picture_key: null })} members={members} />);
    expect(noKey.queryByTestId('keepsakes-upcoming-year-2026-picture')).toBeNull();
  });
});
