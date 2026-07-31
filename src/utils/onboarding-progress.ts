// Device-local pre-auth onboarding progress (docs/plans/onboarding-implementation.md
// WP0 §0.4). Mirrors src/utils/pending-invite-code.ts's defensive
// try/catch-to-null AsyncStorage style: a storage hiccup degrades to "no
// draft" (read) or a silent no-op (write) rather than throwing, so a
// corrupted or unavailable disk never blocks onboarding.
//
// Do not persist audio here. The voice pipeline's no-persistence rule
// (CLAUDE.md, AGENTS.md) holds pre-auth too -- audio is transcribed in
// memory and discarded; only the resulting text is ever written to the
// draft.
import AsyncStorage from '@react-native-async-storage/async-storage';

export const ONBOARDING_DRAFT_STORAGE_KEY = 'momora.onboardingDraft';
export const ONBOARDING_DRAFT_VERSION = 1;

/**
 * Resume point for the owner-path story/capture/trust arc (S0-S16). The
 * join path (J1-J5) does not resume through this draft's `step` -- see
 * WP4's own device-local store for the display-name field it needs to
 * survive the OTP round trip.
 */
export type OnboardingStepId =
  | 'welcome'
  | 'story-0'
  | 'story-1'
  | 'story-2'
  | 'founders'
  | 'artifact'
  | 'kids'
  | 'family-name'
  | 'bridge'
  | 'capture'
  | 'aha'
  | 'year'
  | 'notifications'
  | 'email'
  | 'code'
  | 'trial'
  | 'included'
  | 'paywall'
  | 'portrait';

export type OnboardingNotificationChoice = 'eve' | 'late' | 'morn' | 'none';

export interface OnboardingDraftCapture {
  text: string;
  mediaUri?: string;
  mediaContentType?: string;
  /**
   * Natural width/height ratio for the attached photo/video, from the same
   * `MediaAttachment.aspectRatio` (src/components/memory-media-picker.tsx,
   * `aspectRatioFromDimensions`) the app's own new-memory composer stores --
   * without it the timeline has nothing to size the media container from
   * and falls back to DEFAULT_MEDIA_ASPECT_RATIO (src/utils/media-aspect.ts),
   * pillarboxing portrait photos. Added after the fields below it, so it's
   * absent (`undefined`) on a draft written before this field existed; that
   * is a normal, handled state (see mediaContentType's own optionality), not
   * a shape violation -- `isOnboardingDraftShape` below never inspects
   * `capture`'s internal fields, so an old on-disk draft round-trips through
   * `patchOnboardingDraft` unchanged and this field just stays `undefined`
   * until the next capture.
   */
  mediaAspectRatio?: number;
  /** Same rationale as `mediaAspectRatio`, for attached videos only -- mirrors `MediaAttachment.durationMs`. */
  mediaDurationMs?: number;
  taggedKidIndexes: number[];
}

export interface OnboardingDraft {
  version: 1;
  step: OnboardingStepId;
  kidNames: string[];
  familyName: string;
  capture: OnboardingDraftCapture | null;
  notificationChoice: OnboardingNotificationChoice | null;
  /** Set by commitOnboarding (src/services/onboarding.ts) -- makes the commit idempotent across the OTP round trip and app kills. */
  committedFamilyId?: string;
}

export function createEmptyOnboardingDraft(step: OnboardingStepId = 'welcome'): OnboardingDraft {
  return {
    version: ONBOARDING_DRAFT_VERSION,
    step,
    kidNames: [],
    familyName: '',
    capture: null,
    notificationChoice: null,
  };
}

function isOnboardingDraftShape(value: unknown): value is OnboardingDraft {
  if (!value || typeof value !== 'object') {
    return false;
  }

  const candidate = value as Partial<OnboardingDraft>;

  return (
    candidate.version === ONBOARDING_DRAFT_VERSION &&
    typeof candidate.step === 'string' &&
    Array.isArray(candidate.kidNames) &&
    typeof candidate.familyName === 'string'
  );
}

export async function getOnboardingDraft(): Promise<OnboardingDraft | null> {
  try {
    const stored = await AsyncStorage.getItem(ONBOARDING_DRAFT_STORAGE_KEY);

    if (!stored) {
      return null;
    }

    const parsed: unknown = JSON.parse(stored);

    // Unknown/mismatched version (or a malformed shape) -- treat as absent
    // (forward-compat): a future draft shape must never be misread as this
    // version's shape.
    if (!isOnboardingDraftShape(parsed)) {
      return null;
    }

    return parsed;
  } catch {
    // Storage hiccups or corrupt JSON degrade to "no draft" -- onboarding
    // just starts over rather than crashing.
    return null;
  }
}

/**
 * Merges `partial` onto the currently-stored draft (or a fresh empty one)
 * and persists the result. Returns the merged draft so callers that already
 * hold the full in-memory state (see src/hooks/use-onboarding-flow.tsx) can
 * pass their whole draft as `partial` for a plain overwrite, avoiding any
 * read-modify-write race across rapid successive patches.
 */
export async function patchOnboardingDraft(
  partial: Partial<Omit<OnboardingDraft, 'version'>>,
): Promise<OnboardingDraft> {
  const current = (await getOnboardingDraft()) ?? createEmptyOnboardingDraft();
  const next: OnboardingDraft = { ...current, ...partial, version: ONBOARDING_DRAFT_VERSION };

  try {
    await AsyncStorage.setItem(ONBOARDING_DRAFT_STORAGE_KEY, JSON.stringify(next));
  } catch {
    // Best-effort: losing a write means the app re-derives from the last
    // successfully persisted draft (or starts over) next launch. Never
    // blocking the caller matters more than never losing a field.
  }

  return next;
}

export async function clearOnboardingDraft(): Promise<void> {
  try {
    await AsyncStorage.removeItem(ONBOARDING_DRAFT_STORAGE_KEY);
  } catch {
    // Best-effort; a stale draft is re-cleared (or ignored via the
    // version/shape check) on the next read.
  }
}
