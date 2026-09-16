import { act, render, waitFor } from '@testing-library/react-native';

import WidgetEntryRoute from '../../app/widget';

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

beforeEach(() => {
  jest.clearAllMocks();
  mockUser = { id: 'account-a', is_anonymous: false };
  mockFamilyId = 'family-a';
  mockMemberships = [{ familyId: 'family-a' }, { familyId: 'family-b' }];
  mockParams = { memoryId: 'memory-a', familyId: 'family-a' };
  mockFetch.mockResolvedValue({ data: [{ id: 'memory-a' }], error: null });
  mockSetActiveFamily.mockResolvedValue(undefined);
});

it('opens a validated same-family memory', async () => {
  render(<WidgetEntryRoute />);
  await waitFor(() => expect(mockReplace).toHaveBeenCalledWith('/(app)/memory/memory-a'));
  expect(mockFetch).toHaveBeenCalledWith('family-a', ['memory-a']);
});

it('rejects a family the account does not belong to before fetching content', async () => {
  mockParams.familyId = 'family-forbidden';
  render(<WidgetEntryRoute />);
  await waitFor(() => expect(mockReplace).toHaveBeenCalledWith('/(app)/(tabs)/timeline'));
  expect(mockFetch).not.toHaveBeenCalled();
  expect(mockSetActiveFamily).not.toHaveBeenCalled();
});

it('does not replay a target while signed out', async () => {
  mockUser = null;
  render(<WidgetEntryRoute />);
  await waitFor(() => expect(mockReplace).toHaveBeenCalledWith('/(auth)/login'));
  expect(mockFetch).not.toHaveBeenCalled();
});

it('completes a cross-family tap when switching families rerenders the route', async () => {
  mockParams.familyId = 'family-b';
  let finishSwitch!: () => void;
  mockSetActiveFamily.mockImplementation(() => new Promise<void>((resolve) => { finishSwitch = resolve; }));
  const screen = render(<WidgetEntryRoute />);
  await waitFor(() => expect(mockSetActiveFamily).toHaveBeenCalledWith('family-b'));
  await act(async () => {
    mockFamilyId = 'family-b';
    screen.rerender(<WidgetEntryRoute />);
  });
  await act(async () => { finishSwitch(); });
  await waitFor(() => expect(mockReplace).toHaveBeenCalledWith('/(app)/memory/memory-a'));
});

it('does not navigate to a late memory response after account replacement', async () => {
  let finishFetch!: (value: unknown) => void;
  mockFetch.mockImplementation(() => new Promise((resolve) => { finishFetch = resolve; }));
  const screen = render(<WidgetEntryRoute />);
  await waitFor(() => expect(mockFetch).toHaveBeenCalled());
  await act(async () => {
    mockUser = { id: 'account-b', is_anonymous: false };
    screen.rerender(<WidgetEntryRoute />);
  });
  await act(async () => { finishFetch({ data: [{ id: 'memory-a' }], error: null }); });
  expect(mockReplace).not.toHaveBeenCalledWith('/(app)/memory/memory-a');
});
