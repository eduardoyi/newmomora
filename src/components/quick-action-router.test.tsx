import { act, render } from '@testing-library/react-native';
import { usePathname, useRouter, useSegments } from 'expo-router';
import * as QuickActions from 'expo-quick-actions';

import { QuickActionRouter, QUICK_ACTION_PENDING_TTL_MS } from '@/components/quick-action-router';
import { useAuth } from '@/hooks/use-auth';
import { useFamily } from '@/hooks/use-family';
import {
  getQuickActionsModule,
  QUICK_ACTION_DEDUPE_MS,
  resetQuickActionsForTests,
  setQuickActionsEnabled,
  SHORTCUTS,
  subscribeToQuickActions,
} from '@/services/quick-actions';

jest.mock('expo-router', () => ({
  usePathname: jest.fn(),
  useRouter: jest.fn(),
  useSegments: jest.fn(),
}));
jest.mock('@/hooks/use-auth', () => ({ useAuth: jest.fn() }));
jest.mock('@/hooks/use-family', () => ({ useFamily: jest.fn() }));

// Test hooks added by __mocks__/expo-quick-actions.ts.
const qa = QuickActions as unknown as typeof QuickActions & {
  __setInitial: (action?: { id: string; title: string }) => void;
  __triggerQuickAction: (action: { id: string; title: string }) => void;
  __resetQuickActionsMock: () => void;
};

const mockPush = jest.fn();
const mockSetParams = jest.fn();
const voice = { id: 'record-audio', title: 'Record audio' };
const photo = { id: 'take-photo', title: 'Take a photo' };

function setState({
  session = { user: { id: 'u1', is_anonymous: false } } as unknown,
  isAuthLoading = false,
  familyId = 'f1',
  role = 'owner',
  isFamilyLoading = false,
  pathname = '/timeline',
  segments = ['(app)', '(tabs)', 'timeline'],
}: Partial<{
  session: unknown;
  isAuthLoading: boolean;
  familyId: string | null;
  role: string | null;
  isFamilyLoading: boolean;
  pathname: string;
  segments: string[];
}> = {}) {
  (useAuth as jest.Mock).mockReturnValue({ session, isLoading: isAuthLoading });
  (useFamily as jest.Mock).mockReturnValue({ familyId, role, isLoading: isFamilyLoading });
  (usePathname as jest.Mock).mockReturnValue(pathname);
  (useSegments as jest.Mock).mockReturnValue(segments);
}

const lastItems = () => {
  const calls = qa.setItems.mock.calls;
  return calls[calls.length - 1]?.[0] as { id: string; icon?: string }[] | undefined;
};

