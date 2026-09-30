import { fireEvent, render } from '@testing-library/react-native';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';

import { FilmCover } from '@/components/year-films/film-cover';
import { invalidateYearFilmPoster, useYearFilmPosters } from '@/hooks/useYearFilms';

jest.mock('expo-image', () => ({
  Image: ({ source, onError, testID }: { source?: unknown; onError?: () => void; testID?: string }) => {
    const { Text } = jest.requireActual<typeof import('react-native')>('react-native');
    return (
      <Text onPress={onError} testID={testID}>
        {JSON.stringify(source)}
      </Text>
    );
  },
}));

jest.mock('@/hooks/useYearFilms', () => ({
  useYearFilmPosters: jest.fn(),
  invalidateYearFilmPoster: jest.fn(),
}));

const mockedPosters = useYearFilmPosters as jest.MockedFunction<typeof useYearFilmPosters>;
const mockedInvalidate = invalidateYearFilmPoster as jest.MockedFunction<typeof invalidateYearFilmPoster>;

const FILM = { id: 'film-1', ready_at: '2026-10-01T18:00:00.000Z' };

function renderCover(ui: ReactNode) {
  const queryClient = new QueryClient();
  return render(<QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>);
}

describe('FilmCover', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('renders the signed poster with the stable cache key and a 9:16 frame', () => {
    mockedPosters.mockReturnValue({
      'film-1': { url: 'https://signed.example/thumb', cacheKey: 'film-thumb:film-1:2026-10-01T18:00:00.000Z' },
    });
    const { getByTestId } = renderCover(<FilmCover film={FILM} showPlay testID="cover" width={90} />);

    expect(mockedPosters).toHaveBeenCalledWith([FILM]);
    expect(getByTestId('cover-image').props.children).toContain('"cacheKey":"film-thumb:film-1:2026-10-01T18:00:00.000Z"');
    expect(getByTestId('cover-image').props.children).toContain('"uri":"https://signed.example/thumb"');
    expect(getByTestId('cover-play')).toBeTruthy();
    const style = getByTestId('cover').props.style;
    expect(style).toEqual(expect.arrayContaining([expect.objectContaining({ width: 90, height: 160, borderRadius: 12 })]));
  });

  it('shows only the placeholder tile (no image, no play) while there is no url', () => {
    mockedPosters.mockReturnValue({});
    const { getByTestId, queryByTestId } = renderCover(<FilmCover film={FILM} testID="cover" width={90} />);

    expect(getByTestId('cover')).toBeTruthy();
    expect(queryByTestId('cover-image')).toBeNull();
    expect(queryByTestId('cover-play')).toBeNull();
  });

  it('honours height and radius overrides', () => {
    mockedPosters.mockReturnValue({});
    const { getByTestId } = renderCover(<FilmCover film={FILM} height={100} radius={20} testID="cover" width={90} />);
    const style = getByTestId('cover').props.style;
    expect(style).toEqual(expect.arrayContaining([expect.objectContaining({ width: 90, height: 100, borderRadius: 20 })]));
  });

  it('re-signs the poster when the image fails to load', () => {
    mockedPosters.mockReturnValue({ 'film-1': { url: 'https://signed.example/dead', cacheKey: 'k' } });
    const { getByTestId } = renderCover(<FilmCover film={FILM} testID="cover" width={90} />);

    fireEvent.press(getByTestId('cover-image'));

    expect(mockedInvalidate).toHaveBeenCalledWith(expect.anything(), 'film-1');
  });
});
