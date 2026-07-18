import { assertEquals } from "jsr:@std/assert@1";
import { handleGeneratePortraitIllustration } from "./index.ts";

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
      generateImage: async (_prompt, options) => {
        assertEquals(options?.signal?.aborted, true);
        throw new DOMException("Aborted", "AbortError");
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
