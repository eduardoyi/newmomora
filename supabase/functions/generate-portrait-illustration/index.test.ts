import { assertEquals, assertExists } from "jsr:@std/assert@1";
import {
  getPortraitGenerationRequestIntent,
  handleGeneratePortraitIllustration,
  isFreshMatchingPortraitWorkflowJob,
  RETRIGGER_MAX_CANDIDATES,
  RETRIGGER_MIN_AGE_MS,
} from "./index.ts";

const USER_ID = "11111111-1111-4111-8111-111111111111";
const FAMILY_ID = "22222222-2222-4222-8222-222222222222";
const MEMBER_ID = "33333333-3333-4333-8333-333333333333";
const VERSION_ID = "44444444-4444-4444-8444-444444444444";

function authenticatedRequest(): Request {
  return new Request("http://localhost/generate-portrait-illustration", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ portraitVersionId: VERSION_ID }),
  });
}

function dependencies(role: "owner" | "manager" | "viewer", sourceKey: string) {
  const version = {
    id: VERSION_ID,
    family_id: FAMILY_ID,
    family_member_id: MEMBER_ID,
    reference_date: "2026-01-01",
    profile_picture_key: sourceKey,
    illustrated_profile_key: null,
    generation_output_key: null,
  };
  const member = { id: MEMBER_ID, family_id: FAMILY_ID };
  const client = {
    from(table: string) {
      const row = table === "family_member_portrait_versions"
        ? version
        : member;
      return {
        select: () => ({
          eq: () => ({
            maybeSingle: async () => ({ data: row, error: null }),
            eq: () => ({
              maybeSingle: async () => ({ data: row, error: null }),
            }),
          }),
        }),
      };
    },
  };
  return {
    getAuthenticatedUser: async () => ({ id: USER_ID }) as never,
    createServiceClient: () => client as never,
    getCallerFamilyRole: async () => role,
  };
}

Deno.test("generate-portrait-illustration rejects unauthenticated requests", async () => {
  const response = await handleGeneratePortraitIllustration(
    new Request("http://localhost/generate-portrait-illustration", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        portraitVersionId: "22222222-2222-4222-8222-222222222222",
      }),
    }),
  );

  assertEquals(response.status, 401);
});

Deno.test("portrait workflow freshness expires exactly at the 5:30 recovery boundary", () => {
  const now = Date.parse("2026-07-22T12:00:00Z");
  const attemptId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  assertEquals(isFreshMatchingPortraitWorkflowJob({
    versionAttemptId: attemptId,
    versionStartedAt: new Date(now - 5 * 60_000 - 29_999).toISOString(),
    jobAttemptId: attemptId,
    jobStartedAt: new Date(now - 5 * 60_000 - 29_999).toISOString(),
    now,
  }), true);
  assertEquals(isFreshMatchingPortraitWorkflowJob({
    versionAttemptId: attemptId,
    versionStartedAt: new Date(now - 5 * 60_000 - 30_000).toISOString(),
    jobAttemptId: attemptId,
    jobStartedAt: new Date(now - 5 * 60_000 - 30_000).toISOString(),
    now,
  }), false);
});

Deno.test("portrait workflow classifies initial, recovery, and manual-regenerate intent", () => {
  const now = Date.parse("2026-07-22T12:00:00Z");
  const base = {
    illustratedProfileKey: null,
    illustratedProfileStatus: "pending",
    generationToken: null,
    createdAt: new Date(now - 60_000).toISOString(),
    now,
  };
  assertEquals(getPortraitGenerationRequestIntent(base), "initial");
  assertEquals(getPortraitGenerationRequestIntent({
    ...base,
    createdAt: new Date(now - 3 * 60_000).toISOString(),
  }), "recovery");
  assertEquals(getPortraitGenerationRequestIntent({
    ...base,
    illustratedProfileStatus: "failed",
  }), "recovery");
  assertEquals(getPortraitGenerationRequestIntent({
    ...base,
    illustratedProfileKey: "retained.webp",
    illustratedProfileStatus: "ready",
  }), "manual_regenerate");
});

