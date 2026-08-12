import { assert, assertEquals } from "jsr:@std/assert@1";

import {
  DEMO_ENGAGEMENT_ACTORS,
  DEMO_ENGAGEMENT_MEMORY_COUNT,
  DEMO_MEMORY_ENGAGEMENT,
} from "./demo-engagement-spec.ts";
import { DEMO_MEMORIES } from "./demo-family-spec.ts";
import { DEMO_TOP_UP_MEMORIES } from "./demo-top-up-spec.ts";

Deno.test("engagement fixture covers every demo memory", () => {
  const expectedCount = DEMO_MEMORIES.length + DEMO_TOP_UP_MEMORIES.length;
  const slugs = DEMO_MEMORY_ENGAGEMENT.map((memory) => memory.memorySlug);
  const commentCounts = DEMO_MEMORY_ENGAGEMENT.map((memory) => memory.comments.length);
  assertEquals(DEMO_ENGAGEMENT_MEMORY_COUNT, expectedCount);
  assertEquals(DEMO_MEMORY_ENGAGEMENT.length, expectedCount);
  assertEquals(new Set(slugs).size, expectedCount);
  assert(commentCounts.every((count) => count >= 2 && count <= 6));
  assert(commentCounts.some((count) => count === 6));
  assert(commentCounts.some((count) => count === 5));
  assert(commentCounts.some((count) => count === 4));
  assert(commentCounts.some((count) => count === 3));
});

Deno.test("engagement actors are synthetic household viewers", () => {
  assertEquals(DEMO_ENGAGEMENT_ACTORS.length, 4);
  assert(
    DEMO_ENGAGEMENT_ACTORS.every((actor) =>
      actor.role === "viewer" &&
      actor.email.startsWith("hello+demo-engagement-") &&
      actor.email.endsWith("@usemomora.com")
    ),
  );
  assertEquals(
    new Set(DEMO_ENGAGEMENT_ACTORS.map((actor) => actor.slug)).size,
    DEMO_ENGAGEMENT_ACTORS.length,
  );
});

Deno.test("comments mix short reactions with specific casual replies", () => {
  const comments = DEMO_MEMORY_ENGAGEMENT.flatMap((memory) => memory.comments);
  assert(comments.some((comment) => comment.content.length <= 20));
  assert(comments.some((comment) => comment.content.length >= 50));
  assert(comments.every((comment) => !comment.content.includes("—")));
});