describe('QuickActionRouter', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.clearAllMocks();
    qa.__resetQuickActionsMock();
    resetQuickActionsForTests();
    (useRouter as jest.Mock).mockReturnValue({ push: mockPush, setParams: mockSetParams });
    setState();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('publishes the four shortcuts for a signed-in editor', async () => {
    render(<QuickActionRouter />);
    await act(async () => {});

    expect(lastItems()?.map((item) => item.id)).toEqual(SHORTCUTS.map((shortcut) => shortcut.id));
    expect(SHORTCUTS).toHaveLength(4);
  });

  it.each([
    ['signed out', { session: null }],
    ['anonymous', { session: { user: { id: 'a', is_anonymous: true } } }],
    ['no family', { familyId: null, role: null }],
    ['viewer', { role: 'viewer' }],
  ])('clears the shortcuts when %s', async (_label, state) => {
    setState(state);
    render(<QuickActionRouter />);
    await act(async () => {});

    expect(lastItems()).toEqual([]);
  });

  it('clears the shortcuts on sign-out', async () => {
    const screen = render(<QuickActionRouter />);
    await act(async () => {});
    expect(lastItems()).toHaveLength(4);

    setState({ session: null });
    screen.rerender(<QuickActionRouter />);
    await act(async () => {});
    expect(lastItems()).toEqual([]);
  });

  it('does not touch the shortcuts while auth or family is loading', async () => {
    setState({ isAuthLoading: true, session: null });
    render(<QuickActionRouter />);
    await act(async () => {});
    expect(qa.setItems).not.toHaveBeenCalled();
  });

  it('pushes the composer for a warm-start shortcut', async () => {
    render(<QuickActionRouter />);
    await act(async () => {});

    act(() => qa.__triggerQuickAction(voice));

    expect(mockPush).toHaveBeenCalledTimes(1);
    const route = mockPush.mock.calls[0][0] as { pathname: string; params: Record<string, string> };
    expect(route.pathname).toBe('/(app)/new-memory');
    expect(route.params).toMatchObject({ action: 'voice', source: 'shortcut_voice' });
    expect(route.params.actionId).toEqual(expect.any(String));
    expect(mockSetParams).not.toHaveBeenCalled();
  });

  it('generates a fresh actionId per trigger', async () => {
    render(<QuickActionRouter />);
    await act(async () => {});

    act(() => qa.__triggerQuickAction(voice));
    act(() => qa.__triggerQuickAction(photo));

    const ids = mockPush.mock.calls.map((call) => (call[0] as { params: { actionId: string } }).params.actionId);
    expect(ids).toHaveLength(2);
    expect(ids[0]).not.toBe(ids[1]);
  });

  it('sets params on the open composer instead of pushing a second one', async () => {
    setState({ pathname: '/new-memory', segments: ['(app)', 'new-memory'] });
    render(<QuickActionRouter />);
    await act(async () => {});

    act(() => qa.__triggerQuickAction(photo));

    expect(mockPush).not.toHaveBeenCalled();
    expect(mockSetParams).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'photo', source: 'shortcut_photo', actionId: expect.any(String) }),
    );
  });

  it('holds a cold-start shortcut until auth and family settle', async () => {
    qa.__setInitial(voice);
    setState({ isAuthLoading: true, session: null, isFamilyLoading: true, segments: [] });
    const screen = render(<QuickActionRouter />);
    await act(async () => {});
    expect(mockPush).not.toHaveBeenCalled();

    setState({ segments: [] });
    screen.rerender(<QuickActionRouter />);
    await act(async () => {});
    // Signed in but routing has not reached the app screens yet.
    expect(mockPush).not.toHaveBeenCalled();

    setState();
    screen.rerender(<QuickActionRouter />);
    await act(async () => {});
    expect(mockPush).toHaveBeenCalledTimes(1);
  });

  it('delivers the cold-start shortcut only once across remounts', async () => {
    qa.__setInitial(voice);
    const first = render(<QuickActionRouter />);
    await act(async () => {});
    expect(mockPush).toHaveBeenCalledTimes(1);
    first.unmount();

    render(<QuickActionRouter />);
    await act(async () => {});
    expect(mockPush).toHaveBeenCalledTimes(1);
  });

  it('drops a shortcut when signed out and does not replay it after sign-in', async () => {
    qa.__setInitial(voice);
    setState({ session: null, segments: ['(auth)'] });
    const screen = render(<QuickActionRouter />);
    await act(async () => {});
    expect(mockPush).not.toHaveBeenCalled();

    setState();
    screen.rerender(<QuickActionRouter />);
    await act(async () => {});
    expect(mockPush).not.toHaveBeenCalled();
  });

  it('drops a shortcut for a viewer', async () => {
    qa.__setInitial(voice);
    setState({ role: 'viewer' });
    const screen = render(<QuickActionRouter />);
    await act(async () => {});

    setState({ role: 'owner' });
    screen.rerender(<QuickActionRouter />);
    await act(async () => {});
    expect(mockPush).not.toHaveBeenCalled();
    expect(mockSetParams).not.toHaveBeenCalled();
  });

  it('drops a shortcut that never reaches the app screens', async () => {
    setState({ segments: ['(onboarding)'] });
    const screen = render(<QuickActionRouter />);
    await act(async () => {});
    act(() => qa.__triggerQuickAction(voice));

    act(() => {
      jest.advanceTimersByTime(QUICK_ACTION_PENDING_TTL_MS + 1);
    });
    setState();
    screen.rerender(<QuickActionRouter />);
    await act(async () => {});
    expect(mockPush).not.toHaveBeenCalled();
  });

  it('consumes an event emitted while no router is mounted (activity recreation gap)', async () => {
    const first = render(<QuickActionRouter />);
    await act(async () => {});
    first.unmount();

    act(() => qa.__triggerQuickAction(voice));
    expect(mockPush).not.toHaveBeenCalled();

    render(<QuickActionRouter />);
    await act(async () => {});
    expect(mockPush).toHaveBeenCalledTimes(1);
    expect((mockPush.mock.calls[0][0] as { params: { action: string } }).params.action).toBe('voice');
  });

  it('drops a buffered action older than the TTL when a router mounts', async () => {
    const first = render(<QuickActionRouter />);
    await act(async () => {});
    first.unmount();
    act(() => qa.__triggerQuickAction(voice));

    act(() => {
      jest.advanceTimersByTime(QUICK_ACTION_PENDING_TTL_MS + 1);
    });
    render(<QuickActionRouter />);
    await act(async () => {});
    expect(mockPush).not.toHaveBeenCalled();
  });

  it('turns the cold-start initial plus an immediate duplicate event into one navigation', async () => {
    qa.__setInitial(voice);
    render(<QuickActionRouter />);
    await act(async () => {});
    act(() => qa.__triggerQuickAction(voice));
    await act(async () => {});

    expect(mockPush).toHaveBeenCalledTimes(1);
  });

  it('navigates for distinct taps more than the dedupe window apart', async () => {
    render(<QuickActionRouter />);
    await act(async () => {});

    act(() => qa.__triggerQuickAction(voice));
    act(() => {
      jest.advanceTimersByTime(QUICK_ACTION_DEDUPE_MS + 1);
    });
    act(() => qa.__triggerQuickAction(voice));

    expect(mockPush).toHaveBeenCalledTimes(2);
  });

  it('keeps the native listener when a router unmounts', async () => {
    const first = render(<QuickActionRouter />);
    await act(async () => {});
    first.unmount();

    // Still attached: the event is buffered rather than lost.
    act(() => qa.__triggerQuickAction(photo));
    render(<QuickActionRouter />);
    await act(async () => {});
    expect(mockPush).toHaveBeenCalledTimes(1);
  });

  it('ignores unknown shortcut ids', async () => {
    render(<QuickActionRouter />);
    await act(async () => {});
    act(() => qa.__triggerQuickAction({ id: 'something-else', title: 'x' }));
    expect(mockPush).not.toHaveBeenCalled();
  });
});

describe('quick-actions service on a binary without the native module', () => {
  beforeEach(() => {
    jest.resetModules();
    resetQuickActionsForTests();
  });

  afterEach(() => {
    jest.dontMock('expo-quick-actions');
  });

  it('loads nothing and no-ops instead of crashing', async () => {
    jest.doMock('expo-quick-actions', () => {
      throw new Error('Cannot find native module ExpoQuickActions');
    });
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const service = require('@/services/quick-actions') as typeof import('@/services/quick-actions');
    service.resetQuickActionsForTests();

    expect(service.getQuickActionsModule()).toBeNull();
    await expect(service.setQuickActionsEnabled(true)).resolves.toBeUndefined();
    const listener = jest.fn();
    const unsubscribe = service.subscribeToQuickActions(listener);
    expect(() => unsubscribe()).not.toThrow();
    expect(listener).not.toHaveBeenCalled();
  });

  it('is reachable normally when the module exists', () => {
    expect(getQuickActionsModule()).not.toBeNull();
    expect(typeof subscribeToQuickActions).toBe('function');
    expect(typeof setQuickActionsEnabled).toBe('function');
  });
});
