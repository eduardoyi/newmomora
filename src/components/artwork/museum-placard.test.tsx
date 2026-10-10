import { render } from '@testing-library/react-native';
import { StyleSheet } from 'react-native';

import { buildPlacardContent, MuseumPlacard } from '@/components/artwork/museum-placard';
import { colors, fonts } from '@/constants/theme';

const MARA = { name: 'Mara', date_of_birth: '2024-06-10' };

describe('buildPlacardContent', () => {
  it('builds the single-piece placard: title, artist with full age, medium on paper and date', () => {
    expect(
      buildPlacardContent({
        caption: 'A dragon for Daddy',
        member: MARA,
        memoryDate: '2026-10-10',
        medium: 'crayon',
        pieceCount: 1,
      }),
    ).toEqual({
      title: 'A dragon for Daddy',
      artistLine: 'Mara, 2 years 4 months',
      detailLine: 'Crayon on paper · October 10, 2026',
    });
  });

  it('builds the batch placard: medium, piece count and date (no "on paper")', () => {
    expect(
      buildPlacardContent({
        caption: 'From art camp',
        member: { name: 'Theo', date_of_birth: '2022-08-06' },
        memoryDate: '2026-10-06',
        medium: 'mixed media',
        pieceCount: 3,
      }),
    ).toEqual({
      title: 'From art camp',
      artistLine: 'Theo, 4 years 2 months',
      detailLine: 'Mixed media · 3 pieces · October 6, 2026',
    });
  });

  it('drops the medium part when it is not known yet', () => {
    expect(
      buildPlacardContent({ caption: 'x', member: MARA, memoryDate: '2026-10-10', medium: null, pieceCount: 1 })
        .detailLine,
    ).toBe('October 10, 2026');
    expect(
      buildPlacardContent({ caption: 'x', member: MARA, memoryDate: '2026-10-10', medium: '  ', pieceCount: 4 })
        .detailLine,
    ).toBe('4 pieces · October 10, 2026');
  });

  it('omits the title for a blank caption and the artist line without a tagged member', () => {
    const content = buildPlacardContent({
      caption: '   ',
      member: undefined,
      memoryDate: '2026-10-10',
      medium: 'paint',
      pieceCount: 1,
    });
    expect(content.title).toBeNull();
    expect(content.artistLine).toBeNull();
    expect(content.detailLine).toBe('Paint on paper · October 10, 2026');
  });

  it('shows a name only when there is no birth date, or the artist is an adult', () => {
    const base = { caption: 't', memoryDate: '2026-10-10', medium: null, pieceCount: 1 };
    expect(buildPlacardContent({ ...base, member: { name: 'Mara', date_of_birth: null } }).artistLine).toBe('Mara');
    expect(
      buildPlacardContent({ ...base, member: { name: 'Dad', date_of_birth: '1985-01-02' } }).artistLine,
    ).toBe('Dad');
  });

  it('measures age at the memory date, not today', () => {
    expect(
      buildPlacardContent({
        caption: 't',
        member: MARA,
        memoryDate: '2025-06-10',
        medium: null,
        pieceCount: 1,
      }).artistLine,
    ).toBe('Mara, 1 year');
  });

  it('falls back to the raw date string when it cannot be parsed', () => {
    expect(
      buildPlacardContent({ caption: 't', member: null, memoryDate: 'not-a-date', medium: null, pieceCount: 1 })
        .detailLine,
    ).toBe('not-a-date');
  });
});

describe('MuseumPlacard', () => {
  it('renders title in Newsreader italic, the artist line and the detail line on a cream card', () => {
    const { getByTestId } = render(
      <MuseumPlacard
        caption="A dragon for Daddy"
        medium="crayon"
        member={MARA}
        memoryDate="2026-10-10"
        pieceCount={1}
      />,
    );

    const card = StyleSheet.flatten(getByTestId('memory-detail-artwork-placard').props.style);
    expect(card).toMatchObject({ backgroundColor: colors.frameMat, borderRadius: 3 });
    expect(StyleSheet.flatten(getByTestId('memory-detail-artwork-placard-title').props.style)).toMatchObject({
      fontFamily: fonts.displayItalic,
      fontSize: 21,
    });
    expect(getByTestId('memory-detail-artwork-placard-artist')).toHaveTextContent('Mara, 2 years 4 months');
    expect(getByTestId('memory-detail-artwork-placard-detail')).toHaveTextContent(
      'Crayon on paper · October 10, 2026',
    );
  });

  it('leaves out the title and artist rows when there is nothing to show', () => {
    const { queryByTestId, getByTestId } = render(
      <MuseumPlacard caption="" medium={null} member={null} memoryDate="2026-10-10" pieceCount={1} />,
    );

    expect(queryByTestId('memory-detail-artwork-placard-title')).toBeNull();
    expect(queryByTestId('memory-detail-artwork-placard-artist')).toBeNull();
    expect(getByTestId('memory-detail-artwork-placard-detail')).toHaveTextContent('October 10, 2026');
  });
});
