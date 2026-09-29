import { AppState } from 'react-native';

import {
  getMemoryWidgetSyncCoordinator,
  isRetryableWidgetSyncFailure,
  type MemoryWidgetSyncCoordinator,
} from '@/hooks/useMemoryWidgetSync';
import { supabase } from '@/lib/supabase';
import { fetchUserProfile } from '@/services/user-profile';
import {
  getBackgroundTaskModules,
  WIDGET_BACKGROUND_REFRESH_TASK,
} from '@/services/widget-background-registration';
import { momoraWidgetAdapter } from '@/widgets/native-adapter';
import type { WidgetCacheScope, WidgetNativeAdapter } from '@/widgets/types';

/**
 * Background widget refresh. The OS wakes the app (WorkManager on Android,
 * BGTaskScheduler on iOS) and this runs the same online validation as the
 * foreground sync, so the widget keeps rotating fresh memories and its
 * 168-hour lease is renewed without the user opening Momora. It never
 * weakens the lease rules: a failed validation still never renews it.
 * Registration lives in widget-background-registration.ts.
 */

export type WidgetBackgroundRefreshOutcome =
  | 'refreshed'
  | 'cleared'
  | 'failed'
  | 'skipped_foreground'
  | 'skipped_unsupported'
  | 'skipped_no_widget'
  | 'skipped_signed_out'
  | 'skipped_no_family'
  | 'skipped';

interface SessionUser {
  id: string;
  is_anonymous?: boolean;
}

export interface WidgetBackgroundRefreshDependencies {
  adapter?: WidgetNativeAdapter | null;
  getAppState?: () => string | null;
  getSessionUser?: () => Promise<SessionUser | null>;
  fetchProfile?: () => Promise<{
    data: { active_family_id: string | null; deleted_at: string | null } | null;
    error: { message: string } | null;
  }>;
  getCoordinator?: (adapter: WidgetNativeAdapter) => Pick<MemoryWidgetSyncCoordinator, 'sync' | 'clear'>;
}

async function defaultSessionUser(): Promise<SessionUser | null> {
  // getSession refreshes an expired access token from the persisted refresh
  // token. A failed refresh returns no session; that is not a sign-out.
  const { data, error } = await supabase.auth.getSession();
  if (error) return null;
  return data.session?.user ?? null;
}

export async function runWidgetBackgroundRefresh(
  dependencies: WidgetBackgroundRefreshDependencies = {},
): Promise<WidgetBackgroundRefreshOutcome> {
  const getAppState = dependencies.getAppState ?? (() => AppState.currentState);
  // The foreground provider owns sync while the app is on screen; it also
  // handles account/family transitions this headless path cannot see.
  if (getAppState() === 'active') return 'skipped_foreground';

  const adapter = dependencies.adapter === undefined ? momoraWidgetAdapter : dependencies.adapter;
  if (!adapter || !(await Promise.resolve(adapter.available()).catch(() => false))) {
    return 'skipped_unsupported';
  }
  // Save battery and data for people who never placed the widget. Unknown
  // (older binary) counts as placed.
  if ((await adapter.hasPlacedWidgets?.().catch(() => null)) === false) {
    return 'skipped_no_widget';
  }

  const coordinator = (dependencies.getCoordinator ?? getMemoryWidgetSyncCoordinator)(adapter);
  const cached = await Promise.resolve(adapter.readManifest()).catch(() => null);
  const cachedScope: WidgetCacheScope | null = cached
    ? { accountId: cached.accountId, familyId: cached.familyId }
    : null;

  const user = await (dependencies.getSessionUser ?? defaultSessionUser)().catch(() => null);
  // No session here may be a transient refresh failure. An explicit sign-out
  // already cleared the widget in the foreground, so do not clear on a guess.
  if (!user || user.is_anonymous) return 'skipped_signed_out';

  if (cachedScope && cachedScope.accountId !== user.id) {
    // A different account now owns this device session; never refresh or
    // keep the previous account's private card.
    await coordinator.clear(cachedScope);
    return 'cleared';
  }

  const profile = await (dependencies.fetchProfile ?? fetchUserProfile)().catch(() => null);
  if (!profile || profile.error) return 'failed';
  if (profile.data?.deleted_at) {
    if (cachedScope) await coordinator.clear(cachedScope);
    return 'cleared';
  }

  // The profile's active family is the same source the foreground uses. An
  // expired lease leaves no cached manifest, so it is also the recovery path.
  const familyId = profile.data?.active_family_id ?? cachedScope?.familyId ?? null;
  if (!familyId) return 'skipped_no_family';

  const result = await coordinator.sync({ accountId: user.id, familyId });
  if (result.published) return 'refreshed';
  if (result.cleared) return 'cleared';
  return isRetryableWidgetSyncFailure(result) ? 'failed' : 'skipped';
}

/**
 * Must run at module scope of the JS entry (see /index.ts): a headless
 * background launch never renders the router, so the task has to be defined
 * before the OS dispatches it.
 */
export function defineWidgetBackgroundRefreshTask(): void {
  const modules = getBackgroundTaskModules();
  if (!modules) return;
  const { backgroundTask, taskManager } = modules;
  try {
    if (taskManager.isTaskDefined(WIDGET_BACKGROUND_REFRESH_TASK)) return;
    taskManager.defineTask(WIDGET_BACKGROUND_REFRESH_TASK, async () => {
      try {
        const outcome = await runWidgetBackgroundRefresh();
        return outcome === 'failed'
          ? backgroundTask.BackgroundTaskResult.Failed
          : backgroundTask.BackgroundTaskResult.Success;
      } catch {
        return backgroundTask.BackgroundTaskResult.Failed;
      }
    });
  } catch {
    // A task-manager failure must never break app startup.
  }
}
