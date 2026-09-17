import { act, renderHook, waitFor } from '@testing-library/react-native';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';

import { useMemoryBooks } from '@/hooks/useMemoryBooks';
import { useAuth } from '@/hooks/use-auth';
import {
  countEligibleMemoriesForScope,
  createMemoryBook,
  dispatchMemoryBookGeneration,
  fetchExampleCoverAssetKey,
  fetchMemoryBooksForChild,
  type MemoryBookListRow,
} from '@/services/memory-books';

jest.mock('@/hooks/use-auth', () => ({ useAuth: jest.fn() }));

jest.mock('@/services/memory-books', () => ({
  fetchMemoryBooksForChild: jest.fn(),
  createMemoryBook: jest.fn(),
  dispatchMemoryBookGeneration: jest.fn(),
  countEligibleMemoriesForScope: jest.fn(),
  fetchExampleCoverAssetKey: jest.fn(),
}));

const mockedUseAuth = useAuth as jest.MockedFunction<typeof useAuth>;
const mockedFetch = fetchMemoryBooksForChild as jest.MockedFunction<typeof fetchMemoryBooksForChild>;
const mockedCreate = createMemoryBook as jest.MockedFunction<typeof createMemoryBook>;
const mockedDispatch = dispatchMemoryBookGeneration as jest.MockedFunction<typeof dispatchMemoryBookGeneration>;
const mockedCount = countEligibleMemoriesForScope as jest.MockedFunction<typeof countEligibleMemoriesForScope>;
const mockedExampleCover = fetchExampleCoverAssetKey as jest.MockedFunction<typeof fetchExampleCoverAssetKey>;

function createWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { gcTime: Infinity, retry: false },
      mutations: { gcTime: Infinity, retry: false },
    },
  });
  return function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
  };
}

