import { assert, assertEquals, assertThrows } from "jsr:@std/assert@1";

import {
  extractOtp,
  fixtureEmail,
  hardDeleteOwnerFixture,
  isLoopbackHttpUrl,
  resolveLocalSupabaseUrl,
} from "./onboarding-maestro-fixture.ts";

Deno.test("onboarding Maestro fixture accepts only explicit HTTP loopback endpoints", () => {
  assertEquals(isLoopbackHttpUrl("http://127.0.0.1:54321"), true);
  assertEquals(isLoopbackHttpUrl("http://localhost:54324"), false);
  assertEquals(isLoopbackHttpUrl("https://127.0.0.1:54321"), false);
  assertEquals(isLoopbackHttpUrl("http://127.0.0.1"), false);
  assertEquals(isLoopbackHttpUrl("https://project.supabase.co"), false);
  assertEquals(isLoopbackHttpUrl("http://192.168.1.10:54321"), false);
});

Deno.test("onboarding Maestro fixture requires the app and cleanup endpoints to be the same local project", () => {
  assertEquals(
    resolveLocalSupabaseUrl(
      "http://127.0.0.1:54321/",
      "http://127.0.0.1:54321",
    ).origin,
    "http://127.0.0.1:54321",
  );
  assertThrows(
    () =>
      resolveLocalSupabaseUrl(
        "http://127.0.0.1:54321",
        "https://project.supabase.co",
      ),
    Error,
    "EXPO_PUBLIC_SUPABASE_URL must be an explicit http:// loopback URL",
  );
  assertThrows(
    () =>
      resolveLocalSupabaseUrl(
        "http://127.0.0.1:54321",
        "http://127.0.0.1:65432",
      ),
    Error,
    "must point to the same local Supabase project",
  );
});

Deno.test("onboarding Maestro fixture produces isolated synthetic addresses", () => {
  assertEquals(
    fixtureEmail("local-20260731", "owner"),
    "maestro-onb-local-20260731-owner@example.test",
  );
  assertEquals(
    fixtureEmail("local-20260731", "joiner"),
    "maestro-onb-local-20260731-joiner@example.test",
  );
});

Deno.test("onboarding Maestro fixture extracts only a six digit OTP", () => {
  assertEquals(
    extractOtp({ Text: "Your code is 123456. It expires soon." }),
    "123456",
  );
  assertEquals(extractOtp({ Text: "Use 12345 instead." }), null);
  assertEquals(extractOtp({ Text: "Use 1234567 instead." }), null);
});

Deno.test("owner image fixture cleanup uses the deletion-fence function instead of direct Auth deletion", async () => {
  const envNames = [
    "ONBOARDING_E2E_IMAGE_STACK",
    "R2_ENDPOINT",
    "CLOUDFLARE_ILLUSTRATION_WORKFLOW_URL",
    "CLOUDFLARE_PORTRAIT_WORKFLOW_URL",
    "CRON_SECRET",
    "MEMORY_ILLUSTRATION_BACKEND",
    "PORTRAIT_GENERATION_BACKEND",
    "SUPABASE_URL",
    "EXPO_PUBLIC_SUPABASE_URL",
  ] as const;
  const oldEnv = new Map(envNames.map((name) => [name, Deno.env.get(name)]));
  const originalFetch = globalThis.fetch;
  const calls: Array<{ path: string; method: string }> = [];

  for (
    const [name, value] of [
      ["ONBOARDING_E2E_IMAGE_STACK", "isolated-local"],
      ["R2_ENDPOINT", "http://127.0.0.1:9000"],
      [
        "CLOUDFLARE_ILLUSTRATION_WORKFLOW_URL",
        "http://127.0.0.1:8787/dispatch/memory",
      ],
      [
        "CLOUDFLARE_PORTRAIT_WORKFLOW_URL",
        "http://127.0.0.1:8787/dispatch/portrait",
      ],
      ["CRON_SECRET", "local-test-cron-secret"],
      ["MEMORY_ILLUSTRATION_BACKEND", "cloudflare"],
      ["PORTRAIT_GENERATION_BACKEND", "cloudflare"],
      ["SUPABASE_URL", "http://127.0.0.1:54321"],
      ["EXPO_PUBLIC_SUPABASE_URL", "http://127.0.0.1:54321"],
    ] as const
  ) {
    Deno.env.set(name, value);
  }

  globalThis.fetch = async (input, init) => {
    const url = new URL(
      input instanceof Request ? input.url : input.toString(),
    );
    const method = init?.method ??
      (input instanceof Request ? input.method : "GET");
    calls.push({ path: url.pathname, method });
    if (url.pathname === "/rest/v1/families") {
      return Response.json([{ id: "family-1" }]);
    }
    if (
      url.pathname === "/rest/v1/memory_illustration_jobs" ||
      url.pathname === "/rest/v1/portrait_generation_jobs"
    ) {
      return Response.json([]);
    }
    if (url.pathname === "/rest/v1/user_profiles") {
      return Response.json([]);
    }
    if (url.pathname === "/rest/v1/rpc/schedule_account_deletion") {
      return Response.json("operation-token");
    }
    if (url.pathname === "/functions/v1/hard-delete-expired-accounts") {
      return Response.json({ success: true, deletedCount: 1 });
    }
    if (url.pathname === "/auth/v1/admin/users") {
      return Response.json({ users: [] });
    }
    return new Response("unexpected request", { status: 500 });
  };

  try {
    await hardDeleteOwnerFixture(
      new URL("http://127.0.0.1:54321"),
      "local-service-role-key",
      "00000000-0000-4000-8000-000000000001",
      "maestro-onb-local-20260731-owner@example.test",
    );

    assertEquals(
      calls.map((call) => `${call.method} ${call.path}`),
      [
        "GET /rest/v1/families",
        "GET /rest/v1/memory_illustration_jobs",
        "GET /rest/v1/portrait_generation_jobs",
        "GET /rest/v1/user_profiles",
        "POST /rest/v1/rpc/schedule_account_deletion",
        "POST /functions/v1/hard-delete-expired-accounts",
        "GET /auth/v1/admin/users",
      ],
    );
    assert(
      !calls.some((call) =>
        call.path.includes("/auth/v1/admin/users/") && call.method === "DELETE"
      ),
    );
  } finally {
    globalThis.fetch = originalFetch;
    for (const name of envNames) {
      const value = oldEnv.get(name);
      if (value === undefined) Deno.env.delete(name);
      else Deno.env.set(name, value);
    }
  }
});
