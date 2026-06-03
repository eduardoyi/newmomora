import { makeRedirectUri } from 'expo-auth-session';

const AUTH_CALLBACK_PATH = 'auth/callback';

/** Redirect URI passed to Supabase Auth (signup, magic link, password reset). */
export function getAuthRedirectUri(): string {
  return makeRedirectUri({
    scheme: 'momora',
    path: AUTH_CALLBACK_PATH,
  });
}

export const AUTH_CALLBACK_PATH_SEGMENT = AUTH_CALLBACK_PATH;
