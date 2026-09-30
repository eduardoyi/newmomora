import { Platform } from 'react-native';

/**
 * Registration for the background widget refresh task. Kept apart from the
 * task body (widget-background-refresh.ts) so the widget sync provider can
 * register it without an import cycle.
 */
export const WIDGET_BACKGROUND_REFRESH_TASK = 'momora-widget-background-refresh';

/** A minimum, not a schedule: the OS batches and delays these runs. */
export const WIDGET_BACKGROUND_REFRESH_INTERVAL_MINUTES = 4 * 60;

export type BackgroundTaskModule = typeof import('expo-background-task');
export type TaskManagerModule = typeof import('expo-task-manager');

export interface BackgroundTaskModules {
  backgroundTask: BackgroundTaskModule;
  taskManager: TaskManagerModule;
}

let loadedModules: BackgroundTaskModules | null | undefined;

/**
 * Both libraries call requireNativeModule at import time, which throws on a
 * binary built before they were added (for example an OTA update running on
 * an older build). Load them lazily so such a binary keeps foreground-only
 * refresh instead of crashing on startup.
 */
export function getBackgroundTaskModules(): BackgroundTaskModules | null {
  if (Platform.OS === 'web') return null;
  if (loadedModules !== undefined) return loadedModules;
  try {
    /* eslint-disable @typescript-eslint/no-require-imports */
    loadedModules = {
      backgroundTask: require('expo-background-task') as BackgroundTaskModule,
      taskManager: require('expo-task-manager') as TaskManagerModule,
    };
    /* eslint-enable @typescript-eslint/no-require-imports */
  } catch {
    loadedModules = null;
  }
  return loadedModules;
}

/** Test-only: forget the cached module lookup. */
export function resetBackgroundTaskModulesForTests(): void {
  loadedModules = undefined;
}

/**
 * Registers the periodic task while an account is signed in and the widget
 * binary is present; unregisters on sign-out. Registration persists across
 * app restarts, so this is idempotent.
 */
export async function setWidgetBackgroundRefreshEnabled(enabled: boolean): Promise<void> {
  const modules = getBackgroundTaskModules();
  if (!modules) return;
  const { backgroundTask, taskManager } = modules;
  try {
    const registered = await taskManager.isTaskRegisteredAsync(WIDGET_BACKGROUND_REFRESH_TASK);
    if (enabled && !registered) {
      const status = await backgroundTask.getStatusAsync();
      if (status !== backgroundTask.BackgroundTaskStatus.Available) return;
      await backgroundTask.registerTaskAsync(WIDGET_BACKGROUND_REFRESH_TASK, {
        minimumInterval: WIDGET_BACKGROUND_REFRESH_INTERVAL_MINUTES,
      });
    } else if (!enabled && registered) {
      await backgroundTask.unregisterTaskAsync(WIDGET_BACKGROUND_REFRESH_TASK);
    }
  } catch {
    // Background execution is best-effort (restricted by the user, Low Power
    // Mode, or an older binary). Foreground refresh still works.
  }
}
