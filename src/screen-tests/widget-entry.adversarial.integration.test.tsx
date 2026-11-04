import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, render, waitFor } from '@testing-library/react-native';
import type { ReactElement } from 'react';

import WidgetEntryRoute from '../../app/widget';
import { memoryDetailQueryKey } from '@/hooks/queryKeys';

const mockReplace = jest.fn();
const mockFetch = jest.fn();
const mockSetActiveFamily = jest.fn();
let mockParams: Record<string, string>;
let mockUser: { id: string; is_anonymous: boolean } | null;
let mockFamilyId: string | null;
let mockMemberships: { familyId: string }[];
const mockSession = { access_token: 'synthetic-test-session' };

jest.mock('expo-router', () => ({
  router: { replace: (...args: unknown[]) => mockReplace(...args) },
  useLocalSearchParams: () => mockParams,
}));
jest.mock('@/hooks/use-auth', () => ({
  useAuth: () => ({ user: mockUser, session: mockUser ? mockSession : null, isLoading: false }),
}));
jest.mock('@/hooks/use-family', () => ({
  useFamily: () => ({
    familyId: mockFamilyId,
    memberships: mockMemberships,
    isLoading: false,
    setActiveFamily: mockSetActiveFamily,
  }),
}));
jest.mock('@/services/widget-memories', () => ({
  fetchWidgetRetainedMemoriesByIds: (...args: unknown[]) => mockFetch(...args),
}));

let queryClient: QueryClient;

// Every render goes through the same client so cache assertions see what the
// route wrote.
function renderRoute(screen?: ReturnType<typeof render>) {
  const tree: ReactElement = (
    <QueryClientProvider client={queryClient}>
      <WidgetEntryRoute />
    </QueryClientProvider>
  );
  if (screen) {
    screen.rerender(tree);
    return screen;
  }
  return render(tree);
}

beforeEach(() => {
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  jest.clearAllMocks();
  mockUser = { id: 'account-a', is_anonymous: false };
  mockFamilyId = 'family-a';
  mockMemberships = [{ familyId: 'family-a' }, { familyId: 'family-b' }];
  mockParams = { memoryId: 'memory-a', familyId: 'family-a' };
  mockFetch.mockResolvedValue({ data: [{ id: 'memory-a', family_id: 'family-a' }], error: null });
  mockSetActiveFamily.mockResolvedValue(undefined);
});

it('opens a validated same-family memory', async () => {
  renderRoute();
  await waitFor(() => expect(mockReplace).toHaveBeenCalledWith('/(app)/memory/memory-a'));
  expect(mockFetch).toHaveBeenCalledWith('family-a', ['memory-a']);
});

it('rejects a family the account does not belong to before fetching content', async () => {
  mockParams.familyId = 'family-forbidden';
  renderRoute();
  await waitFor(() => expect(mockReplace).toHaveBeenCalledWith('/(app)/(tabs)/timeline'));
  expect(mockFetch).not.toHaveBeenCalled();
  expect(mockSetActiveFamily).not.toHaveBeenCalled();
});

it('does not replay a target while signed out', async () => {
  mockUser = null;
  renderRoute();
  await waitFor(() => expect(mockReplace).toHaveBeenCalledWith('/(auth)/login'));
  expect(mockFetch).not.toHaveBeenCalled();
});

it('completes a cross-family tap when switching families rerenders the route', async () => {
  mockParams.familyId = 'family-b';
  let finishSwitch!: () => void;
  mockSetActiveFamily.mockImplementation(() => new Promise<void>((resolve) => { finishSwitch = resolve; }));
  const screen = renderRoute();
  await waitFor(() => expect(mockSetActiveFamily).toHaveBeenCalledWith('family-b'));
  await act(async () => {
    mockFamilyId = 'family-b';
    renderRoute(screen);
  });
  await act(async () => { finishSwitch(); });
  await waitFor(() => expect(mockReplace).toHaveBeenCalledWith('/(app)/memory/memory-a'));
});

it('does not navigate to a late memory response after account replacement', async () => {
  let finishFetch!: (value: unknown) => void;
  mockFetch.mockImplementation(() => new Promise((resolve) => { finishFetch = resolve; }));
  const screen = renderRoute();
  await waitFor(() => expect(mockFetch).toHaveBeenCalled());
  await act(async () => {
    mockUser = { id: 'account-b', is_anonymous: false };
    renderRoute(screen);
  });
  await act(async () => { finishFetch({ data: [{ id: 'memory-a', family_id: 'family-a' }], error: null }); });
  expect(mockReplace).not.toHaveBeenCalledWith('/(app)/memory/memory-a');
});

it('seeds the detail query with the validated memory so the detail screen does not refetch it', async () => {
  const validated = { id: 'memory-a', family_id: 'family-a', content: 'validated row' };
  mockFetch.mockResolvedValue({ data: [validated], error: null });
  renderRoute();
  await waitFor(() => expect(mockReplace).toHaveBeenCalledWith('/(app)/memory/memory-a'));
  // Same key useMemory reads: [memories, familyId, 'detail', memoryId].
  expect(queryClient.getQueryData(memoryDetailQueryKey('family-a', 'memory-a'))).toBe(validated);
});

