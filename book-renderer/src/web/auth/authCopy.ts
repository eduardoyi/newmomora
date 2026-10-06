/**
 * Friendly copy for GoTrue auth errors on the shop's email-code login.
 *
 * Why the rate-limit message matters here: the app -> shop handoff's `redeem`
 * calls `auth.admin.generateLink`, which replaces any pending emailed sign-in
 * code and counts toward GoTrue's per-user send interval. A user who falls back
 * to the email code right after a handoff can therefore see "For security
 * purposes, you can only request this after N seconds."
 */

/** Seconds from GoTrue's "you can only request this after N seconds" message, else null. */
export function parseWaitSeconds(message: string): number | null {
  const match = /only request this after (\d+) seconds?/i.exec(message);
  if (!match) return null;
  const seconds = Number(match[1]);
  return Number.isFinite(seconds) && seconds > 0 ? seconds : null;
}

export interface FriendlyAuthError {
  message: string;
  /** When set, the form should wait this many seconds before another request. */
  waitSeconds: number | null;
}

export function friendlyAuthError(message: string): FriendlyAuthError {
  const waitSeconds = parseWaitSeconds(message);
  if (waitSeconds !== null) {
    return {
      message: `Please wait ${waitSeconds} second${waitSeconds === 1 ? '' : 's'}, then ask for a new code.`,
      waitSeconds,
    };
  }
  if (/rate limit/i.test(message)) {
    return { message: 'Too many attempts. Please wait a minute and try again.', waitSeconds: null };
  }
  return { message, waitSeconds: null };
}

export interface LoginCopy {
  title: string;
  hint: string;
}

/** Holiday card pages (`/c/<id>`) say "holiday card"; everything else keeps the Memory Book copy. */
export function loginCopyForPath(pathname: string): LoginCopy {
  if (/^\/c(\/|$)/.test(pathname)) {
    return {
      title: 'Sign in to your holiday card',
      hint: 'New to Momora? Create your family and start a holiday card from the Momora app first.',
    };
  }
  return {
    title: 'Sign in to your Memory Book',
    hint: 'New to Momora? Create your family and start a book from the Momora app first.',
  };
}
