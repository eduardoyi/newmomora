import { Platform } from 'react-native';
import { requireOptionalNativeModule } from 'expo-modules-core';
import { router } from 'expo-router';
import type { NotificationResponse } from 'expo-notifications';
import { useCallback, useEffect, useRef } from 'react';

import { useFamily } from '@/hooks/use-family';
import { useUserProfile } from '@/hooks/useUserProfile';
import { memoryDetailRoute, newMemoryRoute, sharingApprovalsRoute, timelineRoute } from '@/lib/routes';

/**
 * expo-notifications registers its native module through expo-modules-core's
 * module registry (`global.expo.modules`), not React Native's `NativeModules`
 * -- so detection has to go through `requireOptionalNativeModule`, which
 * returns `null` instead of throwing when the module isn't installed (e.g.
 * Expo Go, or a dev client built before this module was added).
 */
export function isNotificationsAvailable(): boolean {
  if (Platform.OS === 'web') {
    return false;
  }

  try {
    return Boolean(requireOptionalNativeModule('ExpoPushTokenManager'));
  } catch {
    return false;
  }
}

/** Result of a registration attempt, so callers can react to a denial (see settings.tsx). */
export interface PushRegistrationResult {
  granted: boolean;
  canAskAgain: boolean;
  /** True only after the device token was successfully stored on the profile. */
  isRegistered: boolean;
}

export function useNotificationsRegistration(enabled: boolean) {
  const { updateProfile } = useUserProfile();

  useEffect(() => {
    if (!enabled || !isNotificationsAvailable()) {
      return;
    }

    void registerForPushNotifications(updateProfile);
  }, [enabled, updateProfile]);

  // Explicit registration for callers that need to react to the outcome
  // (e.g. a toggle switching ON should prompt for settings on denial --
  // the mount-time effect above stays silent on purpose).
  const requestRegistration = useCallback(async (): Promise<PushRegistrationResult | null> => {
    if (!isNotificationsAvailable()) {
      return null;
    }

    return registerForPushNotifications(updateProfile);
  }, [updateProfile]);

  return { requestRegistration };
}

function warnRegistrationFailure(step: string, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  console.warn(`Push notification ${step} failed: ${message}`);
}

// Lazy require keeps expo-notifications out of app startup (it's only needed
// once a notification setting is enabled). A require rather than a dynamic
// import() so Jest can resolve it through its module registry.
function loadNotifications(): typeof import('expo-notifications') {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require('expo-notifications');
}

// Never throws: the mount-time effect fires this as a fire-and-forget `void`
// call, so any rejection would surface as an unhandled rejection (dev
// red-box). E.g. getExpoPushTokenAsync throws on Android when the binary
// predates google-services.json ("Default FirebaseApp is not initialized").
async function registerForPushNotifications(
  updateProfile: ReturnType<typeof useUserProfile>['updateProfile'],
): Promise<PushRegistrationResult> {
  let canAskAgain = true;

  try {
    const Notifications = loadNotifications();

    Notifications.setNotificationHandler({
      handleNotification: async () => ({
        shouldShowBanner: true,
        shouldShowList: true,
        shouldPlaySound: true,
        shouldSetBadge: false,
      }),
    });

    const permissions = await Notifications.getPermissionsAsync();

    let finalStatus = permissions.status;
    canAskAgain = permissions.canAskAgain;

    if (finalStatus !== 'granted') {
      const requested = await Notifications.requestPermissionsAsync();
      finalStatus = requested.status;
      canAskAgain = requested.canAskAgain;
    }

    if (finalStatus !== 'granted') {
      return { granted: false, canAskAgain, isRegistered: false };
    }

    // Permission alone is not enough to receive a push. The caller needs to
    // know whether the token reached the profile before it enables a notification
    // preference that the backend could never deliver.
    try {
      const token = await Notifications.getExpoPushTokenAsync();
      await updateProfile({ expoPushToken: token.data });
      return { granted: true, canAskAgain, isRegistered: true };
    } catch (error) {
      warnRegistrationFailure('token registration', error);
      return { granted: true, canAskAgain, isRegistered: false };
    }
  } catch (error) {
    warnRegistrationFailure('permission check', error);
    return { granted: false, canAskAgain, isRegistered: false };
  }
}

/**
 * Deep-link data payload carried by pushes (plan §10, deliverable 6). Must
 * stay in sync with `PushRouteData` in
 * `supabase/functions/_shared/expo-push.ts` -- the two can't share a type
 * import across the Deno/RN boundary.
 *
 * - 'timeline': open the family timeline
 * - 'approvals': open the pending-approvals screen
 * - 'new-memory': open the create-memory screen (daily reminder)
 * - 'memory': open the memory detail screen for `memoryId` (family-activity
 *   new-memory push) -- falls back to the timeline if `memoryId` is missing
 */
export interface PushRouteData {
  route?: 'timeline' | 'approvals' | 'new-memory' | 'memory';
  familyId?: string;
  memoryId?: string;
}