describe('validation retries', () => {
  beforeEach(() => { jest.useFakeTimers(); });
  afterEach(() => { jest.useRealTimers(); });

  it('does not seed the detail cache when validation keeps finding nothing', async () => {
    mockFetch.mockResolvedValue({ data: [], error: null, failure: null });
    renderRoute();
    // Fake timers: waitFor advances them, so allow the full retry window.
    await waitFor(() => expect(mockReplace).toHaveBeenCalledWith('/(app)/(tabs)/timeline'), { timeout: 5000 });
    // First read plus both retries before giving up.
    expect(mockFetch).toHaveBeenCalledTimes(3);
    expect(queryClient.getQueryData(memoryDetailQueryKey('family-a', 'memory-a'))).toBeUndefined();
  });

  it('opens the memory when a transient error on wake clears on retry', async () => {
    mockFetch
      .mockResolvedValueOnce({ data: null, error: { message: 'JWT expired', code: 'PGRST301' }, failure: 'unavailable' })
      .mockResolvedValue({ data: [{ id: 'memory-a', family_id: 'family-a' }], error: null, failure: null });
    renderRoute();
    await waitFor(() => expect(mockReplace).toHaveBeenCalledWith('/(app)/memory/memory-a'));
    expect(mockReplace).not.toHaveBeenCalledWith('/(app)/(tabs)/timeline');
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it('opens the memory when an empty read before the session refresh clears on retry', async () => {
    mockFetch
      .mockResolvedValueOnce({ data: [], error: null, failure: null })
      .mockResolvedValue({ data: [{ id: 'memory-a', family_id: 'family-a' }], error: null, failure: null });
    renderRoute();
    await waitFor(() => expect(mockReplace).toHaveBeenCalledWith('/(app)/memory/memory-a'));
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it('falls back immediately on an explicit membership denial', async () => {
    mockFetch.mockResolvedValue({ data: null, error: { message: 'denied', code: '42501' }, failure: 'authorization' });
    renderRoute();
    await waitFor(() => expect(mockReplace).toHaveBeenCalledWith('/(app)/(tabs)/timeline'));
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('stops retrying after the account changes', async () => {
    mockFetch.mockResolvedValue({ data: [], error: null, failure: null });
    const screen = renderRoute();
    await waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(1));
    await act(async () => {
      mockUser = { id: 'account-b', is_anonymous: false };
      renderRoute(screen);
    });
    await act(async () => { jest.advanceTimersByTime(5000); });
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(mockReplace).not.toHaveBeenCalledWith('/(app)/memory/memory-a');
  });
});

it('opens immediately from a cached detail entry without the validation fetch', async () => {
  queryClient.setQueryData(
    memoryDetailQueryKey('family-a', 'memory-a'),
    { id: 'memory-a', family_id: 'family-a' },
  );
  renderRoute();
  await waitFor(() => expect(mockReplace).toHaveBeenCalledWith('/(app)/memory/memory-a'));
  expect(mockFetch).not.toHaveBeenCalled();
});

it('still requires current membership before using a cached detail entry', async () => {
  queryClient.setQueryData(
    memoryDetailQueryKey('family-forbidden', 'memory-a'),
    { id: 'memory-a', family_id: 'family-forbidden' },
  );
  mockParams.familyId = 'family-forbidden';
  renderRoute();
  await waitFor(() => expect(mockReplace).toHaveBeenCalledWith('/(app)/(tabs)/timeline'));
  expect(mockReplace).not.toHaveBeenCalledWith('/(app)/memory/memory-a');
});

it('ignores a cached entry whose family_id disagrees with the target', async () => {
  // A cached row whose family_id disagrees with the widget target is not proof.
  queryClient.setQueryData(
    memoryDetailQueryKey('family-a', 'memory-a'),
    { id: 'memory-a', family_id: 'family-other' },
  );
  renderRoute();
  await waitFor(() => expect(mockFetch).toHaveBeenCalledWith('family-a', ['memory-a']));
});

it('starts the validation fetch in parallel with the family switch and seeds after both settle', async () => {
  mockParams.familyId = 'family-b';
  const validated = { id: 'memory-a', family_id: 'family-b' };
  mockFetch.mockResolvedValue({ data: [validated], error: null });
  let finishSwitch!: () => void;
  mockSetActiveFamily.mockImplementation(() => new Promise<void>((resolve) => { finishSwitch = resolve; }));
  renderRoute();
  // The fetch is issued while the family switch is still pending.
  await waitFor(() => expect(mockFetch).toHaveBeenCalledWith('family-b', ['memory-a']));
  expect(mockSetActiveFamily).toHaveBeenCalledWith('family-b');
  expect(mockReplace).not.toHaveBeenCalled();
  expect(queryClient.getQueryData(memoryDetailQueryKey('family-b', 'memory-a'))).toBeUndefined();
  await act(async () => { finishSwitch(); });
  await waitFor(() => expect(mockReplace).toHaveBeenCalledWith('/(app)/memory/memory-a'));
  expect(queryClient.getQueryData(memoryDetailQueryKey('family-b', 'memory-a'))).toBe(validated);
});

it('switches family before opening from the cached fast path', async () => {
  mockParams.familyId = 'family-b';
  queryClient.setQueryData(
    memoryDetailQueryKey('family-b', 'memory-a'),
    { id: 'memory-a', family_id: 'family-b' },
  );
  let finishSwitch!: () => void;
  mockSetActiveFamily.mockImplementation(() => new Promise<void>((resolve) => { finishSwitch = resolve; }));
  renderRoute();
  await waitFor(() => expect(mockSetActiveFamily).toHaveBeenCalledWith('family-b'));
  expect(mockReplace).not.toHaveBeenCalled();
  await act(async () => { finishSwitch(); });
  await waitFor(() => expect(mockReplace).toHaveBeenCalledWith('/(app)/memory/memory-a'));
  expect(mockFetch).not.toHaveBeenCalled();
});