async function withCloudflarePortraitEnv(run: () => Promise<void>): Promise<void> {
  const entries = [
    ["PORTRAIT_GENERATION_BACKEND", "cloudflare"],
    ["CLOUDFLARE_PORTRAIT_WORKFLOW_URL", "https://portrait-worker.test/dispatch/portrait"],
    ["CLOUDFLARE_PORTRAIT_DISPATCH_SECRET", "portrait-dispatch-test-secret"],
  ] as const;
  const previous = new Map(entries.map(([key]) => [key, Deno.env.get(key)]));
  for (const [key, value] of entries) Deno.env.set(key, value);
  try {
    await run();
  } finally {
    for (const [key] of entries) {
      const value = previous.get(key);
      if (value === undefined) Deno.env.delete(key);
      else Deno.env.set(key, value);
    }
  }
}

function cloudflarePortraitClient(input: {
  activeJob?: { id: string; attempt_id: string; started_at: string } | null;
  version?: Record<string, unknown>;
}) {
  const sourceKey = `${USER_ID}/family/${MEMBER_ID}/portraits/${VERSION_ID}/photo.jpg`;
  const version = {
    id: VERSION_ID,
    family_id: FAMILY_ID,
    family_member_id: MEMBER_ID,
    reference_date: "2026-07-20",
    profile_picture_key: sourceKey,
    illustrated_profile_key: null,
    illustrated_profile_status: "pending",
    generation_token: null,
    generation_started_at: null,
    generation_output_key: null,
    created_at: new Date().toISOString(),
    ...input.version,
  };
  const inserted: Record<string, unknown>[] = [];
  const rpcCalls: string[] = [];
  const basicBuilder = (row: unknown) => {
    const builder = {
      select: () => builder,
      eq: () => builder,
      maybeSingle: async () => ({ data: row, error: null }),
    };
    return builder;
  };
  const client = {
    from(table: string) {
      if (table === "family_member_portrait_versions") return basicBuilder(version);
      if (table === "family_members") {
        return basicBuilder({
          id: MEMBER_ID,
          family_id: FAMILY_ID,
          name: "Lila",
          date_of_birth: "2024-01-01",
          gender: null,
          additional_info: null,
        });
      }
      if (table === "families") return basicBuilder({ illustration_style: "default" });
      if (table === "portrait_generation_jobs") {
        const query = {
          select: () => query,
          eq: () => query,
          in: () => query,
          order: () => query,
          limit: () => query,
          maybeSingle: async () => ({ data: input.activeJob ?? null, error: null }),
        };
        return {
          ...query,
          insert: async (payload: Record<string, unknown>) => {
            inserted.push(payload);
            return { error: null };
          },
        };
      }
      throw new Error(`Unexpected table ${table}`);
    },
    rpc: async (name: string) => {
      rpcCalls.push(name);
      if (name === "claim_family_member_portrait_generation") return { data: version, error: null };
      return { data: 1, error: null };
    },
  };
  return { client, inserted, rpcCalls, version };
}

Deno.test("portrait Cloudflare dispatcher reuses and re-dispatches a fresh matching job", async () => {
  await withCloudflarePortraitEnv(async () => {
    const attemptId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const startedAt = new Date(Date.now() - 30_000).toISOString();
    const mock = cloudflarePortraitClient({
      activeJob: { id: attemptId, attempt_id: attemptId, started_at: startedAt },
      version: { generation_token: attemptId, generation_started_at: startedAt },
    });
    const dispatchBodies: string[] = [];
    const response = await handleGeneratePortraitIllustration(authenticatedRequest(), {
      getAuthenticatedUser: async () => ({ id: USER_ID }) as never,
      getCallerFamilyRole: async () => "manager",
      createServiceClient: () => mock.client as never,
      fetch: (async (_input, init) => {
        dispatchBodies.push(String(init?.body));
        return new Response(null, { status: 202 });
      }) as typeof fetch,
    });
    assertEquals(response.status, 202);
    assertEquals(await response.json(), { success: true, queued: true });
    assertEquals(JSON.parse(dispatchBodies[0]), { jobId: attemptId });
    assertEquals(mock.inserted.length, 0);
    assertEquals(mock.rpcCalls.length, 0);
  });
});

