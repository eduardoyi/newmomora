import { fireEvent, render } from '@testing-library/react-native';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

import { FilmCard } from '@/components/year-films/film-card';
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

describe('FilmCard', () => {
  it('shows the title and subtitle, and plays with the film id on press', () => {
    const { getByTestId, onPress } = renderCard();
    expect(getByTestId('timeline-film-film-1-title')).toHaveTextContent("Enzo's Year Four");
    expect(getByTestId('timeline-film-film-1-subtitle')).toHaveTextContent('2 minutes · Oct 2025 – Oct 2026');
    const card = getByTestId('timeline-film-film-1');
    expect(card.props.accessibilityRole).toBe('button');
    expect(card.props.accessibilityLabel).toBe("Play Enzo's Year Four");
    fireEvent.press(card);
    expect(onPress).toHaveBeenCalledWith('film-1');
  });

  it('renders the cover with a play glyph', () => {
    const { getByTestId } = renderCard();
    expect(getByTestId('timeline-film-film-1-cover')).toBeTruthy();
    expect(getByTestId('timeline-film-film-1-cover-play')).toBeTruthy();
  });

  it('shows the New pill only when told to', () => {
    const off = renderCard();
    expect(off.queryByTestId('timeline-film-film-1-new')).toBeNull();
    off.unmount();
    const on = renderCard({ isNew: true });
    expect(on.getByTestId('timeline-film-film-1-new')).toHaveTextContent('New');
  });
});
