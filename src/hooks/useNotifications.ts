import { Platform } from 'react-native';
import { requireOptionalNativeModule } from 'expo-modules-core';
import { router } from 'expo-router';
import type { NotificationResponse } from 'expo-notifications';
import type { QueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useRef } from 'react';

import { useFamily } from '@/hooks/use-family';
import { invalidateYearFilms } from '@/hooks/useYearFilms';
import { useUserProfile } from '@/hooks/useUserProfile';
import { queryClient } from '@/lib/query-client';
import {
  memoryBooksRoute,
  memoryDetailRoute,
  newMemoryRoute,
  sharingApprovalsRoute,
  timelineRoute,
  yearFilmRoute,
} from '@/lib/routes';
import { trackEvent } from '@/services/analytics';

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

type Notifications = ReturnType<typeof loadNotifications>;
type UpdateProfile = ReturnType<typeof useUserProfile>['updateProfile'];

function installForegroundHandler(Notifications: Notifications): void {
  Notifications.setNotificationHandler({
    handleNotification: async () => ({
      shouldShowBanner: true,
      shouldShowList: true,
      shouldPlaySound: true,
      shouldSetBadge: false,
    }),
  });
}

async function getOrRequestPermission(
  Notifications: Notifications,
): Promise<{ granted: boolean; canAskAgain: boolean }> {
  const permissions = await Notifications.getPermissionsAsync();

  if (permissions.status === 'granted') {
    return { granted: true, canAskAgain: permissions.canAskAgain };
  }

  const requested = await Notifications.requestPermissionsAsync();
  return { granted: requested.status === 'granted', canAskAgain: requested.canAskAgain };
}

/**
 * OS permission prompt only -- no token is stored. For onboarding's S11,
 * which runs before the user has an account (there's no profile to write a
 * token to yet); `usePushTokenSync` stores the token once they're signed in.
 * Resolves null when notifications aren't available in this build. Never
 * throws.
 */
export async function requestPushPermission(): Promise<{ granted: boolean; canAskAgain: boolean } | null> {
  if (!isNotificationsAvailable()) {
    return null;
  }

  try {
    const Notifications = loadNotifications();
    installForegroundHandler(Notifications);
    return await getOrRequestPermission(Notifications);
  } catch (error) {
    warnRegistrationFailure('permission request', error);
    return { granted: false, canAskAgain: true };
  }
}

/**
 * Stores this device's push token on the signed-in profile when permission
 * is ALREADY granted -- never prompts. Without this, a token only reached the
 * profile when the Settings tab mounted, so an owner who granted permission
 * during onboarding (pre-auth, nothing to write to) got no pushes at all --
 * daily reminders, trial-ending, film-ready -- until they happened to open
 * Settings. Running it per signed-in launch also makes the most recently
 * opened device the one that receives pushes (single-token column, see
 * docs/features/family-sharing.md). Resolves whether a token was written.
 * Never throws.
 */
export async function syncPushTokenIfPermitted(
  currentToken: string | null | undefined,
  updateProfile: UpdateProfile,
): Promise<boolean> {
  try {
    const Notifications = loadNotifications();
    const permissions = await Notifications.getPermissionsAsync();

    if (permissions.status !== 'granted') {
      return false;
    }

    installForegroundHandler(Notifications);
    const token = await Notifications.getExpoPushTokenAsync();

    if (token.data === currentToken) {
      return false;
    }

    await updateProfile({ expoPushToken: token.data });
    return true;
  } catch (error) {
    warnRegistrationFailure('token sync', error);
    return false;
  }
}

/** Mount once for the signed-in app session (app/(app)/_layout.tsx). */
export function usePushTokenSync(enabled: boolean): void {
  const { profile, updateProfile } = useUserProfile();
  const syncedProfileIdRef = useRef<string | null>(null);

  useEffect(() => {
    if (!enabled || !profile || !isNotificationsAvailable()) {
      return;
    }

    if (syncedProfileIdRef.current === profile.id) {
      return;
    }

    syncedProfileIdRef.current = profile.id;
    void syncPushTokenIfPermitted(profile.expo_push_token, updateProfile);
  }, [enabled, profile, updateProfile]);
}

