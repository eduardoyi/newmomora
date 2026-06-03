export interface AuthError {
  message: string;
  code?: string;
}

export interface SignUpInput {
  email: string;
  password: string;
  name: string;
}

export interface SignUpResult {
  error: AuthError | null;
  needsEmailConfirmation: boolean;
}

export interface SignInInput {
  email: string;
  password: string;
}

export function mapAuthError(error: { message: string; code?: string }): AuthError {
  return {
    message: error.message,
    code: error.code,
  };
}

export function getDeviceTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone ?? 'UTC';
  } catch {
    return 'UTC';
  }
}