Deno.test("portrait Cloudflare dispatch ambiguity retains the durable job and a later recovery reuses its exact ID", async () => {
  await withCloudflarePortraitEnv(async () => {
    const initial = cloudflarePortraitClient({});
    const firstResponse = await handleGeneratePortraitIllustration(authenticatedRequest(), {
      getAuthenticatedUser: async () => ({ id: USER_ID }) as never,
      getCallerFamilyRole: async () => "manager",
      createServiceClient: () => initial.client as never,
      fetch: (async () => new Response(null, { status: 503 })) as typeof fetch,
    });

    assertEquals(firstResponse.status, 202);
    assertEquals(await firstResponse.json(), { success: true, queued: true });
    assertEquals(initial.inserted.length, 1);
    assertEquals(initial.rpcCalls, [
      "claim_family_member_portrait_generation",
      "supersede_portrait_generation_workflow_jobs",
    ]);

    const jobId = initial.inserted[0].id as string;
    const startedAt = initial.inserted[0].started_at as string;
    const recovery = cloudflarePortraitClient({
      activeJob: { id: jobId, attempt_id: jobId, started_at: startedAt },
      version: { generation_token: jobId, generation_started_at: startedAt },
    });
    const redispatchBodies: string[] = [];
    const recoveryResponse = await handleGeneratePortraitIllustration(authenticatedRequest(), {
      getAuthenticatedUser: async () => ({ id: USER_ID }) as never,
      getCallerFamilyRole: async () => "manager",
      createServiceClient: () => recovery.client as never,
      fetch: (async (_input, init) => {
        redispatchBodies.push(String(init?.body));
        return new Response(null, { status: 202 });
      }) as typeof fetch,
    });

    assertEquals(recoveryResponse.status, 202);
    assertEquals(JSON.parse(redispatchBodies[0]), { jobId });
    assertEquals(recovery.inserted.length, 0);
    assertEquals(recovery.rpcCalls.length, 0);
  });
});

Deno.test("portrait Cloudflare dispatcher classifies reclaimed work and cleans only its stale output", async () => {
  await withCloudflarePortraitEnv(async () => {
    const mock = cloudflarePortraitClient({
      version: {
        generation_token: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
        generation_started_at: new Date(Date.now() - 6 * 60_000).toISOString(),
        generation_output_key: "stale/attempt.webp",
        created_at: new Date(Date.now() - 4 * 60_000).toISOString(),
      },
    });
    const deleted: string[] = [];
    const response = await handleGeneratePortraitIllustration(authenticatedRequest(), {
      getAuthenticatedUser: async () => ({ id: USER_ID }) as never,
      getCallerFamilyRole: async () => "manager",
      createServiceClient: () => mock.client as never,
      deleteObject: async (key) => { deleted.push(key); },
      fetch: (async () => new Response(null, { status: 202 })) as typeof fetch,
    });
    assertEquals(response.status, 202);
    assertEquals(mock.inserted[0].request_intent, "recovery");
    assertEquals(deleted, ["stale/attempt.webp"]);
    assertEquals(mock.inserted[0].old_portrait_key, null);
  });
});

Deno.test("generate-portrait-illustration rejects unsupported methods", async () => {
  const response = await handleGeneratePortraitIllustration(
    new Request("http://localhost/generate-portrait-illustration", {
      method: "GET",
    }),
  );

  assertEquals(response.status, 405);
});

Deno.test("generate-portrait-illustration rejects viewers before loading the source image", async () => {
  const response = await handleGeneratePortraitIllustration(
    authenticatedRequest(),
    dependencies(
      "viewer",
      `${USER_ID}/family/${MEMBER_ID}/portraits/${VERSION_ID}/photo.jpg`,
    ),
  );
  assertEquals(response.status, 403);
});

Deno.test("generate-portrait-illustration rejects a mutable or mismatched source key", async () => {
  const response = await handleGeneratePortraitIllustration(
    authenticatedRequest(),
    dependencies("manager", `${USER_ID}/family/${MEMBER_ID}/photo.webp`),
  );
  assertEquals(response.status, 400);
  assertEquals((await response.json()).code, "validation_error");
});

