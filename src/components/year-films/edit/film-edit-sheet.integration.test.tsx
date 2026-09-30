import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { FILM_EDIT_REMOVAL_NOTE, FilmEditSheet } from '@/components/year-films/edit/film-edit-sheet';
import { pauseAllAudioPlayback, resetAudioPlaybackCoordinatorForTests } from '@/hooks/audio-playback-coordinator';
import { useSaveYearFilmEdits, useYearFilmEditOptions } from '@/hooks/useYearFilms';
import { trackEvent } from '@/services/analytics';
import type { YearFilmEditOptions } from '@/services/year-films';

jest.mock('@/hooks/useYearFilms', () => ({
  useYearFilmEditOptions: jest.fn(),
  useSaveYearFilmEdits: jest.fn(),
}));
jest.mock('@/hooks/useYearFilmEditFrames', () => ({
  useYearFilmEditFrames: () => ({
    resolve: () => ({ key: null, url: undefined, fallback: 'blank', emotion: null }),
    isLoading: false,
  }),
}));
jest.mock('lucide-react-native', () => ({
  EyeOff: () => null,
  Play: () => null,
  Square: () => null,
}));
jest.mock('@/services/analytics', () => ({ trackEvent: jest.fn() }));

interface MockPlayer {
  replace: jest.Mock;
  play: jest.Mock;
  pause: jest.Mock;
  seekTo: jest.Mock;
  remove: jest.Mock;
  addListener: jest.Mock;
}
let mockPlayers: MockPlayer[] = [];
jest.mock('expo-audio', () => ({
  createAudioPlayer: () => {
    const player = {
      replace: jest.fn(),
      play: jest.fn(),
      pause: jest.fn(),
      seekTo: jest.fn(() => Promise.resolve()),
      remove: jest.fn(),
      addListener: jest.fn(() => ({ remove: jest.fn() })),
    };
    mockPlayers.push(player);
    return player;
  },
  setAudioModeAsync: jest.fn(() => Promise.resolve()),
}));

const mockedOptionsHook = useYearFilmEditOptions as jest.MockedFunction<typeof useYearFilmEditOptions>;
const mockedSaveHook = useSaveYearFilmEdits as jest.MockedFunction<typeof useSaveYearFilmEdits>;
const mockedTrack = trackEvent as jest.MockedFunction<typeof trackEvent>;

const safeAreaMetrics = {
  frame: { height: 844, width: 390, x: 0, y: 0 },
  insets: { bottom: 34, left: 0, right: 0, top: 47 },
};

const editable: Extract<YearFilmEditOptions, { editable: true }> = {
  editable: true,
  kind: 'birthday',
  editsVersion: 1,
  musicBedId: 'bright-pop',
  removedMemoryIds: ['m-4'],
  chosenQuote: null,
  frames: [
    { memoryId: 'm-1', date: '2026-09-04', kind: 'photo' },
    { memoryId: 'm-2', date: '2026-09-05', kind: 'video' },
    { memoryId: 'm-3', date: '2026-09-06', kind: 'illustration' },
    { memoryId: 'm-4', date: '2026-09-07', kind: 'photo' },
  ],
  quoteCandidates: [
    { memoryId: 'q-1', textHash: 'h1', text: 'I love the moon', speakerName: 'Enzo', isCurrent: true },
    { memoryId: 'q-2', textHash: 'h2', text: 'More cheese please', speakerName: null, isCurrent: false },
  ],
};

const mutateAsync = jest.fn();
const onClose = jest.fn();
const onSaved = jest.fn();

function mockOptions(options: YearFilmEditOptions | null, extra: { isLoading?: boolean; isError?: boolean } = {}) {
  mockedOptionsHook.mockReturnValue({
    options,
    isLoading: extra.isLoading ?? false,
    isError: extra.isError ?? false,
    refetch: jest.fn(),
  } as unknown as ReturnType<typeof useYearFilmEditOptions>);
}

async function renderSheet(visible = true) {
  return render(
    <SafeAreaProvider initialMetrics={safeAreaMetrics}>
      <FilmEditSheet familyId="family-1" filmId="film-1" onClose={onClose} onSaved={onSaved} visible={visible} />
    </SafeAreaProvider>,
  );
}

