import { StyleSheet } from 'react-native';
import { fireEvent, render, userEvent, waitFor } from '@testing-library/react-native';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

import { FilmCard, POLAROID_WIDTH_RATIO, SIDE_MARGIN, filmCardLook } from '@/components/year-films/film-card';
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

const MEMBERS = [{ id: 'member-1', name: 'Tomás' }];

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
    expect(card.props.accessibilityLabel).toBe("Play Tomás' Year Four");
    expect(queryByTestId('timeline-film-film-1-title')).toBeNull();
    expect(queryByTestId('timeline-film-film-1-subtitle')).toBeNull();
    fireEvent.press(card);
    expect(onPress).toHaveBeenCalledWith('film-1');
  });

  it('dims (opacity) while pressed and never applies a scale transform', async () => {
    const { getByTestId } = renderCard();
    expect(flatStyle(getByTestId('timeline-film-film-1')).opacity).toBeUndefined();
    const user = userEvent.setup();
    // A long press holds the pressed state between press-in and release.
    const pressing = user.longPress(getByTestId('timeline-film-film-1'), { duration: 300 });
    await waitFor(() => expect(flatStyle(getByTestId('timeline-film-film-1')).opacity).toBe(0.85));
    expect(flatStyle(getByTestId('timeline-film-film-1')).transform).toBeUndefined();
    await pressing;
    expect(flatStyle(getByTestId('timeline-film-film-1')).opacity).toBeUndefined();
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

  describe('remaking (blocked while the film is remade)', () => {
    const REMAKING = { ...FILM, blocked: true, stale: true, status: 'rendering' } as YearFilm;

    it('renders a placeholder in the same polaroid frame: no button, no play, no cover, no poster request', () => {
      const { getByTestId, queryByTestId, getByText, onPress } = renderCard({ film: REMAKING });
      const card = getByTestId('timeline-film-film-1-remaking');
      expect(card).toBeTruthy();
      expect(card.props.accessibilityRole).not.toBe('button');
      expect(card.props.accessibilityLabel).toBe("Tomás' Year Four, remaking. This takes a few minutes");
      expect(getByText('Remaking your film…')).toBeTruthy();
      expect(getByText('This takes a few minutes')).toBeTruthy();
      expect(queryByTestId('timeline-film-film-1')).toBeNull();
      expect(queryByTestId('timeline-film-film-1-play')).toBeNull();
      expect(queryByTestId('timeline-film-film-1-cover')).toBeNull();
      expect(queryByTestId('timeline-film-film-1-new')).toBeNull();
      // A plain View: no press responder at all (RNTL would otherwise walk up to FilmCard's own onPress prop).
      expect(card.props.onResponderGrant).toBeUndefined();
      expect(card.props.onClick).toBeUndefined();
      fireEvent.press(card);
      expect(onPress).not.toHaveBeenCalledWith('film-1');
    });

    it('keeps the exact wrap geometry of the playable card (side, inset, width) so nothing jumps', () => {
      const left = ids('left');
      const right = ids('right');
      const playable = renderCard({ film: { ...FILM, id: left } });
      const playableStyle = flatStyle(playable.getByTestId(`timeline-film-${left}`));
      playable.unmount();
      const remaking = renderCard({ film: { ...FILM, id: left, blocked: true, status: 'queued' } as YearFilm });
      const remakingStyle = flatStyle(remaking.getByTestId(`timeline-film-${left}-remaking`));
      expect(remakingStyle).toEqual(playableStyle);
      remaking.unmount();
      const r = renderCard({ film: { ...FILM, id: right, blocked: true, status: 'queued' } as YearFilm });
      expect(flatStyle(r.getByTestId(`timeline-film-${right}-remaking`)).alignSelf).toBe('flex-end');
    });

    it('draws nothing for a hidden film (blocked and failed) if one slips past the hook', () => {
      const { queryByTestId } = renderCard({ film: { ...REMAKING, status: 'failed' } as YearFilm });
      expect(queryByTestId('timeline-film-film-1')).toBeNull();
      expect(queryByTestId('timeline-film-film-1-remaking')).toBeNull();
    });
  });

  describe('updating (stale, unblocked, mid-render)', () => {
    const UPDATING = { ...FILM, blocked: false, stale: true, status: 'rendering' } as YearFilm;

    it('stays a playable card with an Updating sticker', () => {
      const { getByTestId, onPress } = renderCard({ film: UPDATING });
      const card = getByTestId('timeline-film-film-1');
      expect(card.props.accessibilityRole).toBe('button');
      expect(card.props.accessibilityLabel).toBe("Play Tomás' Year Four, updating");
      expect(getByTestId('timeline-film-film-1-play')).toBeTruthy();
      expect(getByTestId('timeline-film-film-1-updating')).toHaveTextContent('Updating…');
      fireEvent.press(card);
      expect(onPress).toHaveBeenCalledWith('film-1');
    });

    it('takes the New sticker\'s slot instead of stacking on it', () => {
      const { getByTestId, queryByTestId } = renderCard({ film: UPDATING, isNew: true });
      expect(getByTestId('timeline-film-film-1-updating')).toBeTruthy();
      expect(queryByTestId('timeline-film-film-1-new')).toBeNull();
    });
  });

  it('derives side, tilt and tape colour from the id only (stable, both sides occur)', () => {
    const ids = Array.from({ length: 40 }, (_, i) => `film-${i}`);
    const looks = ids.map((id) => filmCardLook(id));
    expect(ids.map((id) => filmCardLook(id))).toEqual(looks);
    expect(new Set(looks.map((l) => l.side))).toEqual(new Set(['left', 'right']));
    expect(new Set(looks.map((l) => l.tape)).size).toBe(3);
    for (const l of looks) expect(l.tilt).toBe(l.side === 'left' ? -3 : 2.5);
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

  it('is a wide print (~84% of the column) with a small inset on its own side only', () => {
    const left = ids('left');
    const right = ids('right');
    const { width: windowWidth } = jest.requireActual('react-native').Dimensions.get('window');
    const column = windowWidth - 32;
    const l = renderCard({ film: { ...FILM, id: left } });
    const leftStyle = flatStyle(l.getByTestId(`timeline-film-${left}`));
    expect(POLAROID_WIDTH_RATIO).toBe(0.84);
    expect(leftStyle.width).toBe(Math.round(column * 0.84));
    expect(leftStyle.marginLeft).toBe(SIDE_MARGIN);
    expect(leftStyle.marginRight).toBe(0);
    l.unmount();
    const r = renderCard({ film: { ...FILM, id: right } });
    const rightStyle = flatStyle(r.getByTestId(`timeline-film-${right}`));
    expect(rightStyle.width).toBe(Math.round(column * 0.84));
    expect(rightStyle.marginRight).toBe(SIDE_MARGIN);
    expect(rightStyle.marginLeft).toBe(0);
  });

  it('keeps the rotated box + corner tape inside a 375pt screen', () => {
    // 375pt: column 343, print 288 wide, ~500 tall (9:16 cover + 8pt border).
    const printWidth = Math.round((375 - 32) * POLAROID_WIDTH_RATIO);
    const printHeight = ((printWidth - 16) * 16) / 9 + 16;
    for (const tilt of [-3, 2.5]) {
      const rad = (Math.abs(tilt) * Math.PI) / 180;
      const cornerSwing = (printHeight / 2) * Math.sin(rad);
      const tapeReach = 16; // tape hangs 16pt past the print's edge
      const leftEdge = 16 + SIDE_MARGIN - cornerSwing - tapeReach;
      expect(leftEdge).toBeGreaterThanOrEqual(4);
      expect(375 - (16 + SIDE_MARGIN + printWidth + cornerSwing)).toBeGreaterThanOrEqual(4);
    }
  });
});

function ids(side: 'left' | 'right'): string {
  for (let i = 0; i < 100; i += 1) if (filmCardLook(`f${i}`).side === side) return `f${i}`;
  throw new Error('no id found');
}
