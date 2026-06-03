import AsyncStorage from '@react-native-async-storage/async-storage';
import { createClient } from '@supabase/supabase-js';

import type { Database } from '@/types/database';

const supabaseUrl = process.env.EXPO_PUBLIC_SUPABASE_URL;
const supabaseAnonKey = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY;

if (!supabaseUrl || !supabaseAnonKey) {
  throw new Error(
    'Missing EXPO_PUBLIC_SUPABASE_URL or EXPO_PUBLIC_SUPABASE_ANON_KEY. Copy .env.example to .env.local.',
  );
}

// During Expo static SSR the Metro web bundle runs in Node.js 20 where the
// global WebSocket is absent. Supabase's realtime-js logs a console.error when
// it detects this, which Expo captures as a blocking "static error" overlay.
// Providing a no-op stub satisfies the presence check; no real connection is
// ever attempted during SSR — only the client-side hydration uses the socket.
if (typeof globalThis.WebSocket === 'undefined') {
  // @ts-expect-error – stub satisfies realtime-js typeof check only
  globalThis.WebSocket = class NoopWebSocket {};
}

export const supabase = createClient<Database>(supabaseUrl, supabaseAnonKey, {
  auth: {
    storage: AsyncStorage,
    autoRefreshToken: true,
    persistSession: true,
    detectSessionInUrl: false,
  },
});