function book(overrides: Partial<MemoryBookListRow> = {}): MemoryBookListRow {
  return {
    id: 'book-1',
    family_id: 'family-1',
    child_id: 'child-1',
    status: 'queued',
    scope_kind: 'age_year',
    scope_start_date: '2023-06-01',
    scope_end_date: '2024-05-31',
    scope_label: 'Year One',
    failure_reason: null,
    cover_asset_key: null,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('useMemoryBooks', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockedUseAuth.mockReturnValue({ user: { id: 'user-1' } } as ReturnType<typeof useAuth>);
    mockedFetch.mockResolvedValue({ data: [], error: null });
    mockedCount.mockResolvedValue({ data: 40, error: null });
    mockedExampleCover.mockResolvedValue({ data: null, error: null });
  });

  it('merges scope options with eligibility counts once both queries settle', async () => {
    const { result } = renderHook(
      () => useMemoryBooks({ familyId: 'family-1', childId: 'child-1', dateOfBirth: '2023-06-01' }),
      { wrapper: createWrapper() },
    );

    await waitFor(() => expect(result.current.isLoading).toBe(false));
    await waitFor(() => expect(result.current.isEligibilityLoading).toBe(false));

    expect(result.current.rows.length).toBeGreaterThan(0);
    expect(result.current.rows.every((row) => row.status === 'available')).toBe(true);
    expect(result.current.rows.every((row) => row.eligibleCount === 40)).toBe(true);
    expect(result.current.rows.at(-1)!.option.kind).toBe('everything');
  });

  it('marks a scope thin below the threshold, with the locked copy shape', async () => {
    mockedCount.mockResolvedValue({ data: 12, error: null });

    const { result } = renderHook(
      () => useMemoryBooks({ familyId: 'family-1', childId: 'child-1', dateOfBirth: '2023-06-01' }),
      { wrapper: createWrapper() },
    );

    await waitFor(() => expect(result.current.isEligibilityLoading).toBe(false));

    const yearOne = result.current.rows.find((row) => row.option.label === 'Year One')!;
    expect(yearOne.status).toBe('thin');
    expect(yearOne.disabledReason).toBe('12 memories in this period — books need about 30');
  });

  it('surfaces an existing row instead of offering generation for that scope', async () => {
    mockedFetch.mockResolvedValue({ data: [book({ status: 'generating' })], error: null });

    const { result } = renderHook(
      () => useMemoryBooks({ familyId: 'family-1', childId: 'child-1', dateOfBirth: '2023-06-01' }),
      { wrapper: createWrapper() },
    );

    await waitFor(() => expect(result.current.isLoading).toBe(false));

    const yearOne = result.current.rows.find((row) => row.option.label === 'Year One')!;
    expect(yearOne.status).toBe('in_progress');
    expect(yearOne.book?.id).toBe('book-1');
  });

  it('creates a fresh queued row and dispatches generation on generate()', async () => {
    mockedCreate.mockResolvedValue({ data: book({ id: 'new-book' }), error: null, conflict: false });
    mockedDispatch.mockResolvedValue({ data: { success: true, status: 'generating' }, error: null });

    const { result } = renderHook(
      () => useMemoryBooks({ familyId: 'family-1', childId: 'child-1', dateOfBirth: '2023-06-01' }),
      { wrapper: createWrapper() },
    );
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    const yearOne = result.current.rows.find((row) => row.option.label === 'Year One')!;
    await act(async () => { await result.current.generate(yearOne.option); });

    expect(mockedCreate).toHaveBeenCalledWith(expect.objectContaining({
      familyId: 'family-1',
      childId: 'child-1',
      requestedBy: 'user-1',
      scopeKind: 'age_year',
      scopeLabel: 'Year One',
    }));
    expect(mockedDispatch).toHaveBeenCalledWith('new-book');
  });

  it('recovers from a 23505 conflict by refetching instead of surfacing an error', async () => {
    mockedCreate.mockResolvedValue({ data: null, error: { message: 'duplicate', code: '23505' }, conflict: true });

    const { result } = renderHook(
      () => useMemoryBooks({ familyId: 'family-1', childId: 'child-1', dateOfBirth: '2023-06-01' }),
      { wrapper: createWrapper() },
    );
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    const yearOne = result.current.rows.find((row) => row.option.label === 'Year One')!;
    await act(async () => { await result.current.generate(yearOne.option); });

    expect(mockedDispatch).not.toHaveBeenCalled();
    const afterYearOne = result.current.rows.find((row) => row.option.label === 'Year One')!;
    expect(afterYearOne.dispatchError).toBeNull();
    // Refetch happened -- fetchMemoryBooksForChild called again beyond the
    // initial mount fetch.
    expect(mockedFetch.mock.calls.length).toBeGreaterThan(1);
  });

  it('surfaces a transient dispatch error without touching the queued row, and clears it on retryDispatch', async () => {
    mockedCreate.mockResolvedValue({ data: book({ id: 'new-book' }), error: null, conflict: false });
    // Simulate the server: once the insert lands, the list refetch picks
    // up the new queued row regardless of whether dispatch itself succeeds.
    mockedFetch.mockResolvedValue({ data: [book({ id: 'new-book', status: 'queued' })], error: null });
    mockedDispatch
      .mockResolvedValueOnce({ data: null, error: { message: 'Something went wrong. Please try again.', code: '500' } })
      .mockResolvedValueOnce({ data: { success: true, status: 'generating' }, error: null });

    const { result } = renderHook(
      () => useMemoryBooks({ familyId: 'family-1', childId: 'child-1', dateOfBirth: '2023-06-01' }),
      { wrapper: createWrapper() },
    );
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    const yearOne = result.current.rows.find((row) => row.option.label === 'Year One')!;
    await act(async () => { await result.current.generate(yearOne.option); });

    const afterFailure = result.current.rows.find((row) => row.option.label === 'Year One')!;
    expect(afterFailure.dispatchError).toBe('Something went wrong. Please try again.');
    // The DB row exists and is queued -- still shown as progress, not an
    // error wall over the whole scope.
    expect(afterFailure.status).toBe('in_progress');

    await act(async () => { await result.current.retryDispatch(yearOne.option, 'new-book'); });

    expect(mockedDispatch).toHaveBeenCalledTimes(2);
    const afterRetry = result.current.rows.find((row) => row.option.label === 'Year One')!;
    expect(afterRetry.dispatchError).toBeNull();
  });

  it('retries a failed scope by inserting a fresh row, leaving the failed row as history', async () => {
    mockedFetch.mockResolvedValue({
      data: [book({ id: 'old-failed', status: 'failed', failure_reason: 'boom' })],
      error: null,
    });
    mockedCreate.mockResolvedValue({ data: book({ id: 'retry-book', status: 'queued' }), error: null, conflict: false });
    mockedDispatch.mockResolvedValue({ data: { success: true, status: 'generating' }, error: null });

    const { result } = renderHook(
      () => useMemoryBooks({ familyId: 'family-1', childId: 'child-1', dateOfBirth: '2023-06-01' }),
      { wrapper: createWrapper() },
    );
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    const yearOne = result.current.rows.find((row) => row.option.label === 'Year One')!;
    expect(yearOne.status).toBe('failed');

    await act(async () => { await result.current.generate(yearOne.option); });

    expect(mockedCreate).toHaveBeenCalledTimes(1);
    expect(mockedDispatch).toHaveBeenCalledWith('retry-book');
  });

  it('surfaces the example cover asset key once it resolves', async () => {
    mockedExampleCover.mockResolvedValue({ data: 'preview-key-1', error: null });

    const { result } = renderHook(
      () => useMemoryBooks({ familyId: 'family-1', childId: 'child-1', dateOfBirth: '2023-06-01' }),
      { wrapper: createWrapper() },
    );

    await waitFor(() => expect(result.current.exampleCoverAssetKey).toBe('preview-key-1'));
    expect(mockedExampleCover).toHaveBeenCalledWith('family-1', 'child-1');
  });

  it('defaults exampleCoverAssetKey to null when there is no eligible photo', async () => {
    const { result } = renderHook(
      () => useMemoryBooks({ familyId: 'family-1', childId: 'child-1', dateOfBirth: '2023-06-01' }),
      { wrapper: createWrapper() },
    );

    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.exampleCoverAssetKey).toBeNull();
  });
});