Deno.test("generate-portrait-illustration fails the claimed attempt before its runtime deadline", async () => {
  const sourceKey =
    `${USER_ID}/family/${MEMBER_ID}/portraits/${VERSION_ID}/photo.jpg`;
  const rpcCalls: string[] = [];
  const rows: Record<string, Record<string, unknown>> = {
    family_member_portrait_versions: {
      id: VERSION_ID,
      family_id: FAMILY_ID,
      family_member_id: MEMBER_ID,
      reference_date: "2025-01-01",
      profile_picture_key: sourceKey,
      illustrated_profile_key: null,
      generation_output_key: null,
    },
    family_members: {
      id: MEMBER_ID,
      family_id: FAMILY_ID,
      name: "Lila",
      date_of_birth: "2024-01-01",
      gender: null,
      additional_info: null,
    },
    families: { illustration_style: "default" },
  };
  const client = {
    from(table: string) {
      const builder = {
        select: () => builder,
        eq: () => builder,
        maybeSingle: async () => ({ data: rows[table], error: null }),
      };
      return builder;
    },
    rpc: async (name: string) => {
      rpcCalls.push(name);
      return { data: rows.family_member_portrait_versions, error: null };
    },
  };

  let backgroundTask: Promise<void> | undefined;
  const response = await handleGeneratePortraitIllustration(
    authenticatedRequest(),
    {
      getAuthenticatedUser: async () => ({ id: USER_ID }) as never,
      createServiceClient: () => client as never,
      getCallerFamilyRole: async () => "manager",
      getObjectBytes: async () => new Uint8Array([1, 2, 3]),
      capImageMaxEdge: async (bytes, _maxEdge, contentType) => ({
        bytes,
        contentType,
        extension: "jpg",
      }),
      loadStyleReferenceBytes: async () => null,
      editImageWithReferences: async (_prompt, _references, options) => {
        await new Promise<void>((_resolve, reject) => {
          const rejectAsAborted = () =>
            reject(new DOMException("Aborted", "AbortError"));
          if (options?.signal?.aborted) {
            rejectAsAborted();
            return;
          }
          options?.signal?.addEventListener("abort", rejectAsAborted, {
            once: true,
          });
        });
        return new Uint8Array();
      },
      putObjectBytes: async () => undefined,
      deleteObject: async () => undefined,
      generationTimeoutMs: 1,
      waitUntil: (task) => {
        backgroundTask = task;
      },
    },
  );

  assertEquals(response.status, 200);
  assertEquals(await response.json(), { success: true, queued: true });
  await backgroundTask;
  assertEquals(rpcCalls, [
    "claim_family_member_portrait_generation",
    "fail_family_member_portrait_generation",
  ]);
});

// -- Retrigger of dependent pending illustrations --------------------------

interface MemoriesQueryCall {
  eqCalls: Array<[string, unknown]>;
  ltCall?: [string, unknown];
  orderCall?: [string, unknown];
  limitCall?: number;
}

function createMemoriesBuilder(
  candidates: Array<{ id: string }>,
  call: MemoriesQueryCall,
) {
  const builder = {
    select: () => builder,
    eq: (column: string, value: unknown) => {
      call.eqCalls.push([column, value]);
      return builder;
    },
    lt: (column: string, value: unknown) => {
      call.ltCall = [column, value];
      return builder;
    },
    order: (column: string, options: unknown) => {
      call.orderCall = [column, options];
      return builder;
    },
    limit: (count: number) => {
      call.limitCall = count;
      return { data: candidates, error: null };
    },
  };
  return builder;
}

function createTaggedMemoryBuilder(
  candidates: Array<{ id: string }>,
  call: MemoriesQueryCall,
) {
  const builder = {
    select: () => builder,
    eq: (column: string, value: unknown) => {
      call.eqCalls.push([column, value]);
      return builder;
    },
    lt: (column: string, value: unknown) => {
      call.ltCall = [column, value];
      return builder;
    },
    limit: (count: number) => {
      call.limitCall = count;
      return { data: candidates.map((candidate) => ({ memory_id: candidate.id })), error: null };
    },
  };
  return builder;
}

