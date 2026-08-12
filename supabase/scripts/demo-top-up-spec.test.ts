import { assert, assertEquals } from "jsr:@std/assert@1";

import {
  DEMO_BASELINE_PORTRAIT_DATE,
  DEMO_EXISTING_MEMORY_DATE_UPDATES,
  DEMO_TOP_UP_CURRENT_DATE,
  DEMO_TOP_UP_MEMORIES,
  DEMO_TOP_UP_PORTRAITS,
} from "./demo-top-up-spec.ts";
import { DEMO_FAMILY_MEMBERS } from "./demo-family-spec.ts";

function countBy<T extends string>(values: readonly T[]): Map<T, number> {
  const counts = new Map<T, number>();
  for (const value of values) {
    counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  return counts;
}

Deno.test("demo top-up keeps the age-scaled historical portrait plan", () => {
  assertEquals(DEMO_TOP_UP_PORTRAITS.length, 10);
  assertEquals(
    countBy(DEMO_TOP_UP_PORTRAITS.map((portrait) => portrait.memberSlug)),
    new Map([
      ["maya-kim-ortiz", 5],
      ["theo-kim-ortiz", 3],
      ["ari-kim-ortiz", 2],
    ]),
  );
  assert(
    DEMO_TOP_UP_PORTRAITS.every((portrait) =>
      portrait.referenceDate < DEMO_BASELINE_PORTRAIT_DATE
    ),
  );
  assertEquals(
    new Set(DEMO_TOP_UP_PORTRAITS.map((portrait) => portrait.slug)).size,
    DEMO_TOP_UP_PORTRAITS.length,
  );
  for (const memberSlug of ["maya-kim-ortiz", "theo-kim-ortiz", "ari-kim-ortiz"]) {
    const wardrobes = DEMO_TOP_UP_PORTRAITS
      .filter((portrait) => portrait.memberSlug === memberSlug)
      .map((portrait) => portrait.wardrobe);
    assertEquals(new Set(wardrobes).size, wardrobes.length);
  }
});

Deno.test("demo top-up has a current gap mix and a Looking Back archive bridge", () => {
  const recent = DEMO_TOP_UP_MEMORIES.filter((memory) =>
    memory.memoryDate >= "2026-07-19" &&
    memory.memoryDate <= DEMO_TOP_UP_CURRENT_DATE
  );
  const archive = DEMO_TOP_UP_MEMORIES.filter((memory) =>
    memory.memoryDate <= "2026-05-13"
  );
  assertEquals(DEMO_TOP_UP_MEMORIES.length, 36);
  assertEquals(recent.length, 12);
  assertEquals(archive.length, 24);
  assertEquals(
    countBy(DEMO_TOP_UP_MEMORIES.map((memory) => memory.memoryType)),
    new Map([
      ["media", 20],
      ["text_illustration", 4],
      ["text_only", 12],
    ]),
  );
});

Deno.test("demo top-up captions and assets stay within the screenshot fixture rules", () => {
  const memberSlugs = new Set<string>(
    DEMO_FAMILY_MEMBERS.map((member) => member.slug),
  );
  const memorySlugs = new Set<string>();
  for (const memory of DEMO_TOP_UP_MEMORIES) {
    assert(!memorySlugs.has(memory.slug));
    memorySlugs.add(memory.slug);
    assert(!memory.caption.includes("—"));
    assert(memory.tagSlugs.every((slug) => memberSlugs.has(slug)));
    if (memory.memoryType !== "media") continue;
    assert(memory.mediaAssets.length >= 1);
    assert(memory.mediaAssets.length <= 10);
    for (const asset of memory.mediaAssets) {
      assert(asset.memberSlugs.every((slug) => memberSlugs.has(slug)));
    }
  }
});

Deno.test("existing memory date shifts are guarded and archive-eligible", () => {
  assertEquals(DEMO_EXISTING_MEMORY_DATE_UPDATES.length, 4);
  assert(
    DEMO_EXISTING_MEMORY_DATE_UPDATES.every((update) =>
      update.targetDate <= "2026-05-13" &&
      update.expectedCurrentDate > update.targetDate
    ),
  );
  assertEquals(
    new Set(DEMO_EXISTING_MEMORY_DATE_UPDATES.map((update) => update.memorySlug)).size,
    DEMO_EXISTING_MEMORY_DATE_UPDATES.length,
  );
});