/**
 * Context routeFromPushData needs to reconcile a `'memory'` push against the
 * recipient's *active* family (plan §10 follow-up): a member can belong to
 * more than one family, and the memory detail screen assumes the active
 * family matches the memory being viewed (role-gated edit/retry actions,
 * attribution name lookups scoped to the active family's roster). Reads by
 * id are RLS-scoped to membership rather than the active family, so viewing
 * cross-family content wouldn't be blocked outright -- but it would resolve
 * the wrong role/attribution. Switching first keeps that assumption true.
 * All fields optional so plain route mappings ('timeline'/'approvals'/
 * 'new-memory') and existing direct-call tests don't need to supply it.
 */
export interface RouteFromPushDataContext {
  activeFamilyId?: string | null;
  /** Recipient's current family memberships. Omit to skip the membership check. */
  memberFamilyIds?: readonly string[];
  setActiveFamily?: (familyId: string) => Promise<void>;
}

function routeToMemoryDetail(payload: PushRouteData, context: RouteFromPushDataContext): void {
  const { memoryId, familyId: targetFamilyId } = payload;

  if (!memoryId) {
    router.push(timelineRoute);
    return;
  }

  const { activeFamilyId, memberFamilyIds, setActiveFamily } = context;

  const needsSwitch =
    Boolean(targetFamilyId) && targetFamilyId !== activeFamilyId && Boolean(setActiveFamily);

  if (!needsSwitch) {
    router.push(memoryDetailRoute(memoryId));
    return;
  }

  // Recipient no longer belongs to the memory's family (e.g. removed after
  // the push was queued) -- switching would set an active_family_id the
  // caller isn't a member of, and the detail screen would just fail to
  // load. Fall back to the timeline rather than dead-ending on a blank
  // screen.
  if (memberFamilyIds && !memberFamilyIds.includes(targetFamilyId as string)) {
    router.push(timelineRoute);
    return;
  }

  void setActiveFamily?.(targetFamilyId as string)
    .catch((error) => {
      console.warn(
        'Failed to switch active family for a memory push deep link',
        error instanceof Error ? error.message : 'unknown',
      );
    })
    .finally(() => {
      router.push(memoryDetailRoute(memoryId));
    });
}

export function routeFromPushData(data: unknown, context: RouteFromPushDataContext = {}): void {
  const payload = data as PushRouteData | undefined;

  if (payload?.route === 'approvals') {
    router.push(sharingApprovalsRoute);
    return;
  }

  if (payload?.route === 'timeline') {
    router.push(timelineRoute);
    return;
  }

  if (payload?.route === 'new-memory') {
    router.push(newMemoryRoute);
    return;
  }

  if (payload?.route === 'memory') {
    routeToMemoryDetail(payload, context);
  }
}

// Module-level so both the live listener and the cold-start
// getLastNotificationResponseAsync() check (which keeps returning the same
// response until explicitly cleared) share one guard -- a re-mount (e.g.
// fast refresh, or the (app) layout remounting after a family-guard
// redirect) must not re-navigate for a response already handled.
let handledResponseIdentifier: string | null = null;

function handleNotificationResponse(
  response: NotificationResponse,
  context: RouteFromPushDataContext,
): void {
  const identifier = response.notification.request.identifier;

  if (identifier && identifier === handledResponseIdentifier) {
    return;
  }

  handledResponseIdentifier = identifier;
  routeFromPushData(response.notification.request.content.data, context);
}

/**
 * Routes to the relevant screen when the user taps a push notification.
 * Mounted once near the app root (app/(app)/_layout.tsx) so it's live for
 * the whole authenticated session, independent of which screen is
 * currently focused.
 *
 * Also covers the cold-start case: if the app was launched BY the
 * notification tap (not just backgrounded), the response-received listener
 * below never fires for it -- `getLastNotificationResponseAsync()` is the
 * documented way to pick that up after the fact. `ready` gates that check
 * until the caller's own loading guards have resolved (auth + active
 * family), since the (app) layout renders only a loading spinner -- not its
 * Stack.Screen list -- until then, and navigating into a screen that isn't
 * mounted yet would fail.
 */
export function useNotificationResponseRouting(ready: boolean): void {
  const { familyId, memberships, setActiveFamily } = useFamily();

  // Read via a ref so the listener/cold-start effects (empty deps -- they
  // must not resubscribe/refire on every family change) always see the
  // latest family context at the moment a response is actually handled.
  // Updated from an (unconditional, no-deps) effect rather than during
  // render, per react-hooks/refs.
  const contextRef = useRef<RouteFromPushDataContext>({});
  useEffect(() => {
    contextRef.current = {
      activeFamilyId: familyId,
      memberFamilyIds: memberships.map((membership) => membership.familyId),
      setActiveFamily,
    };
  });

  useEffect(() => {
    if (!isNotificationsAvailable()) {
      return;
    }

    const Notifications = loadNotifications();

    const subscription = Notifications.addNotificationResponseReceivedListener((response) => {
      handleNotificationResponse(response, contextRef.current);
    });

    return () => {
      subscription.remove();
    };
  }, []);

  useEffect(() => {
    if (!ready || !isNotificationsAvailable()) {
      return;
    }

    let cancelled = false;
    const Notifications = loadNotifications();

    void Notifications.getLastNotificationResponseAsync().then((response) => {
      if (cancelled || !response) {
        return;
      }

      handleNotificationResponse(response, contextRef.current);
    });

    return () => {
      cancelled = true;
    };
  }, [ready]);
}