function retriggerRequest(): Request {
  return new Request("http://localhost/generate-portrait-illustration", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: "Bearer test-jwt",
    },
    body: JSON.stringify({ portraitVersionId: VERSION_ID }),
  });
}

function buildRetriggerClient(
  memoriesCandidates: Array<{ id: string }>,
  memoriesCall: MemoriesQueryCall,
  options: {
    finishError?: boolean;
    reReadCommitted?:
      | { illustrated_profile_key: string | null; generation_token: string | null }
      | null;
  } = {},
) {
  const sourceKey =
    `${USER_ID}/family/${MEMBER_ID}/portraits/${VERSION_ID}/photo.jpg`;
  const version = {
    id: VERSION_ID,
    family_id: FAMILY_ID,
    family_member_id: MEMBER_ID,
    reference_date: "2025-01-01",
    profile_picture_key: sourceKey,
    illustrated_profile_key: null,
    generation_output_key: null,
  };
  const rows: Record<string, Record<string, unknown>> = {
    family_members: {
      id: MEMBER_ID,
      family_id: FAMILY_ID,
      name: "Lila",
      date_of_birth: "2024-01-01",
      gender: null,
      additional_info: null,
    },
    families: { illustration_style: "default" },
  };

  return {
    from(table: string) {
      if (table === "memory_family_members") {
        return createTaggedMemoryBuilder(memoriesCandidates, memoriesCall);
      }
      if (table === "memories") {
        return createMemoriesBuilder(memoriesCandidates, memoriesCall);
      }
      if (table === "family_member_portrait_versions") {
        return {
          select: (columns: string) => ({
            eq: () => ({
              maybeSingle: async () => {
                if (columns.includes("illustrated_profile_key")) {
                  return {
                    data: options.reReadCommitted ?? null,
                    error: null,
                  };
                }
                return { data: version, error: null };
              },
            }),
          }),
        };
      }
      const builder = {
        select: () => builder,
        eq: () => builder,
        maybeSingle: async () => ({ data: rows[table], error: null }),
      };
      return builder;
    },
    rpc: async (name: string) => {
      if (name === "claim_family_member_portrait_generation") {
        return { data: version, error: null };
      }
      if (name === "finish_family_member_portrait_generation") {
        return options.finishError
          ? { data: null, error: { message: "finish failed" } }
          : { data: version, error: null };
      }
      if (name === "fail_family_member_portrait_generation") {
        return { data: null, error: null };
      }
      throw new Error(`Unexpected rpc call: ${name}`);
    },
  };
}

function baseRetriggerDependencies() {
  return {
    getAuthenticatedUser: async () => ({ id: USER_ID }) as never,
    getCallerFamilyRole: async () => "manager" as const,
    getObjectBytes: async () => new Uint8Array([1, 2, 3]),
    capImageMaxEdge: async (
      bytes: Uint8Array,
      _maxEdge: number,
      contentType: string,
    ) => ({ bytes, contentType, extension: "jpg" }),
    loadStyleReferenceBytes: async () => ({
      bytes: new Uint8Array([4, 5, 6]),
      contentType: "image/png",
    }),
    editImageWithReferences: async () => new Uint8Array([9, 9, 9]),
    putObjectBytes: async () => undefined,
    deleteObject: async () => undefined,
    generationTimeoutMs: 5_000,
  };
}

const RETRIGGER_TEST_ENV = {
  SUPABASE_URL: "https://supabase.test",
  SUPABASE_ANON_KEY: "test-anon-key",
} as const;

async function withRetriggerEnv(run: () => Promise<void>): Promise<void> {
  const original = new Map(
    Object.keys(RETRIGGER_TEST_ENV).map((key) => [key, Deno.env.get(key)]),
  );
  for (const [key, value] of Object.entries(RETRIGGER_TEST_ENV)) {
    Deno.env.set(key, value);
  }
  try {
    await run();
  } finally {
    for (const [key, value] of original) {
      if (value === undefined) {
        Deno.env.delete(key);
      } else {
        Deno.env.set(key, value);
      }
    }
  }
}