describe('FilmEditSheet', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockPlayers = [];
    resetAudioPlaybackCoordinatorForTests();
    mockOptions(editable);
    mockedSaveHook.mockReturnValue({ mutateAsync, isPending: false } as unknown as ReturnType<typeof useSaveYearFilmEdits>);
    mutateAsync.mockResolvedValue({ ok: true, editsVersion: 2 });
    jest.spyOn(globalThis, 'requestAnimationFrame').mockImplementation((callback) => {
      callback(0);
      return 0;
    });
  });

  it('renders nothing while closed and does not load options', async () => {
    await renderSheet(false);

    expect(screen.queryByTestId('film-edit-sheet')).toBeNull();
    expect(mockedOptionsHook).not.toHaveBeenCalled();
  });

  it('shows moments, the line of the year and the music, and tracks the open once', async () => {
    const view = await renderSheet();

    expect(screen.getByTestId('film-edit-moment-m-1')).toBeTruthy();
    expect(screen.getByTestId('film-edit-moment-m-4-hidden')).toBeTruthy();
    expect(screen.getByTestId('film-edit-hidden-count').props.children).toBe('1 hidden');
    expect(screen.getByTestId('film-edit-quote-0').props.accessibilityState.checked).toBe(true);
    expect(screen.getByTestId('film-edit-quote-1').props.accessibilityState.checked).toBe(false);
    // Birthday beds only; the current one is checked.
    expect(screen.getByTestId('film-edit-bed-bright-pop').props.accessibilityState.checked).toBe(true);
    expect(screen.getByTestId('film-edit-bed-sparkle-pop')).toBeTruthy();
    expect(screen.queryByTestId('film-edit-bed-bubbly-synth')).toBeNull();

    expect(mockedTrack).toHaveBeenCalledWith('year_film_edit_opened', { kind: 'birthday' });
    view.rerender(
      <SafeAreaProvider initialMetrics={safeAreaMetrics}>
        <FilmEditSheet familyId="family-1" filmId="film-1" onClose={onClose} onSaved={onSaved} visible />
      </SafeAreaProvider>,
    );
    expect(mockedTrack.mock.calls.filter(([name]) => name === 'year_film_edit_opened')).toHaveLength(1);
  });

  it('keeps Save disabled until something changes, and reverting disables it again', async () => {
    await renderSheet();
    const save = () => screen.getByTestId('film-edit-save');
    expect(save().props.accessibilityState.disabled).toBe(true);

    fireEvent.press(screen.getByTestId('film-edit-moment-m-1'));
    expect(save().props.accessibilityState.disabled).toBe(false);

    fireEvent.press(screen.getByTestId('film-edit-moment-m-1'));
    expect(save().props.accessibilityState.disabled).toBe(true);
  });

  it('hides a new moment, warns that removal takes the film down, and saves the full removed set', async () => {
    await renderSheet();
    expect(screen.queryByTestId('film-edit-removal-note')).toBeNull();

    fireEvent.press(screen.getByTestId('film-edit-moment-m-2'));

    expect(screen.getByTestId('film-edit-hidden-count').props.children).toBe('2 hidden');
    expect(screen.getByTestId('film-edit-removal-note').props.children).toBe(FILM_EDIT_REMOVAL_NOTE);

    await act(async () => {
      fireEvent.press(screen.getByTestId('film-edit-save'));
    });

    expect(mutateAsync).toHaveBeenCalledWith({
      filmId: 'film-1',
      edits: { removedMemoryIds: ['m-4', 'm-2'] },
    });
    expect(mockedTrack).toHaveBeenCalledWith('year_film_edit_saved', {
      kind: 'birthday',
      removed_count: 2,
      quote_changed: false,
      music_changed: false,
    });
    expect(onSaved).toHaveBeenCalledTimes(1);
  });

  it('restoring a removed moment needs no takedown note', async () => {
    await renderSheet();

    fireEvent.press(screen.getByTestId('film-edit-moment-m-4'));

    expect(screen.queryByTestId('film-edit-hidden-count')).toBeNull();
    expect(screen.queryByTestId('film-edit-removal-note')).toBeNull();
    await act(async () => {
      fireEvent.press(screen.getByTestId('film-edit-save'));
    });
    expect(mutateAsync).toHaveBeenCalledWith({ filmId: 'film-1', edits: { removedMemoryIds: [] } });
  });

  it('sends the quote and the music only when they changed', async () => {
    await renderSheet();

    fireEvent.press(screen.getByTestId('film-edit-quote-1'));
    fireEvent.press(screen.getByTestId('film-edit-bed-sparkle-pop'));
    expect(screen.getByTestId('film-edit-quote-1').props.accessibilityState.checked).toBe(true);
    expect(screen.getByTestId('film-edit-bed-sparkle-pop').props.accessibilityState.checked).toBe(true);

    await act(async () => {
      fireEvent.press(screen.getByTestId('film-edit-save'));
    });

    expect(mutateAsync).toHaveBeenCalledWith({
      filmId: 'film-1',
      edits: {
        removedMemoryIds: ['m-4'],
        quote: { memoryId: 'q-2', textHash: 'h2' },
        musicBedId: 'sparkle-pop',
      },
    });
    expect(mockedTrack).toHaveBeenCalledWith('year_film_edit_saved', {
      kind: 'birthday',
      removed_count: 1,
      quote_changed: true,
      music_changed: true,
    });
  });

  it('omits the line of the year when there are no candidates', async () => {
    mockOptions({ ...editable, quoteCandidates: [] });

    await renderSheet();

    expect(screen.queryByTestId('film-edit-quote-list')).toBeNull();
    expect(screen.queryByText('Line of the year')).toBeNull();
  });

  it('explains fair use when the film was remade too often, and stays open', async () => {
    mutateAsync.mockResolvedValue({ ok: false, reason: 'rate_limited' });
    await renderSheet();
    fireEvent.press(screen.getByTestId('film-edit-bed-sparkle-pop'));

    await act(async () => {
      fireEvent.press(screen.getByTestId('film-edit-save'));
    });

    expect(screen.getByTestId('film-edit-error').props.children).toBe(
      "You've remade this film a lot today. Try again tomorrow.",
    );
    expect(onSaved).not.toHaveBeenCalled();
    expect(mockedTrack).not.toHaveBeenCalledWith('year_film_edit_saved', expect.anything());
  });

  it('explains a film that can no longer be edited', async () => {
    mutateAsync.mockResolvedValue({ ok: false, reason: 'film_not_editable' });
    await renderSheet();
    fireEvent.press(screen.getByTestId('film-edit-bed-sparkle-pop'));

    await act(async () => {
      fireEvent.press(screen.getByTestId('film-edit-save'));
    });

    expect(screen.getByTestId('film-edit-error').props.children).toBe("This film can't be edited right now.");
  });

  it('shows a retryable error when the save request fails', async () => {
    mutateAsync.mockRejectedValue(new Error('offline'));
    await renderSheet();
    fireEvent.press(screen.getByTestId('film-edit-bed-sparkle-pop'));

    await act(async () => {
      fireEvent.press(screen.getByTestId('film-edit-save'));
    });

    expect(screen.getByTestId('film-edit-error')).toBeTruthy();
    expect(onSaved).not.toHaveBeenCalled();
    expect(screen.getByTestId('film-edit-save').props.accessibilityState.disabled).toBe(false);
  });

  it('plays and stops a bed preview, one at a time, without selecting it', async () => {
    await renderSheet();

    await act(async () => {
      fireEvent.press(screen.getByTestId('film-edit-bed-preview-sparkle-pop'));
    });

    expect(mockPlayers).toHaveLength(1);
    expect(mockPlayers[0].replace).toHaveBeenCalledTimes(1);
    expect(mockPlayers[0].play).toHaveBeenCalledTimes(1);
    expect(screen.getByLabelText('Stop Sparkle pop preview')).toBeTruthy();
    expect(screen.getByTestId('film-edit-bed-sparkle-pop').props.accessibilityState.checked).toBe(false);

    await act(async () => {
      fireEvent.press(screen.getByTestId('film-edit-bed-preview-bright-pop'));
    });
    expect(screen.getByLabelText('Stop Bright pop preview')).toBeTruthy();
    expect(screen.getByLabelText('Play Sparkle pop preview')).toBeTruthy();

    await act(async () => {
      fireEvent.press(screen.getByTestId('film-edit-bed-preview-bright-pop'));
    });
    expect(screen.getByLabelText('Play Bright pop preview')).toBeTruthy();
    expect(mockPlayers[0].pause).toHaveBeenCalled();
  });

  it('stops a preview when other audio takes over', async () => {
    await renderSheet();
    await act(async () => {
      fireEvent.press(screen.getByTestId('film-edit-bed-preview-sparkle-pop'));
    });
    expect(screen.getByLabelText('Stop Sparkle pop preview')).toBeTruthy();

    act(() => {
      pauseAllAudioPlayback();
    });

    expect(screen.getByLabelText('Play Sparkle pop preview')).toBeTruthy();
  });

  it('stops a preview when saving', async () => {
    await renderSheet();
    await act(async () => {
      fireEvent.press(screen.getByTestId('film-edit-bed-preview-sparkle-pop'));
    });
    fireEvent.press(screen.getByTestId('film-edit-bed-sparkle-pop'));

    await act(async () => {
      fireEvent.press(screen.getByTestId('film-edit-save'));
    });

    expect(mockPlayers[0].pause).toHaveBeenCalled();
  });

  it('closes from the backdrop, but not while a save is in flight', async () => {
    const view = await renderSheet();
    fireEvent.press(screen.getByTestId('film-edit-sheet-backdrop', { includeHiddenElements: true }));
    expect(onClose).toHaveBeenCalledTimes(1);

    onClose.mockClear();
    mockedSaveHook.mockReturnValue({ mutateAsync, isPending: true } as unknown as ReturnType<typeof useSaveYearFilmEdits>);
    view.rerender(
      <SafeAreaProvider initialMetrics={safeAreaMetrics}>
        <FilmEditSheet familyId="family-1" filmId="film-1" onClose={onClose} onSaved={onSaved} visible />
      </SafeAreaProvider>,
    );
    await waitFor(() => expect(screen.getByTestId('film-edit-save').props.accessibilityState.busy).toBe(true));
    fireEvent.press(screen.getByTestId('film-edit-sheet-backdrop', { includeHiddenElements: true }));
    expect(onClose).not.toHaveBeenCalled();
  });

  it.each([
    ['blocked', "This film can't be edited right now."],
    ['not_ready', 'This film is being remade. You can edit it again once the new version is ready.'],
    ['subscription_required', 'Editing films needs an active subscription.'],
  ] as const)('explains a film that is not editable (%s)', async (reason, message) => {
    mockOptions({ editable: false, reason });

    await renderSheet();

    expect(screen.getByTestId('film-edit-not-editable')).toBeTruthy();
    expect(screen.getByText(message)).toBeTruthy();
    expect(screen.queryByTestId('film-edit-save')).toBeNull();
    expect(mockedTrack).not.toHaveBeenCalled();
  });

  it('shows a loading state and an error state with retry', async () => {
    mockOptions(null, { isLoading: true });
    const view = await renderSheet();
    expect(screen.getByTestId('film-edit-loading')).toBeTruthy();

    const refetch = jest.fn();
    mockedOptionsHook.mockReturnValue({
      options: null,
      isLoading: false,
      isError: true,
      refetch,
    } as unknown as ReturnType<typeof useYearFilmEditOptions>);
    view.rerender(
      <SafeAreaProvider initialMetrics={safeAreaMetrics}>
        <FilmEditSheet familyId="family-1" filmId="film-1" onClose={onClose} onSaved={onSaved} visible />
      </SafeAreaProvider>,
    );
    fireEvent.press(screen.getByTestId('film-edit-retry'));
    expect(refetch).toHaveBeenCalled();
  });
});