// Never throws: the mount-time effect fires this as a fire-and-forget `void`
// call, so any rejection would surface as an unhandled rejection (dev
// red-box). E.g. getExpoPushTokenAsync throws on Android when the binary
// predates google-services.json ("Default FirebaseApp is not initialized").
async function registerForPushNotifications(
  updateProfile: UpdateProfile,
): Promise<PushRegistrationResult> {
  let canAskAgain = true;

  try {
    const Notifications = loadNotifications();
    installForegroundHandler(Notifications);

    const permission = await getOrRequestPermission(Notifications);
    canAskAgain = permission.canAskAgain;

    if (!permission.granted) {
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
 * - 'memory-book': open the Memory Books shelf for `memberId` (a book
 *   finished generating, or failed) -- falls back to the timeline if
 *   `memberId` is missing
 * - 'year-film': open the Year Film player for `filmId` (a film was
 *   delivered) -- falls back to the timeline if `filmId` is missing or the
 *   recipient is no longer a member of `familyId`
 */
export interface PushRouteData {
  route?: 'timeline' | 'approvals' | 'new-memory' | 'memory' | 'memory-book' | 'year-film';
  familyId?: string;
  memoryId?: string;
  /** 'memory-book' only -- the child (`family_members.id`) whose shelf to open. */
  memberId?: string;
  /** 'memory-book' only -- informational; the shelf itself is keyed off `memberId`, not `bookId`. */
  bookId?: string;
  /** 'year-film' only -- the `year_films.id` to play. */
  filmId?: string;
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
  /** Used by 'year-film' pushes to refresh the family's films list. Omit to skip. */
  queryClient?: QueryClient;
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

/**
 * Routes a `'memory-book'` push (a book finished generating, or failed) to
 * the Memory Books shelf for `memberId`. Mirrors `routeToMemoryDetail`'s
 * active-family reconciliation structure: a recipient can belong to more
 * than one family, and the shelf screen resolves its scope/role off the
 * active family, so a book push for a non-active family must switch first
 * (or fall back to the timeline if the recipient no longer belongs to that
 * family at all).
 */
function routeToMemoryBooks(payload: PushRouteData, context: RouteFromPushDataContext): void {
  const { memberId, familyId: targetFamilyId } = payload;

  if (!memberId) {
    router.push(timelineRoute);
    return;
  }

  const { activeFamilyId, memberFamilyIds, setActiveFamily } = context;

  const needsSwitch =
    Boolean(targetFamilyId) && targetFamilyId !== activeFamilyId && Boolean(setActiveFamily);

  if (!needsSwitch) {
    router.push(memoryBooksRoute(memberId));
    return;
  }

  if (memberFamilyIds && !memberFamilyIds.includes(targetFamilyId as string)) {
    router.push(timelineRoute);
    return;
  }

  void setActiveFamily?.(targetFamilyId as string)
    .catch((error) => {
      console.warn(
        'Failed to switch active family for a memory-book push deep link',
        error instanceof Error ? error.message : 'unknown',
      );
    })
    .finally(() => {
      router.push(memoryBooksRoute(memberId));
    });
}

/**
 * Routes a `'year-film'` push (a film was delivered) to the player. The push
 * also refreshes the target family's films list, so the Timeline / Keepsakes
 * cards are there by the time the user closes the player. Mirrors
 * `routeToMemoryBooks`: switch the active family to the push's `familyId`
 * first (falling back to the timeline if the recipient is no longer a
 * member), then open the player. Warm and cold start share this path; on a
 * cold start the player has no history to go back to, so its close button
 * replaces to the timeline (see app/(app)/year-film/[id].tsx).
 */
function routeToYearFilm(payload: PushRouteData, context: RouteFromPushDataContext): void {
  const { filmId, familyId: targetFamilyId } = payload;

  if (!filmId) {
    router.push(timelineRoute);
    return;
  }

  const { activeFamilyId, memberFamilyIds, setActiveFamily, queryClient } = context;

  if (targetFamilyId && queryClient) {
    void invalidateYearFilms(queryClient, targetFamilyId);
  }

  const needsSwitch =
    Boolean(targetFamilyId) && targetFamilyId !== activeFamilyId && Boolean(setActiveFamily);

  if (!needsSwitch) {
    router.push(yearFilmRoute(filmId, 'push'));
    return;
  }

  if (memberFamilyIds && !memberFamilyIds.includes(targetFamilyId as string)) {
    router.push(timelineRoute);
    return;
  }

  void setActiveFamily?.(targetFamilyId as string)
    .catch((error) => {
      console.warn(
        'Failed to switch active family for a year-film push deep link',
        error instanceof Error ? error.message : 'unknown',
      );
    })
    .finally(() => {
      router.push(yearFilmRoute(filmId, 'push'));
    });
}

// The recognized `PushRouteData.route` literals -- checked against at
// runtime before reporting `notification_opened` so an unrecognized/garbage
// route value (a payload typo, or a future route this build doesn't know
// about yet) can never leak into the event's closed `target` union. `data`
// is untyped (`as PushRouteData | undefined` is just a cast, not a runtime
// check), so this guard is the actual enforcement.
const RECOGNIZED_PUSH_ROUTES = new Set<NonNullable<PushRouteData['route']>>([
  'timeline',
  'approvals',
  'new-memory',
  'memory',
  'memory-book',
  'year-film',
]);

export function routeFromPushData(data: unknown, context: RouteFromPushDataContext = {}): void {
  const payload = data as PushRouteData | undefined;

  // `target` is the literal `PushRouteData.route` value verbatim -- never
  // any other field off the push payload (docs/plans/analytics-tracking.md
  // Tier 2, `notification_opened`). Fired once per recognized route, ahead
  // of the branch below so every taken path (including the memory-detail
  // family-switch branch) is covered by a single call site.
  if (payload?.route && RECOGNIZED_PUSH_ROUTES.has(payload.route)) {
    trackEvent('notification_opened', { target: payload.route });
  }

  if (payload?.route === 'approvals') {
    router.push(sharingApprovalsRoute);
    return;
  }

  if (payload?.route === 'timeline') {
    router.push(timelineRoute);
    return;
  }

  if (payload?.route === 'new-memory') {
    router.push(newMemoryRoute('notification'));
    return;
  }

  if (payload?.route === 'memory') {
    routeToMemoryDetail(payload, context);
    return;
  }

  if (payload?.route === 'memory-book') {
    routeToMemoryBooks(payload, context);
    return;
  }

  if (payload?.route === 'year-film') {
    routeToYearFilm(payload, context);
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
      // The app-wide client (same one AppProviders mounts), so this hook
      // needs no QueryClientProvider of its own.
      queryClient,
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
