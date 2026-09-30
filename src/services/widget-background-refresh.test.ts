import {
  runWidgetBackgroundRefresh,
  type WidgetBackgroundRefreshDependencies,
} from './widget-background-refresh';
import {
  resetBackgroundTaskModulesForTests,
  setWidgetBackgroundRefreshEnabled,
  WIDGET_BACKGROUND_REFRESH_INTERVAL_MINUTES,
  WIDGET_BACKGROUND_REFRESH_TASK,
} from './widget-background-registration';
import type { WidgetManifest, WidgetNativeAdapter } from '@/widgets/types';

jest.mock('@/lib/supabase', () => ({ supabase: { auth: { getSession: jest.fn() } } }));
jest.mock('@/widgets/native-adapter', () => ({ momoraWidgetAdapter: null }));

const mockTaskManager = {
  isTaskRegisteredAsync: jest.fn(),
  isTaskDefined: jest.fn(() => false),
  defineTask: jest.fn(),
};
const mockBackgroundTask = {
  getStatusAsync: jest.fn(async () => 2),
  registerTaskAsync: jest.fn(async () => undefined),
  unregisterTaskAsync: jest.fn(async () => undefined),
  BackgroundTaskStatus: { Restricted: 1, Available: 2 },
  BackgroundTaskResult: { Success: 1, Failed: 2 },
};
jest.mock('expo-task-manager', () => mockTaskManager);
jest.mock('expo-background-task', () => mockBackgroundTask);

function cachedManifest(accountId = 'account-a', familyId = 'family-cached'): WidgetManifest {
  return {
    schemaVersion: 1,
    accountId,
    familyId,
    generationId: 'generation-a',
    verifiedAt: '2026-09-15T12:00:00.000Z',
    expiresAt: '2026-09-22T12:00:00.000Z',
    timezone: 'UTC',
    entries: [],
  };
}

function setup(overrides: {
  cached?: WidgetManifest | null;
  placed?: boolean | null;
  available?: boolean;
  appState?: string | null;
  user?: { id: string; is_anonymous?: boolean } | null;
  profile?: { active_family_id: string | null; deleted_at: string | null } | null;
  profileError?: boolean;
  syncResult?: { published: boolean; cleared: boolean; reason?: string };
} = {}) {
  const sync = jest.fn(async () => overrides.syncResult ?? { published: true, cleared: false });
  const clear = jest.fn(async () => undefined);
  const adapter: WidgetNativeAdapter = {
    available: () => overrides.available ?? true,
    readManifest: async () => (overrides.cached === undefined ? cachedManifest() : overrides.cached),
    publishManifest: async () => undefined,
    clearManifest: async () => undefined,
    reload: async () => undefined,
    hasPlacedWidgets: async () => (overrides.placed === undefined ? true : overrides.placed),
  };
  const dependencies: WidgetBackgroundRefreshDependencies = {
    adapter,
    getAppState: () => (overrides.appState === undefined ? 'background' : overrides.appState),
    getSessionUser: async () => (overrides.user === undefined ? { id: 'account-a' } : overrides.user),
    fetchProfile: async () => (overrides.profileError
      ? { data: null, error: { message: 'offline' } }
      : {
        data: overrides.profile === undefined
          ? { active_family_id: 'family-active', deleted_at: null }
          : overrides.profile,
        error: null,
      }),
    getCoordinator: () => ({ sync, clear }) as never,
  };
  return { dependencies, sync, clear };
}

