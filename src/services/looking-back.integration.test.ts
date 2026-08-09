import AsyncStorage from '@react-native-async-storage/async-storage';

import { supabase } from '@/lib/supabase';
import {
  clearAllLookingBackPendingViews,
  enqueuePendingLookingBackView,
  fetchLookingBackPackages,
  flushPendingLookingBackViews,
  getPendingLookingBackViews,
  LOOKING_BACK_PENDING_VIEW_MAX_ENTRIES,
  lookingBackPendingViewStorageKey,
  markLookingBackPackageViewed,
  mergeLookingBackPendingViews,
} from '@/services/looking-back';

jest.mock('@react-native-async-storage/async-storage', () =>
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- maintained Jest adapter
  require('@react-native-async-storage/async-storage/jest/async-storage-mock'),
);

jest.mock('@/lib/supabase', () => ({
  supabase: { rpc: jest.fn() },
}));

const mockedRpc = supabase.rpc as jest.Mock;

describe('Looking Back service and pending-view outbox', () => {
  beforeEach(async () => {
    jest.clearAllMocks();
    await AsyncStorage.clear();
  });

  it('maps the stable empty-day sentinel to an empty package set', async () => {
    mockedRpc.mockResolvedValue({
      data: [{
        daily_set_id: 'set-1',
        package_id: null,
        package_date: '2026-08-08',
        package_type: null,
        memory_ids: [],
        refresh_after: '2026-08-09T00:00:00.000Z',
      }],
      error: null,
    });

    const result = await fetchLookingBackPackages('family-1');

    expect(result).toMatchObject({
      data: {
        dailySetId: 'set-1',
        packageDate: '2026-08-08',
        refreshAfter: '2026-08-09T00:00:00.000Z',
        packages: [],
      },
      error: null,
      failure: null,
    });
    expect(mockedRpc).toHaveBeenCalledWith('get_or_create_looking_back_packages', { p_family_id: 'family-1' });
  });

  it('maps and position-sorts only complete RPC package rows', async () => {
    mockedRpc.mockResolvedValue({
      data: [
        {
          daily_set_id: 'set-1', package_id: 'package-2', package_date: '2026-08-08',
          package_type: 'archive_mix', display_kind: 'From your archive', display_title: 'August 2023',
          display_subtitle: null, display_era: 'Three years ago', tint: 'joy', position: 1,
          memory_ids: ['m-3', 'm-4'], first_viewed_at: null, last_viewed_at: null, completed_at: null,
          refresh_after: '2026-08-09T00:00:00.000Z', subject_family_member_id: null,
        },
        {
          daily_set_id: 'set-1', package_id: 'package-1', package_date: '2026-08-08',
          package_type: 'on_this_day', display_kind: 'On this day', display_title: 'A day to remember',
          display_subtitle: 'A little while ago', display_era: 'One year ago', tint: null, position: 0,
          memory_ids: ['m-1', 'm-2'], first_viewed_at: '2026-08-08T10:00:00.000Z',
          last_viewed_at: '2026-08-08T10:00:00.000Z', completed_at: null,
          refresh_after: '2026-08-09T00:00:00.000Z', subject_family_member_id: null,
        },
        // A malformed/unexpected row never reaches rendering code.
        { daily_set_id: 'set-1', package_id: 'bad', package_type: 'not-a-recipe' },
      ],
      error: null,
    });

    const result = await fetchLookingBackPackages('family-1');

    expect(result.data?.packages.map((item) => item.id)).toEqual(['package-1', 'package-2']);
    expect(result.data?.packages[0]).toMatchObject({
      familyId: 'family-1', packageType: 'on_this_day', memoryIds: ['m-1', 'm-2'],
      view: { firstViewedAt: '2026-08-08T10:00:00.000Z', completedAt: null },
    });
  });

  it('keeps authorization distinguishable while other optional failures remain silent candidates', async () => {
    mockedRpc.mockResolvedValue({ data: null, error: { message: 'not permitted', code: '42501' } });
    await expect(fetchLookingBackPackages('family-1')).resolves.toMatchObject({ failure: 'authorization' });

    mockedRpc.mockResolvedValue({ data: null, error: { message: 'offline', code: 'PGRST000' } });
    await expect(fetchLookingBackPackages('family-1')).resolves.toMatchObject({ failure: 'unavailable' });
  });

  it('treats a malformed RPC payload as unavailable instead of throwing into Timeline rendering', async () => {
    mockedRpc.mockResolvedValue({ data: { package_id: 'not-an-array' }, error: null });

    await expect(fetchLookingBackPackages('family-1')).resolves.toMatchObject({
      data: null,
      failure: 'unavailable',
    });
  });

  it('calls the idempotent view RPC with the completion bit and maps its timestamps', async () => {
    mockedRpc.mockResolvedValue({
      data: {
        first_viewed_at: '2026-08-08T10:00:00.000Z',
        last_viewed_at: '2026-08-08T10:03:00.000Z',
        completed_at: '2026-08-08T10:03:00.000Z',
      },
      error: null,
    });

    await expect(markLookingBackPackageViewed('package-1', true)).resolves.toMatchObject({
      data: { completedAt: '2026-08-08T10:03:00.000Z' },
    });
    expect(mockedRpc).toHaveBeenCalledWith('mark_looking_back_package_viewed', {
      p_package_id: 'package-1', p_completed: true,
    });
  });

  it('merges a local pending view over stale server state before replacing package UI', async () => {
    const local = await enqueuePendingLookingBackView('user-1', 'family-1', 'package-1', {
      occurredAt: '2026-08-08T10:00:00.000Z', completed: true,
    });

    const merged = mergeLookingBackPendingViews([
      {
        id: 'package-1',
        view: { firstViewedAt: null, lastViewedAt: null, completedAt: null },
      },
      {
        id: 'package-2',
        view: { firstViewedAt: null, lastViewedAt: null, completedAt: null },
      },
    ], [local]);

    expect(merged[0].view).toEqual({
      firstViewedAt: '2026-08-08T10:00:00.000Z',
      lastViewedAt: '2026-08-08T10:00:00.000Z',
      completedAt: '2026-08-08T10:00:00.000Z',
    });
    expect(merged[1].view.firstViewedAt).toBeNull();
  });

  it('keeps a newer local event when an earlier flush acknowledgement returns', async () => {
    await enqueuePendingLookingBackView('user-1', 'family-1', 'package-1', {
      occurredAt: '2026-08-08T10:00:00.000Z',
    });

    let resolveRpc!: () => void;
    mockedRpc.mockImplementation(() => new Promise((resolve) => {
      resolveRpc = () => resolve({ data: {}, error: null });
    }));

    const flushing = flushPendingLookingBackViews('user-1', 'family-1');
    await Promise.resolve();
    await enqueuePendingLookingBackView('user-1', 'family-1', 'package-1', {
      occurredAt: '2026-08-08T10:01:00.000Z', completed: true,
    });
    resolveRpc();
    await flushing;

    await expect(getPendingLookingBackViews('user-1', 'family-1')).resolves.toEqual([
      {
        packageId: 'package-1',
        firstViewedAt: '2026-08-08T10:00:00.000Z',
        lastViewedAt: '2026-08-08T10:01:00.000Z',
        completedAt: '2026-08-08T10:01:00.000Z',
      },
    ]);
  });

  it('removes only acknowledged entries and purges every account/family namespace', async () => {
    await enqueuePendingLookingBackView('user-1', 'family-1', 'package-1');
    await enqueuePendingLookingBackView('user-1', 'family-2', 'package-2');
    mockedRpc.mockResolvedValue({ data: {}, error: null });

    await flushPendingLookingBackViews('user-1', 'family-1');
    expect(await AsyncStorage.getItem(lookingBackPendingViewStorageKey('user-1', 'family-1'))).toBeNull();

    await clearAllLookingBackPendingViews();
    expect(await AsyncStorage.getItem(lookingBackPendingViewStorageKey('user-1', 'family-2'))).toBeNull();
  });

  it('prunes stale pending entries and caps a persistently failing outbox', async () => {
    await enqueuePendingLookingBackView('user-1', 'family-1', 'expired', {
      occurredAt: new Date(Date.now() - 46 * 24 * 60 * 60 * 1000).toISOString(),
    });
    await expect(getPendingLookingBackViews('user-1', 'family-1')).resolves.toEqual([]);

    for (let index = 0; index < LOOKING_BACK_PENDING_VIEW_MAX_ENTRIES + 1; index += 1) {
      await enqueuePendingLookingBackView('user-1', 'family-1', `package-${index}`, {
        occurredAt: new Date(Date.now() + index).toISOString(),
      });
    }

    const entries = await getPendingLookingBackViews('user-1', 'family-1');
    expect(entries).toHaveLength(LOOKING_BACK_PENDING_VIEW_MAX_ENTRIES);
    expect(entries.some((entry) => entry.packageId === 'package-0')).toBe(false);
    expect(entries.some((entry) => entry.packageId === `package-${LOOKING_BACK_PENDING_VIEW_MAX_ENTRIES}`)).toBe(true);
  });
});
