import * as Linking from 'expo-linking';
import { useEffect } from 'react';

import { createSessionFromUrl, isAuthCallbackUrl } from '@/lib/create-session-from-url';

/** Handles Supabase auth deep links (email confirm, password reset). */
export function useAuthUrlHandler(): void {
  useEffect(() => {
    const handleUrl = async (url: string) => {
      if (!isAuthCallbackUrl(url)) {
        return;
      }

      try {
        await createSessionFromUrl(url);
      } catch {
        // Session errors surface on next sign-in attempt; avoid logging URL tokens.
      }
    };

    Linking.getInitialURL().then((url) => {
      if (url) {
        void handleUrl(url);
      }
    });

    const subscription = Linking.addEventListener('url', ({ url }) => {
      void handleUrl(url);
    });

    return () => subscription.remove();
  }, []);
}
