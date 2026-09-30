import { StyleSheet } from 'react-native';
import { fireEvent, render } from '@testing-library/react-native';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

import { FilmCard, filmCardLook } from '@/components/year-films/film-card';
import type { YearFilm } from '@/services/year-films';

jest.mock('@/hooks/useYearFilms', () => ({
  useYearFilmPosters: () => ({}),
  invalidateYearFilmPoster: jest.fn(),
}));

const FILM = {
  id: 'film-1',
  kind: 'birthday',
  family_member_id: 'member-1',
  age_year: 4,
  placement_date: '2026-10-05',
  scope_start_date: '2025-10-05',
  duration_ms: 95000,
  surface_at: '2026-10-07T09:00:00.000Z',
  ready_at: '2026-10-07T08:00:00.000Z',
} as unknown as YearFilm;

const MEMBERS = [{ id: 'member-1', name: 'Enzo' }];

const queryClient = new QueryClient();
afterEach(() => queryClient.clear());

function renderCard(props: Partial<React.ComponentProps<typeof FilmCard>> = {}) {
  const onPress = jest.fn();
  const screen = render(
    <QueryClientProvider client={queryClient}>
      <FilmCard film={FILM} isNew={false} members={MEMBERS} onPress={onPress} {...props} />
    </QueryClientProvider>,
  );
  return { ...screen, onPress };
}

function flatStyle(node: { props: { style?: unknown } }): Record<string, unknown> {
  return StyleSheet.flatten(node.props.style as never) as Record<string, unknown>;
}

describe('FilmCard', () => {
  it('is a labelled button with no text outside the cover, and plays with the film id on press', () => {
    const { getByTestId, queryByTestId, onPress } = renderCard();
    const card = getByTestId('timeline-film-film-1');
    expect(card.props.accessibilityRole).toBe('button');
    expect(card.props.accessibilityLabel).toBe("Play Enzo's Year Four");
    expect(queryByTestId('timeline-film-film-1-title')).toBeNull();
    expect(queryByTestId('timeline-film-film-1-subtitle')).toBeNull();
    fireEvent.press(card);
    expect(onPress).toHaveBeenCalledWith('film-1');
  });

  it('renders the cover without its own glyph, plus the pink play button', () => {
    const { getByTestId, queryByTestId } = renderCard();
    expect(getByTestId('timeline-film-film-1-cover')).toBeTruthy();
    expect(queryByTestId('timeline-film-film-1-cover-play')).toBeNull();
    expect(getByTestId('timeline-film-film-1-play')).toBeTruthy();
  });

  it('shows the New sticker only when told to', () => {
    const off = renderCard();
    expect(off.queryByTestId('timeline-film-film-1-new')).toBeNull();
    off.unmount();
    const on = renderCard({ isNew: true });
    expect(on.getByTestId('timeline-film-film-1-new')).toHaveTextContent('New');
  });

  it('derives side, tilt and tape colour from the id only (stable, both sides occur)', () => {
    const ids = Array.from({ length: 40 }, (_, i) => `film-${i}`);
    const looks = ids.map((id) => filmCardLook(id));
    expect(ids.map((id) => filmCardLook(id))).toEqual(looks);
    expect(new Set(looks.map((l) => l.side))).toEqual(new Set(['left', 'right']));
    expect(new Set(looks.map((l) => l.tape)).size).toBe(3);
    for (const l of looks) expect(l.tilt).toBe(l.side === 'left' ? -3.5 : 3);
  });

  it('places the polaroid on its hashed side and tilts it that way', () => {
    const left = ids('left');
    const right = ids('right');
    const l = renderCard({ film: { ...FILM, id: left } });
    expect(flatStyle(l.getByTestId(`timeline-film-${left}`)).alignSelf).toBe('flex-start');
    l.unmount();
    const r = renderCard({ film: { ...FILM, id: right } });
    expect(flatStyle(r.getByTestId(`timeline-film-${right}`)).alignSelf).toBe('flex-end');
  });
});

function ids(side: 'left' | 'right'): string {
  for (let i = 0; i < 100; i += 1) if (filmCardLook(`f${i}`).side === side) return `f${i}`;
  throw new Error('no id found');
}