Deno.test(
  "generate-portrait-illustration retriggers pending illustrations after a successful commit",
  async () => {
    await withRetriggerEnv(async () => {
      const memoriesCall: MemoriesQueryCall = { eqCalls: [] };
      const candidates = [{ id: "aaaaaaaa-0000-4000-8000-000000000001" }, {
        id: "aaaaaaaa-0000-4000-8000-000000000002",
      }];
      const client = buildRetriggerClient(candidates, memoriesCall);

      const fetchCalls: Array<
        { url: string; headers: HeadersInit; body: string }
      > = [];
      let backgroundTask: Promise<void> | undefined;

      const response = await handleGeneratePortraitIllustration(
        retriggerRequest(),
        {
          ...baseRetriggerDependencies(),
          createServiceClient: () => client as never,
          fetch: (async (input, init) => {
            fetchCalls.push({
              url: String(input),
              headers: (init?.headers ?? {}) as HeadersInit,
              body: String(init?.body ?? ""),
            });
            return new Response(null, { status: 200 });
          }) as typeof fetch,
          waitUntil: (task) => {
            backgroundTask = task;
          },
        },
      );

      assertEquals(response.status, 200);
      await backgroundTask;

      assertEquals(fetchCalls.length, candidates.length);
      for (const [index, call] of fetchCalls.entries()) {
        assertEquals(
          call.url,
          "https://supabase.test/functions/v1/generate-illustration",
        );
        assertEquals(
          (call.headers as Record<string, string>).Authorization,
          "Bearer test-jwt",
        );
        assertEquals(JSON.parse(call.body), {
          memoryId: candidates[index].id,
          requestIntent: "recovery",
        });
      }

      assertEquals(
        memoriesCall.eqCalls.some(([column, value]) =>
          column === "family_member_id" && value === MEMBER_ID
        ),
        true,
      );
      assertEquals(
        memoriesCall.eqCalls.some(([column, value]) =>
          column === "memories.family_id" && value === FAMILY_ID
        ),
        true,
      );
      assertEquals(
        memoriesCall.eqCalls.some(([column, value]) =>
          column === "memories.memory_type" && value === "text_illustration"
        ),
        true,
      );
      assertEquals(
        memoriesCall.eqCalls.some(([column, value]) =>
          column === "memories.illustration_status" && value === "pending"
        ),
        true,
      );

      assertExists(memoriesCall.ltCall);
      assertEquals(memoriesCall.ltCall?.[0], "memories.created_at");
      const threshold = new Date(String(memoriesCall.ltCall?.[1])).getTime();
      // The threshold must exclude memories younger than RETRIGGER_MIN_AGE_MS.
      const expectedThreshold = Date.now() - RETRIGGER_MIN_AGE_MS;
      assertEquals(Math.abs(threshold - expectedThreshold) < 5_000, true);

      assertEquals(memoriesCall.limitCall, RETRIGGER_MAX_CANDIDATES);
    });
  },
);

Deno.test(
  "generate-portrait-illustration retriggers pending illustrations after a generation failure",
  async () => {
    await withRetriggerEnv(async () => {
      const memoriesCall: MemoriesQueryCall = { eqCalls: [] };
      const candidates = [{ id: "bbbbbbbb-0000-4000-8000-000000000001" }];
      const client = buildRetriggerClient(candidates, memoriesCall);

      const fetchCalls: string[] = [];
      let backgroundTask: Promise<void> | undefined;

      const response = await handleGeneratePortraitIllustration(
        retriggerRequest(),
        {
          ...baseRetriggerDependencies(),
          createServiceClient: () => client as never,
          // The reference-aware provider fails to exercise the catch path.
          editImageWithReferences: async () => {
            throw new Error("provider failed");
          },
          fetch: (async (input) => {
            fetchCalls.push(String(input));
            return new Response(null, { status: 200 });
          }) as typeof fetch,
          waitUntil: (task) => {
            backgroundTask = task;
          },
        },
      );

      assertEquals(response.status, 200);
      await backgroundTask;

      assertEquals(fetchCalls.length, candidates.length);
    });
  },
);

