import { act, fireEvent, render, within } from '@testing-library/react-native';
import { router } from 'expo-router';
import { StyleSheet } from 'react-native';
import { useKeyboardState } from 'react-native-keyboard-controller';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import MemorySearchScreen, { SEARCH_DEBOUNCE_MS } from '../../app/(app)/search';
import { spacing } from '@/constants/theme';
import { useFamilyMembers } from '@/hooks/useFamilyMembers';
import { useMemorySearch } from '@/hooks/useMemories';
import { useBatchedMediaUrls } from '@/hooks/useMediaUrls';
import { trackEvent } from '@/services/analytics';
import type { MemorySearchHit, MemoryWithTags } from '@/services/memories';

jest.mock('expo-router', () => ({ router: { push: jest.fn(), back: jest.fn() } }));
jest.mock('@/hooks/useFamilyMembers', () => ({ useFamilyMembers: jest.fn() }));
jest.mock('@/hooks/useMemories', () => ({ useMemorySearch: jest.fn() }));
jest.mock('@/hooks/useMediaUrls', () => ({ useBatchedMediaUrls: jest.fn(() => ({})) }));
jest.mock('@/services/analytics', () => ({ trackEvent: jest.fn() }));
jest.mock('@/components/family-member-avatar', () => ({ FamilyMemberAvatar: () => null }));

const mockReported = new Set<string>();
jest.mock('@/hooks/useContentSafety', () => ({
  useContentSafety: () => ({
    isLoading: false,
    isError: false,
    isTargetReported: (type: string, id: string) => mockReported.has(`${type}:${id}`),
    isUserBlocked: () => false,
    revealTarget: jest.fn(),
  }),
}));

const mockedUseMemorySearch = useMemorySearch as jest.MockedFunction<typeof useMemorySearch>;
const mockedUseFamilyMembers = useFamilyMembers as jest.MockedFunction<typeof useFamilyMembers>;
const mockedUseBatchedMediaUrls = useBatchedMediaUrls as jest.MockedFunction<typeof useBatchedMediaUrls>;
const mockedUseKeyboardState = useKeyboardState as jest.Mock;

const BOTTOM_INSET = 48; // Android three-button navigation

function memory(overrides: Partial<MemoryWithTags>): MemoryWithTags {
  return {
    id: 'memory-1',
    family_id: 'family-1',
    user_id: 'user-1',
    content: null,
    memory_type: 'text_only',
    memory_date: '2026-09-09',
    emotion: null,
    illustration_key: null,
    illustration_generation_id: null,
    media_key: null,
    media_content_type: null,
    link_previews: {},
    mediaAssets: [],
    taggedMembers: [],
    likeCount: 0,
    commentCount: 0,
    likedByMe: false,
    ...overrides,
  } as MemoryWithTags;
}

function searchState(overrides: Partial<ReturnType<typeof useMemorySearch>> = {}): ReturnType<typeof useMemorySearch> {
  return {
    hits: [],
    hasCriteria: false,
    isLoading: false,
    isFetching: false,
    isError: false,
    refetch: jest.fn(),
    fetchNextPage: jest.fn(),
    hasNextPage: false,
    isFetchingNextPage: false,
    ...overrides,
  } as ReturnType<typeof useMemorySearch>;
}

function renderScreen() {
  return render(
    <SafeAreaProvider
      initialMetrics={{
        frame: { height: 844, width: 390, x: 0, y: 0 },
        insets: { bottom: BOTTOM_INSET, left: 0, right: 0, top: 32 },
      }}
    >
      <MemorySearchScreen />
    </SafeAreaProvider>,
  );
}

function lastSearchArgs() {
  return mockedUseMemorySearch.mock.calls.at(-1)?.[0];
}

