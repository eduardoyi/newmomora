import { assertEquals, assert } from "jsr:@std/assert@1";
import { createClient } from "npm:@supabase/supabase-js@2";

const localUrl = Deno.env.get("SUPABASE_URL") ?? Deno.env.get("API_URL");
const anonKey = Deno.env.get("SUPABASE_ANON_KEY")
  ?? Deno.env.get("ANON_KEY")
  ?? Deno.env.get("SUPABASE_PUBLISHABLE_KEY")
  ?? Deno.env.get("PUBLISHABLE_KEY");
const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")
  ?? Deno.env.get("SERVICE_ROLE_KEY")
  ?? Deno.env.get("SUPABASE_SECRET_KEY")
  ?? Deno.env.get("SECRET_KEY");
const shouldRun = Deno.env.get("ONBOARDING_VOICE_CONCURRENCY_TEST") === "1";

function isLoopbackSupabaseUrl(value: string | undefined): value is string {
  return value !== undefined && /^http:\/\/127\.0\.0\.1:\d+$/.test(value);
}

Deno.test({
  name: "three simultaneous anonymous reservations admit exactly two durable onboarding voice requests",
  ignore: !shouldRun,
  async fn() {
    if (!isLoopbackSupabaseUrl(localUrl) || !anonKey || !serviceRoleKey) {
      throw new Error(
        "ONBOARDING_VOICE_CONCURRENCY_TEST=1 requires loopback SUPABASE_URL/API_URL plus anonymous and service-role keys.",
      );
    }

    const anonymousClient = createClient(localUrl, anonKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const adminClient = createClient(localUrl, serviceRoleKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const { data: anonymousSession, error: anonymousError } = await anonymousClient.auth.signInAnonymously();
    if (anonymousError || !anonymousSession.user) {
      throw new Error(`Could not create local anonymous fixture: ${anonymousError?.message ?? "missing user"}`);
    }
    const actorUserId = anonymousSession.user.id;

    try {
      // These are three independent PostgREST RPC requests issued together;
      // they race on the same empty request set, exercising the advisory lock
      // rather than simulating three calls in one SQL session.
      const outcomes = await Promise.all(
        Array.from({ length: 3 }, async () => {
          const { data, error } = await adminClient.rpc("reserve_onboarding_voice_attempt", {
            p_actor_user_id: actorUserId,
          });
          if (error) throw new Error(`reservation RPC failed: ${error.message}`);
          assert(Array.isArray(data) && data.length === 1, "reservation must return exactly one typed row");
          return data[0] as { reserved: boolean; request_id: string | null; attempts_used: number };
        }),
      );

      const reserved = outcomes.filter((outcome) => outcome.reserved);
      const denied = outcomes.filter((outcome) => !outcome.reserved);
      assertEquals(reserved.length, 2);
      assertEquals(denied.length, 1);
      assertEquals(denied[0].request_id, null);
      assertEquals(
        reserved.map((outcome) => outcome.attempts_used).sort((left, right) => left - right),
        [1, 2],
      );
      assertEquals(denied[0].attempts_used, 2);
      assert(reserved.every((outcome) => typeof outcome.request_id === "string"), "both admitted calls receive request IDs");
      assert(
        reserved[0].request_id !== reserved[1].request_id,
        "the two admitted INSERT ... RETURNING results have distinct durable request IDs",
      );
    } finally {
      // The request table is intentionally unreadable and unwritable through
      // PostgREST, including service API keys. Auth cleanup deidentifies any
      // local raw requests; retention removes them on its normal schedule.
      await adminClient.auth.admin.deleteUser(actorUserId);
    }
  },
});
