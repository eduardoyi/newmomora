// Pending invite code carried across the universal-link -> (signup ->) redeem
// flow (docs/plans/family-sharing.md §9). `app/invite.tsx` stores the code,
// the redeem screen prefills from it, and it is cleared only after a
// redemption attempt (success or definitive failure) -- never on mere
// navigation, so the code survives whichever guard (auth redirect,
// FamilyProvider no-membership redirect, no-family screen) fires first.
import AsyncStorage from '@react-native-async-storage/async-storage';

import { normalizeInviteCode } from '@/utils/invites';

export const PENDING_INVITE_CODE_STORAGE_KEY = 'momora.pendingInviteCode';

export async function getPendingInviteCode(): Promise<string | null> {
  try {
    const stored = await AsyncStorage.getItem(PENDING_INVITE_CODE_STORAGE_KEY);
    return stored ? stored : null;
  } catch {
    // Storage hiccups degrade to "no pending code" -- the user can always
    // type the code manually.
    return null;
  }
}

export async function setPendingInviteCode(code: string): Promise<void> {
  const normalized = normalizeInviteCode(code);

  if (!normalized) {
    return;
  }

  try {
    await AsyncStorage.setItem(PENDING_INVITE_CODE_STORAGE_KEY, normalized);
  } catch {
    // Best-effort: losing the prefill is annoying but never blocking.
  }
}

export async function clearPendingInviteCode(): Promise<void> {
  try {
    await AsyncStorage.removeItem(PENDING_INVITE_CODE_STORAGE_KEY);
  } catch {
    // Best-effort; a stale code is re-cleared on the next attempt.
  }
}
