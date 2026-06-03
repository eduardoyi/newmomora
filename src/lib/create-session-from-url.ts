import * as QueryParams from 'expo-auth-session/build/QueryParams';

import { supabase } from '@/lib/supabase';

export async function createSessionFromUrl(url: string): Promise<boolean> {
  const { params, errorCode } = QueryParams.getQueryParams(url);

  if (errorCode) {
    throw new Error(errorCode);
  }

  const accessToken = params.access_token;
  const refreshToken = params.refresh_token;

  if (!accessToken || !refreshToken) {
    return false;
  }

  const { error } = await supabase.auth.setSession({
    access_token: accessToken,
    refresh_token: refreshToken,
  });

  if (error) {
    throw error;
  }

  return true;
}

export function isAuthCallbackUrl(url: string): boolean {
  return url.includes('auth/callback') || url.includes('access_token=') || url.includes('type=signup');
}
