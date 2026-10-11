import { usePathname, useRouter, useSegments } from 'expo-router';
import { useEffect, useRef, useState } from 'react';

import { useAuth } from '@/hooks/use-auth';
import { useFamily } from '@/hooks/use-family';
import { newMemoryRoute, type NewMemoryAction, type NewMemorySource } from '@/lib/routes';
import { setQuickActionsEnabled, subscribeToQuickActions } from '@/services/quick-actions';
import { canEditFamilyContent } from '@/utils/roles';

/** A shortcut that never reaches the app screens (e.g. stuck in onboarding) is dropped after this. */
export const QUICK_ACTION_PENDING_TTL_MS = 10_000;

const SOURCE_BY_ACTION: Record<NewMemoryAction, NewMemorySource> = {
  text: 'shortcut_text',
  photo: 'shortcut_photo',
  voice: 'shortcut_voice',
  scan: 'shortcut_scan',
};

function createActionId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * Home-screen app shortcuts (docs/features/app-shortcuts.md).
 *
 * Publishes the shortcut list while a signed-in editor has an active family
 * (cleared otherwise), and routes a triggered shortcut to the composer. A
 * trigger is held as pending until auth and family have settled, because on a
 * cold start it arrives before routing is ready. The composer owns running
 * the action (once per `actionId`); this component only navigates.
 */
export function QuickActionRouter() {
  const router = useRouter();
  const pathname = usePathname();
  const segments = useSegments();
  const { session, isLoading: isAuthLoading } = useAuth();
  const { familyId, role, isLoading: isFamilyLoading } = useFamily();
  const [pending, setPending] = useState<{ action: NewMemoryAction; at: number } | null>(null);
  const isOnAppRoute = (segments as string[]).includes('(app)');

  const isSignedIn = Boolean(session) && !session?.user?.is_anonymous;
  const canCreate = isSignedIn && Boolean(familyId) && canEditFamilyContent(role);
  const isSettled = !isAuthLoading && (!isSignedIn || !isFamilyLoading);

  useEffect(() => {
    return subscribeToQuickActions((action) => setPending({ action, at: Date.now() }));
  }, []);

  // Publish/clear the shortcut list. Not touched while loading so a restart
  // doesn't flash the list empty.
  const publishedRef = useRef<boolean | null>(null);
  useEffect(() => {
    if (!isSettled || publishedRef.current === canCreate) return;
    publishedRef.current = canCreate;
    void setQuickActionsEnabled(canCreate);
  }, [canCreate, isSettled]);

  useEffect(() => {
    if (!pending || !isSettled) return;

    // Signed out / anonymous / no family / viewer: leave it to normal routing
    // and never replay after a later sign-in.
    if (!canCreate) {
      setPending(null);
      return;
    }

    if (!isOnAppRoute) {
      const remaining = QUICK_ACTION_PENDING_TTL_MS - (Date.now() - pending.at);
      const timer = setTimeout(() => setPending(null), Math.max(0, remaining));
      return () => clearTimeout(timer);
    }

    const source = SOURCE_BY_ACTION[pending.action];
    const params = { action: pending.action, actionId: createActionId() };
    setPending(null);
    if (pathname.endsWith('/new-memory')) {
      // Never stack a second composer or wipe the open draft: hand the
      // action to the existing one.
      router.setParams({ ...params, source });
    } else {
      router.push(newMemoryRoute(source, params));
    }
  }, [canCreate, isOnAppRoute, isSettled, pathname, pending, router]);

  return null;
}