Deno.test(
  "generate-portrait-illustration retriggers pending illustrations when the finish claim is lost",
  async () => {
    await withRetriggerEnv(async () => {
      const memoriesCall: MemoriesQueryCall = { eqCalls: [] };
      const candidates = [{ id: "cccccccc-0000-4000-8000-000000000001" }];
      const client = buildRetriggerClient(candidates, memoriesCall, {
        finishError: true,
        // Re-read shows a different attempt committed (claim lost).
        reReadCommitted: {
          illustrated_profile_key: "someone-elses-attempt.webp",
          generation_token: "another-token",
        },
      });

      const fetchCalls: string[] = [];
      let backgroundTask: Promise<void> | undefined;

      const response = await handleGeneratePortraitIllustration(
        retriggerRequest(),
        {
          ...baseRetriggerDependencies(),
          createServiceClient: () => client as never,
          fetch: (async (input) => {
            fetchCalls.push(String(input));
            return new Response(null, { status: 200 });
          }) as typeof fetch,
          waitUntil: (task) => {
            backgroundTask = task;
          },
        },
      );

      assertEquals(response.status, 200);
      await backgroundTask;

      assertEquals(fetchCalls.length, candidates.length);
    });
  },
);

Deno.test(
  "generate-portrait-illustration swallows a retrigger fetch rejection without breaking commit",
  async () => {
    await withRetriggerEnv(async () => {
      const memoriesCall: MemoriesQueryCall = { eqCalls: [] };
      const candidates = [{ id: "dddddddd-0000-4000-8000-000000000001" }];
      const client = buildRetriggerClient(candidates, memoriesCall);

      let putCalls = 0;
      let backgroundTask: Promise<void> | undefined;
      let thrown: unknown;

      const response = await handleGeneratePortraitIllustration(
        retriggerRequest(),
        {
          ...baseRetriggerDependencies(),
          createServiceClient: () => client as never,
          putObjectBytes: async () => {
            putCalls += 1;
          },
          fetch: (async () => {
            throw new Error("network unreachable");
          }) as unknown as typeof fetch,
          waitUntil: (task) => {
            backgroundTask = task.catch((error) => {
              thrown = error;
            });
          },
        },
      );

      assertEquals(response.status, 200);
      await backgroundTask;

      assertEquals(thrown, undefined);
      assertEquals(putCalls, 1);
    });
  },
);

Deno.test(
  "generate-portrait-illustration drains legacy retrigger responses without logging candidate details",
  async () => {
    await withRetriggerEnv(async () => {
      const memoriesCall: MemoriesQueryCall = { eqCalls: [] };
      const candidates = [
        { id: "eeeeeeee-0000-4000-8000-000000000001" },
        { id: "eeeeeeee-0000-4000-8000-000000000002" },
      ];
      const client = buildRetriggerClient(candidates, memoriesCall);

      let backgroundTask: Promise<void> | undefined;
      const bodyConsumed: boolean[] = [];
      const errorLogs: unknown[][] = [];
      const originalConsoleError = console.error;
      console.error = (...args: unknown[]) => {
        errorLogs.push(args);
      };

      try {
        const response = await handleGeneratePortraitIllustration(
          retriggerRequest(),
          {
            ...baseRetriggerDependencies(),
            createServiceClient: () => client as never,
            fetch: (async () => {
              const index = bodyConsumed.length;
              const status = index === 0 ? 500 : 409;
              const mockResponse = new Response(
                JSON.stringify({
                  code: index === 0 ? "GENERATION_FAILED" : "GENERATION_IN_PROGRESS",
                }),
                { status },
              );
              bodyConsumed.push(false);
              const originalText = mockResponse.text.bind(mockResponse);
              mockResponse.text = async () => {
                bodyConsumed[index] = true;
                return originalText();
              };
              return mockResponse;
            }) as typeof fetch,
            waitUntil: (task) => {
              backgroundTask = task;
            },
          },
        );

        assertEquals(response.status, 200);
        await backgroundTask;
      } finally {
        console.error = originalConsoleError;
      }

      // Both response bodies must be consumed regardless of status.
      assertEquals(bodyConsumed, [true, true]);

      const retriggerStatusLogs = errorLogs.filter(([message]) =>
        message === "generate-portrait-illustration retrigger returned an error status"
      );
      assertEquals(retriggerStatusLogs.length, 0);
    });
  },
);
