// Onboarding draft context (docs/plans/onboarding-implementation.md WP0
// §0.5). Mounted by app/(onboarding)/_layout.tsx (WP1) around the whole
// route group. Hydrates the device-local draft once on mount, then
// debounce-persists on every change -- same spirit as the new-memory draft
// autosave (app/(app)/new-memory.tsx `DRAFT_SAVE_DEBOUNCE_MS`). Screens
// read/write through `useOnboardingFlow()`, never AsyncStorage directly.
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';

import {
  clearOnboardingDraft,
  createEmptyOnboardingDraft,
  getOnboardingDraft,
  patchOnboardingDraft,
  type OnboardingDraft,
} from '@/utils/onboarding-progress';

// Coalesces rapid field edits (typing a kid's name, editing the capture
// text) into one AsyncStorage write. Shorter than the new-memory draft's
// 500ms because the OTP round trip can background the app at any moment,
// and onboarding fields are small enough that 300ms of debounce is cheap.
const ONBOARDING_DRAFT_PERSIST_DEBOUNCE_MS = 300;

interface OnboardingFlowContextValue {
  draft: OnboardingDraft;
  isHydrated: boolean;
  patch: (partial: Partial<Omit<OnboardingDraft, 'version'>>) => void;
  clear: () => Promise<void>;
}

const OnboardingFlowContext = createContext<OnboardingFlowContextValue | null>(null);

export function OnboardingFlowProvider({ children }: { children: ReactNode }) {
  const [draft, setDraft] = useState<OnboardingDraft>(() => createEmptyOnboardingDraft());
  const [isHydrated, setIsHydrated] = useState(false);
  const isFirstPersistableChangeRef = useRef(true);

  useEffect(() => {
    let isMounted = true;

    void getOnboardingDraft().then((stored) => {
      if (!isMounted) {
        return;
      }

      if (stored) {
        setDraft(stored);
      }

      setIsHydrated(true);
    });

    return () => {
      isMounted = false;
    };
  }, []);

  // Debounced persist on every draft change, once hydration has had its
  // chance to run -- an earlier write would race the hydration read above
  // and could clobber a real stored draft with the fresh-mount default.
  useEffect(() => {
    if (!isHydrated) {
      return;
    }

    // The hydration read itself lands here as a "change" (setDraft(stored)
    // above): skip persisting that first post-hydration render so a
    // resumed session doesn't immediately re-write the exact draft it just
    // read back to disk.
    if (isFirstPersistableChangeRef.current) {
      isFirstPersistableChangeRef.current = false;
      return;
    }

    const timeoutId = setTimeout(() => {
      void patchOnboardingDraft({
        step: draft.step,
        kidNames: draft.kidNames,
        familyName: draft.familyName,
        capture: draft.capture,
        notificationChoice: draft.notificationChoice,
        committedFamilyId: draft.committedFamilyId,
      });
    }, ONBOARDING_DRAFT_PERSIST_DEBOUNCE_MS);

    return () => clearTimeout(timeoutId);
  }, [draft, isHydrated]);

  const patch = useCallback((partial: Partial<Omit<OnboardingDraft, 'version'>>) => {
    setDraft((current) => ({ ...current, ...partial }));
  }, []);

  const clear = useCallback(async () => {
    await clearOnboardingDraft();
    isFirstPersistableChangeRef.current = true;
    setDraft(createEmptyOnboardingDraft());
  }, []);

  const value = useMemo<OnboardingFlowContextValue>(
    () => ({ draft, isHydrated, patch, clear }),
    [draft, isHydrated, patch, clear],
  );

  return <OnboardingFlowContext.Provider value={value}>{children}</OnboardingFlowContext.Provider>;
}

export function useOnboardingFlow(): OnboardingFlowContextValue {
  const context = useContext(OnboardingFlowContext);

  if (!context) {
    throw new Error('useOnboardingFlow must be used within OnboardingFlowProvider');
  }

  return context;
}
