import { assertEquals, assertMatch, assertThrows } from "jsr:@std/assert@1";
import {
  buildSeedancePrompt,
  demoMediaAssetKey,
  deterministicUuid,
  mediaContentType,
  mediaExtension,
  parseArgs,
  parseSeedanceRequestState,
  seedanceQueueDescriptor,
  seedanceQueueDescriptorFromSubmission,
  seedanceRequestStateKey,
  seedanceResultFailureMessage,
  shouldRun,
} from "./seed-demo-account.ts";

Deno.test("Seedance prompts identify illustrated references as wholly fictional without family names", () => {
  const prompt = buildSeedancePrompt(
    "@Image1 is a fictional baby. @Image2 is a fictional sibling.",
    2,
  );
  assertMatch(prompt, /photorealistic five-second vertical candid smartphone/);
  assertMatch(prompt, /original 2D storybook character artwork/);
  assertMatch(prompt, /entirely fictional/);
  assertMatch(prompt, /@Image1/);
  assertMatch(prompt, /@Image2/);
  for (
    const name of [
      "Nora",
      "Gabriel",
      "Maya",
      "Theo",
      "Ari",
      "Eunji",
      "Rafael",
      "Lucía",
    ]
  ) {
    assertEquals(prompt.includes(name), false);
  }
});

Deno.test("deterministicUuid is stable and UUIDv5-shaped", async () => {
  const first = await deterministicUuid("member", "Little Ada");
  const second = await deterministicUuid("member", "little-ada");
  assertEquals(first, second);
  assertMatch(
    first,
    /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
  );
});

Deno.test("seed args default to non-mutating dry-run", () => {
  const options = parseArgs([]);
  assertEquals(options.apply, false);
  assertEquals(options.phase, "all");
  assertEquals(options.only.size, 0);
});

Deno.test("seed args support phase and slug filters", () => {
  const options = parseArgs([
    "--apply",
    "--phase",
    "profiles",
    "--only",
    "Baby June",
  ]);
  assertEquals(options.apply, true);
  assertEquals(options.phase, "profiles");
  assertEquals(shouldRun(options, "baby-june", "profiles"), true);
  assertEquals(shouldRun(options, "baby-june", "memories"), false);
  assertEquals(shouldRun(options, "another", "profiles"), false);
});

Deno.test("seed args reject unsafe or malformed values", () => {
  assertThrows(() => parseArgs(["--phase", "everything"]));
  assertThrows(() => parseArgs(["--only"]));
  assertThrows(() => parseArgs(["--surprise"]));
});

Deno.test("media helpers keep generated keys and MIME types aligned", () => {
  assertEquals(mediaContentType("photo"), "image/jpeg");
  assertEquals(mediaExtension("photo"), "jpg");
  assertEquals(mediaContentType("video"), "video/mp4");
  assertEquals(mediaExtension("video"), "mp4");
  assertEquals(
    demoMediaAssetKey("user-id", "memory-id", "asset-id-preview", "photo"),
    "user-id/memories/memory-id/media/asset-id-preview.jpg",
  );
});

Deno.test("Seedance request state migrates legacy request IDs to the model-base queue routes", () => {
  assertEquals(
    seedanceRequestStateKey("user-id", "memory-id", "asset-id"),
    "user-id:memory-id:asset-id",
  );
  assertEquals(
    parseSeedanceRequestState(
      '{"version":1,"requests":{"fixture":"request-id"}}',
    ),
    {
      version: 2,
      requests: {
        fixture: seedanceQueueDescriptor("request-id"),
      },
    },
  );
  assertEquals(parseSeedanceRequestState("not json"), {
    version: 2,
    requests: {},
  });
});

Deno.test("Seedance request descriptors retain FAL submission routes without signed query data", () => {
  const descriptor = seedanceQueueDescriptorFromSubmission({
    request_id: "request-id",
    status_url:
      "https://queue.fal.run/bytedance/seedance-2.0/requests/request-id/status?signature=discard-me",
    response_url:
      "https://queue.fal.run/bytedance/seedance-2.0/requests/request-id",
  });
  assertEquals(descriptor, seedanceQueueDescriptor("request-id"));
  assertEquals(
    seedanceQueueDescriptorFromSubmission({
      request_id: "request-id",
      status_url: "https://example.test/status",
      response_url: "https://example.test/result",
    }),
    seedanceQueueDescriptor("request-id"),
  );
});

Deno.test("Seedance result errors mark content-policy responses as non-retryable", () => {
  assertEquals(
    seedanceResultFailureMessage(422),
    "Seedance result was rejected (422, non-retryable)",
  );
  assertEquals(
    seedanceResultFailureMessage(500),
    "Seedance result failed (500)",
  );
});