describe('runWidgetBackgroundRefresh', () => {
  it('refreshes the profile active family for the signed-in account', async () => {
    const { dependencies, sync } = setup();
    await expect(runWidgetBackgroundRefresh(dependencies)).resolves.toBe('refreshed');
    expect(sync).toHaveBeenCalledWith({ accountId: 'account-a', familyId: 'family-active' });
  });

  it('recovers after the lease expired and no manifest is cached', async () => {
    const { dependencies, sync } = setup({ cached: null });
    await expect(runWidgetBackgroundRefresh(dependencies)).resolves.toBe('refreshed');
    expect(sync).toHaveBeenCalledWith({ accountId: 'account-a', familyId: 'family-active' });
  });

  it('falls back to the cached family when the profile has no active family', async () => {
    const { dependencies, sync } = setup({ profile: { active_family_id: null, deleted_at: null } });
    await runWidgetBackgroundRefresh(dependencies);
    expect(sync).toHaveBeenCalledWith({ accountId: 'account-a', familyId: 'family-cached' });
  });

  it('leaves work to the foreground provider while the app is active', async () => {
    const { dependencies, sync } = setup({ appState: 'active' });
    await expect(runWidgetBackgroundRefresh(dependencies)).resolves.toBe('skipped_foreground');
    expect(sync).not.toHaveBeenCalled();
  });

  it('skips network work when no widget is placed', async () => {
    const { dependencies, sync } = setup({ placed: false });
    await expect(runWidgetBackgroundRefresh(dependencies)).resolves.toBe('skipped_no_widget');
    expect(sync).not.toHaveBeenCalled();
  });

  it('treats an unknown placement (older binary) as placed', async () => {
    const { dependencies, sync } = setup({ placed: null });
    await expect(runWidgetBackgroundRefresh(dependencies)).resolves.toBe('refreshed');
    expect(sync).toHaveBeenCalled();
  });

  it('skips without clearing when no session is available', async () => {
    const { dependencies, sync, clear } = setup({ user: null });
    await expect(runWidgetBackgroundRefresh(dependencies)).resolves.toBe('skipped_signed_out');
    expect(sync).not.toHaveBeenCalled();
    expect(clear).not.toHaveBeenCalled();
  });

  it("clears a different account's cached card", async () => {
    const { dependencies, sync, clear } = setup({ user: { id: 'account-b' } });
    await expect(runWidgetBackgroundRefresh(dependencies)).resolves.toBe('cleared');
    expect(clear).toHaveBeenCalledWith({ accountId: 'account-a', familyId: 'family-cached' });
    expect(sync).not.toHaveBeenCalled();
  });

  it('clears the widget for a deleted account', async () => {
    const { dependencies, sync, clear } = setup({
      profile: { active_family_id: 'family-active', deleted_at: '2026-09-20T00:00:00Z' },
    });
    await expect(runWidgetBackgroundRefresh(dependencies)).resolves.toBe('cleared');
    expect(clear).toHaveBeenCalled();
    expect(sync).not.toHaveBeenCalled();
  });

  it('reports a failed profile read without syncing or clearing', async () => {
    const { dependencies, sync, clear } = setup({ profileError: true });
    await expect(runWidgetBackgroundRefresh(dependencies)).resolves.toBe('failed');
    expect(sync).not.toHaveBeenCalled();
    expect(clear).not.toHaveBeenCalled();
  });

  it('maps transient sync failures to failed', async () => {
    const { dependencies } = setup({
      syncResult: { published: false, cleared: false, reason: 'images_unavailable' },
    });
    await expect(runWidgetBackgroundRefresh(dependencies)).resolves.toBe('failed');
  });
});

describe('setWidgetBackgroundRefreshEnabled', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    resetBackgroundTaskModulesForTests();
  });

  it('registers once with the refresh interval', async () => {
    mockTaskManager.isTaskRegisteredAsync.mockResolvedValue(false);
    await setWidgetBackgroundRefreshEnabled(true);
    expect(mockBackgroundTask.registerTaskAsync).toHaveBeenCalledWith(
      WIDGET_BACKGROUND_REFRESH_TASK,
      { minimumInterval: WIDGET_BACKGROUND_REFRESH_INTERVAL_MINUTES },
    );

    mockTaskManager.isTaskRegisteredAsync.mockResolvedValue(true);
    await setWidgetBackgroundRefreshEnabled(true);
    expect(mockBackgroundTask.registerTaskAsync).toHaveBeenCalledTimes(1);
  });

  it('does not register when background execution is restricted', async () => {
    mockTaskManager.isTaskRegisteredAsync.mockResolvedValue(false);
    mockBackgroundTask.getStatusAsync.mockResolvedValueOnce(1);
    await setWidgetBackgroundRefreshEnabled(true);
    expect(mockBackgroundTask.registerTaskAsync).not.toHaveBeenCalled();
  });

  it('unregisters on sign-out', async () => {
    mockTaskManager.isTaskRegisteredAsync.mockResolvedValue(true);
    await setWidgetBackgroundRefreshEnabled(false);
    expect(mockBackgroundTask.unregisterTaskAsync).toHaveBeenCalledWith(WIDGET_BACKGROUND_REFRESH_TASK);
  });

  it('swallows native failures so startup never breaks', async () => {
    mockTaskManager.isTaskRegisteredAsync.mockRejectedValue(new Error('restricted'));
    await expect(setWidgetBackgroundRefreshEnabled(true)).resolves.toBeUndefined();
  });
});