describe('Timeline search screen', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockReported.clear();
    mockedUseKeyboardState.mockImplementation((selector?: (state: { isVisible: boolean }) => unknown) =>
      (selector ? selector({ isVisible: false }) : { isVisible: false }));
    mockedUseFamilyMembers.mockReturnValue({
      members: [
        { id: 'member-enzo', name: 'Enzo' },
        { id: 'member-mara', name: 'Mara' },
      ],
    } as never);
    mockedUseMemorySearch.mockReturnValue(searchState());
  });

  it('opens with a focused field, people and feeling chips, and a hint', () => {
    const { getByTestId, getByText } = renderScreen();

    expect(getByTestId('memory-search-input').props.autoFocus).toBe(true);
    expect(getByTestId('memory-search-person-member-enzo')).toBeTruthy();
    expect(getByTestId('memory-search-feeling-joy')).toBeTruthy();
    expect(getByText('Mara')).toBeTruthy();
    expect(getByTestId('memory-search-hint')).toBeTruthy();
    expect(trackEvent).toHaveBeenCalledWith('memory_search_opened', { source: 'timeline' });
  });

  it('waits for typing to settle before searching', () => {
    jest.useFakeTimers();
    try {
      const { getByTestId } = renderScreen();
      fireEvent.changeText(getByTestId('memory-search-input'), 'cum');
      fireEvent.changeText(getByTestId('memory-search-input'), 'cumple');
      expect(lastSearchArgs()).toEqual({ query: '', memberId: null, emotion: null });

      act(() => { jest.advanceTimersByTime(SEARCH_DEBOUNCE_MS); });
      expect(lastSearchArgs()).toEqual({ query: 'cumple', memberId: null, emotion: null });
    } finally {
      jest.useRealTimers();
    }
  });

  it('toggles one person and one feeling chip, combined with the text', () => {
    const { getByTestId } = renderScreen();

    fireEvent.press(getByTestId('memory-search-person-member-mara'));
    fireEvent.press(getByTestId('memory-search-feeling-joy'));
    expect(lastSearchArgs()).toEqual({ query: '', memberId: 'member-mara', emotion: 'joy' });
    expect(getByTestId('memory-search-person-member-mara').props.accessibilityState).toEqual({ selected: true });

    fireEvent.press(getByTestId('memory-search-person-member-enzo'));
    expect(lastSearchArgs()?.memberId).toBe('member-enzo');

    fireEvent.press(getByTestId('memory-search-person-member-enzo'));
    fireEvent.press(getByTestId('memory-search-feeling-joy'));
    expect(lastSearchArgs()).toEqual({ query: '', memberId: null, emotion: null });
  });

  it('shows compact rows with highlights, why it matched, and the right thumbnail', () => {
    const hits: MemorySearchHit[] = [
      { memory: memory({ id: 'text-1', content: 'Cumpleaños de Mara', emotion: 'joy' }), matchedIn: 'text' },
      { memory: memory({ id: 'voice-1', memory_type: 'audio', content: 'Bedtime', media_content_type: 'audio/mp4' }), matchedIn: 'voice' },
      {
        memory: memory({ id: 'photo-1', memory_type: 'media', media_content_type: 'image/jpeg', mediaAssets: [{ id: 'a', object_key: 'u/p.jpg', content_type: 'image/jpeg', preview_object_key: 'u/p-preview.jpg' } as never] }),
        matchedIn: 'details',
      },
    ];
    mockedUseMemorySearch.mockReturnValue(searchState({ hits, hasCriteria: true }));
    mockedUseBatchedMediaUrls.mockReturnValue({ 'u/p-preview.jpg': 'https://signed.example/p' });

    const { getByTestId, queryByTestId } = renderScreen();

    // The text row: plain quote tile, no "why" note needed.
    expect(getByTestId('memory-search-row-text-1-tile-quote')).toBeTruthy();
    expect(queryByTestId('memory-search-row-text-1-note')).toBeNull();
    // The voice row: sound tile + "Matched what was said", never the transcript.
    expect(getByTestId('memory-search-row-voice-1-tile-sound')).toBeTruthy();
    expect(within(getByTestId('memory-search-row-voice-1')).getByText('Matched what was said')).toBeTruthy();
    // The photo row: its list-sized preview, requested through one batched lookup.
    expect(getByTestId('memory-search-row-photo-1-image')).toBeTruthy();
    expect(within(getByTestId('memory-search-row-photo-1')).getByText("Matched what's in the picture")).toBeTruthy();
    expect(mockedUseBatchedMediaUrls).toHaveBeenLastCalledWith(['u/p-preview.jpg']);
  });

  it('leaves out reported memories and hides reported illustrations', () => {
    mockReported.add('memory:hidden-1');
    mockReported.add('memory_illustration:illustrated-1');
    mockedUseMemorySearch.mockReturnValue(searchState({
      hasCriteria: true,
      hits: [
        { memory: memory({ id: 'hidden-1', content: 'Hidden' }), matchedIn: 'text' },
        { memory: memory({ id: 'illustrated-1', memory_type: 'text_illustration', content: 'Park', illustration_key: 'u/i.webp' }), matchedIn: 'text' },
      ],
    }));

    const { queryByTestId, getByTestId } = renderScreen();

    expect(queryByTestId('memory-search-row-hidden-1')).toBeNull();
    expect(getByTestId('memory-search-row-illustrated-1-tile-quote')).toBeTruthy();
    expect(mockedUseBatchedMediaUrls).toHaveBeenLastCalledWith([]);
  });

  it('opens a memory and records only non-identifying analytics', () => {
    mockedUseMemorySearch.mockReturnValue(searchState({
      hasCriteria: true,
      hits: [{ memory: memory({ id: 'memory-7', content: 'Beach' }), matchedIn: 'text' }],
    }));
    const { getByTestId } = renderScreen();

    fireEvent.press(getByTestId('memory-search-row-memory-7'));

    expect(router.push).toHaveBeenCalledWith('/(app)/memory/memory-7');
    expect(trackEvent).toHaveBeenCalledWith('memory_search_result_opened', {
      matched_in: 'text', position: 0, has_text: false, has_person: false, has_feeling: false,
    });
  });

  it('explains when nothing matches, and offers a retry on errors', () => {
    mockedUseMemorySearch.mockReturnValue(searchState({ hasCriteria: true }));
    const { getByTestId, rerender } = renderScreen();
    expect(getByTestId('memory-search-empty')).toBeTruthy();

    const refetch = jest.fn();
    mockedUseMemorySearch.mockReturnValue(searchState({ hasCriteria: true, isError: true, refetch }));
    rerender(
      <SafeAreaProvider initialMetrics={{ frame: { height: 844, width: 390, x: 0, y: 0 }, insets: { bottom: BOTTOM_INSET, left: 0, right: 0, top: 32 } }}>
        <MemorySearchScreen />
      </SafeAreaProvider>,
    );
    fireEvent.press(within(getByTestId('memory-search-error')).getByText('Try again'));
    expect(refetch).toHaveBeenCalled();
  });

  it('loads the next page at the end of the list', () => {
    const fetchNextPage = jest.fn();
    mockedUseMemorySearch.mockReturnValue(searchState({
      hasCriteria: true,
      hasNextPage: true,
      fetchNextPage,
      hits: [{ memory: memory({ id: 'memory-1', content: 'x' }), matchedIn: 'text' }],
    }));
    const { getByTestId } = renderScreen();

    fireEvent(getByTestId('memory-search-results'), 'onEndReached');

    expect(fetchNextPage).toHaveBeenCalledTimes(1);
  });

  it('clears the text and closes with Cancel', () => {
    const { getByTestId, queryByTestId } = renderScreen();
    fireEvent.changeText(getByTestId('memory-search-input'), 'mara');
    fireEvent.press(getByTestId('memory-search-clear'));
    expect(getByTestId('memory-search-input').props.value).toBe('');
    expect(queryByTestId('memory-search-clear')).toBeNull();

    fireEvent.press(getByTestId('memory-search-cancel'));
    expect(router.back).toHaveBeenCalled();
  });

  describe('keyboard and safe area (docs/TESTING.md contract)', () => {
    function listBottomPadding(getByTestId: ReturnType<typeof renderScreen>['getByTestId']) {
      return StyleSheet.flatten(getByTestId('memory-search-results').props.contentContainerStyle).paddingBottom;
    }

    it('uses one padding-based avoider for the results, below an always-visible field', () => {
      const { getByTestId } = renderScreen();
      expect(getByTestId('memory-search-keyboard-avoider').props.behavior).toBe('padding');
      expect(getByTestId('memory-search-results').props.keyboardShouldPersistTaps).toBe('handled');
      expect(getByTestId('memory-search-results').props.keyboardDismissMode).toBe('on-drag');
    });

    it('clears the navigation bar with the keyboard closed', () => {
      const { getByTestId } = renderScreen();
      expect(listBottomPadding(getByTestId)).toBe(BOTTOM_INSET + spacing.lg);
    });

    it('does not add the navigation-bar inset again with the keyboard open', () => {
      mockedUseKeyboardState.mockImplementation((selector?: (state: { isVisible: boolean }) => unknown) =>
        (selector ? selector({ isVisible: true }) : { isVisible: true }));
      const { getByTestId } = renderScreen();
      expect(listBottomPadding(getByTestId)).toBe(spacing.lg);
    });
  });
});
