import { createClient, type SupabaseClient } from 'npm:@supabase/supabase-js@2';

const JWT_CLOCK_SKEW_RETRY_MS = 1_000;

async function isJwtClockSkewRejection(response: Response): Promise<boolean> {
  if (response.status !== 401) return false;
  try {
    const body = await response.clone().json();
    return body?.code === 'PGRST303' && /issued at future/i.test(String(body?.message ?? ''));
  } catch {
    return false;
  }
}

/**
 * PostgREST occasionally rejects the gateway-minted service JWT with
 * PGRST303 "JWT issued at future" (clock drift between Supabase hosts; seen
 * on ~1% of cron runs in Sentry). Auth fails before the query runs, so one
 * delayed resend is safe even for claim RPCs.
 */
export function createJwtSkewRetryFetch(
  baseFetch: typeof fetch = fetch,
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
): typeof fetch {
  return async (input, init) => {
    const response = await baseFetch(input, init);
    if (!(await isJwtClockSkewRejection(response))) return response;
    await sleep(JWT_CLOCK_SKEW_RETRY_MS);
    return baseFetch(input, init);
  };
}

export function createServiceClient(): SupabaseClient {
  const supabaseUrl = Deno.env.get('SUPABASE_URL');
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');

  if (!supabaseUrl || !serviceRoleKey) {
    throw new Error('Missing Supabase service role environment variables');
  }

  return createClient(supabaseUrl, serviceRoleKey, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
    global: {
      fetch: createJwtSkewRetryFetch(),
    },
  });
}

export function createUserClient(authHeader: string): SupabaseClient {
  const supabaseUrl = Deno.env.get('SUPABASE_URL');
  const supabaseAnonKey = Deno.env.get('SUPABASE_ANON_KEY');

  if (!supabaseUrl || !supabaseAnonKey) {
    throw new Error('Missing Supabase environment variables');
  }

  return createClient(supabaseUrl, supabaseAnonKey, {
    global: {
      headers: {
        Authorization: authHeader,
      },
    },
  });
}
