import { render } from '@testing-library/react-native';
import { getSharedPayloads } from 'expo-sharing';
import { usePathname, useRouter, useSegments } from 'expo-router';
import { AppState } from 'react-native';

import { IncomingShareRouter } from './incoming-share-router';
import { useAuth } from '@/hooks/use-auth';
import { useFamily } from '@/hooks/use-family';
import { newMemoryRoute } from '@/lib/routes';

jest.mock('expo-sharing', () => ({ getSharedPayloads: jest.fn() }));
jest.mock('expo-router', () => ({
  usePathname: jest.fn(),
  useRouter: jest.fn(),
  useSegments: jest.fn(),
}));
jest.mock('@/hooks/use-auth', () => ({ useAuth: jest.fn() }));
jest.mock('@/hooks/use-family', () => ({ useFamily: jest.fn() }));

const mockGetSharedPayloads = getSharedPayloads as jest.MockedFunction<typeof getSharedPayloads>;
const mockUsePathname = usePathname as jest.MockedFunction<typeof usePathname>;
const mockUseRouter = useRouter as jest.MockedFunction<typeof useRouter>;
const mockUseSegments = useSegments as jest.MockedFunction<typeof useSegments>;
const mockUseAuth = useAuth as jest.MockedFunction<typeof useAuth>;
const mockUseFamily = useFamily as jest.MockedFunction<typeof useFamily>;
const push = jest.fn();

beforeEach(() => {
  jest.clearAllMocks();
  mockUseRouter.mockReturnValue({ push } as unknown as ReturnType<typeof useRouter>);
  mockUsePathname.mockReturnValue('/timeline');
  mockUseSegments.mockReturnValue(['(app)', '(tabs)', 'timeline'] as ReturnType<typeof useSegments>);
  mockUseAuth.mockReturnValue({
    session: { user: { id: 'user-1' } },
    isLoading: false,
  } as ReturnType<typeof useAuth>);
  mockUseFamily.mockReturnValue({
    familyId: 'family-1',
    role: 'owner',
    isLoading: false,
  } as ReturnType<typeof useFamily>);
  mockGetSharedPayloads.mockReturnValue([
    { value: 'file:///shared.jpg', shareType: 'image', mimeType: 'image/jpeg' },
  ]);
});

it('opens the composer when a cold-start share remains after timeline routing settles', () => {
  render(<IncomingShareRouter />);

  expect(push).toHaveBeenCalledWith(newMemoryRoute);
});

it('waits at the root path so it cannot race the initial timeline redirect', () => {
  mockUsePathname.mockReturnValue('/');
  mockUseSegments.mockReturnValue([]);

  render(<IncomingShareRouter />);

  expect(push).not.toHaveBeenCalled();
});

it('does not open the composer for a viewer', () => {
  mockUseFamily.mockReturnValue({
    familyId: 'family-1',
    role: 'viewer',
    isLoading: false,
  } as ReturnType<typeof useFamily>);

  render(<IncomingShareRouter />);

  expect(push).not.toHaveBeenCalled();
});

it('rechecks pending payloads when the app returns to the foreground', () => {
  let handleAppStateChange: ((status: 'active' | 'background') => void) | undefined;
  jest.spyOn(AppState, 'addEventListener').mockImplementation((_event, listener) => {
    handleAppStateChange = listener as (status: 'active' | 'background') => void;
    return { remove: jest.fn() };
  });
  mockGetSharedPayloads.mockReturnValueOnce([]).mockReturnValue([
    { value: 'file:///shared.jpg', shareType: 'image', mimeType: 'image/jpeg' },
  ]);

  render(<IncomingShareRouter />);
  expect(push).not.toHaveBeenCalled();

  handleAppStateChange?.('active');
  expect(push).toHaveBeenCalledWith(newMemoryRoute);
});
