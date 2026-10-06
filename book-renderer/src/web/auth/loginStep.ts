/**
 * Persists the shop LoginScreen's step in sessionStorage so a reload (typically
 * after switching to the Mail app to read the code) resumes at the code step
 * instead of the email form. Only the "code sent" step is stored; the email is
 * the user's own, in their own tab's sessionStorage (cleared with the tab).
 * Every access is wrapped: storage can be missing or throw (private windows).
 */

export type LoginStep = { kind: 'email' } | { kind: 'code'; email: string };

export const LOGIN_STEP_STORAGE_KEY = 'momora-shop-login-step';

interface StepStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export function loadLoginStep(storage: StepStorage | null | undefined): LoginStep {
  try {
    const raw = storage?.getItem(LOGIN_STEP_STORAGE_KEY);
    if (!raw) return { kind: 'email' };
    const parsed = JSON.parse(raw) as unknown;
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      (parsed as { kind?: unknown }).kind === 'code' &&
      typeof (parsed as { email?: unknown }).email === 'string' &&
      (parsed as { email: string }).email.length > 0
    ) {
      return { kind: 'code', email: (parsed as { email: string }).email };
    }
  } catch {
    // Fall through to the email step.
  }
  return { kind: 'email' };
}

export function saveLoginStep(storage: StepStorage | null | undefined, step: LoginStep): void {
  try {
    if (step.kind === 'code') {
      storage?.setItem(LOGIN_STEP_STORAGE_KEY, JSON.stringify({ kind: 'code', email: step.email }));
    } else {
      storage?.removeItem(LOGIN_STEP_STORAGE_KEY);
    }
  } catch {
    // Persistence is a convenience only.
  }
}

export function clearLoginStep(storage: StepStorage | null | undefined): void {
  saveLoginStep(storage, { kind: 'email' });
}

/** `window.sessionStorage`, or null when the accessor throws / is absent. */
export function getSessionStepStorage(): StepStorage | null {
  try {
    return typeof window !== 'undefined' ? window.sessionStorage : null;
  } catch {
    return null;
  }
}
