export interface AuthError {
  message: string;
  code?: string;
}

export interface RequestSignInOtpResult {
  error: AuthError | null;
  /** True when the account doesn't exist (shouldCreateUser: false rejected it) — route to signup. */
  userNotFound: boolean;
}

export interface RequestSignUpOtpInput {
  name: string;
  email: string;
}

export interface VerifyOtpInput {
  email: string;
  token: string;
}

/** Password sign-in for the guarded dedicated reviewer account and dev/E2E accounts. */
export interface PasswordSignInInput {
  email: string;
  password: string;
}

export function mapAuthError(error: { message: string; code?: string }): AuthError {
  return {
    message: error.message,
    code: error.code,
  };
}

/**
 * True when signInWithOtp({ shouldCreateUser: false }) rejected the request because no
 * account exists for the email. Supabase's GoTrue server currently surfaces this as the
 * `otp_disabled` error code (message "Signups not allowed for otp") rather than a more
 * literal "not found" code — `user_not_found` is included defensively in case that changes.
 * The message check is a fallback for older/self-hosted GoTrue versions.
 */
export function isUserNotFoundOtpError(error: { code?: string; message?: string }): boolean {
  if (error.code === 'otp_disabled' || error.code === 'user_not_found') {
    return true;
  }

  return /signups?\s+not\s+allowed/i.test(error.message ?? '');
}

export function getDeviceTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone ?? 'UTC';
  } catch {
    return 'UTC';
  }
}
