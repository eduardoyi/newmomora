import { assert, assertEquals } from "jsr:@std/assert@1";

import { DEMO_FAMILY_MEMBERS, DEMO_MEMORIES } from "./demo-family-spec.ts";

function hasUniqueValues(values: readonly string[]): boolean {
  return new Set(values).size === values.length;
}

Deno.test("demo family specification has a complete screenshot-ready memory mix", () => {
  assertEquals(DEMO_FAMILY_MEMBERS.length, 8);
  assert(hasUniqueValues(DEMO_FAMILY_MEMBERS.map((member) => member.slug)));
  assertEquals(DEMO_MEMORIES.length, 20);
  assert(hasUniqueValues(DEMO_MEMORIES.map((memory) => memory.slug)));

  assertEquals(
    DEMO_MEMORIES.filter((memory) => memory.memoryType === "text_only").length,
    5,
  );
  assertEquals(
    DEMO_MEMORIES.filter((memory) => memory.memoryType === "text_illustration")
      .length,
    5,
  );

  const mediaMemories = DEMO_MEMORIES.filter((memory) =>
    memory.memoryType === "media"
  );
  assertEquals(mediaMemories.length, 10);

  const photoMemories = mediaMemories.filter((memory) =>
    memory.mediaAssets.every((asset) => asset.kind === "photo")
  );
  const videoMemories = mediaMemories.filter((memory) =>
    memory.mediaAssets.every((asset) => asset.kind === "video")
  );
  assertEquals(photoMemories.length, 8);
  assertEquals(videoMemories.length, 2);
  assert(
    videoMemories.every((memory) =>
      memory.mediaAssets.every((asset) =>
        asset.kind === "video" && asset.durationSeconds === 5
      )
    ),
  );

  const carouselMemories = photoMemories.filter((memory) =>
    memory.mediaAssets.length > 1
  );
  assertEquals(carouselMemories.length, 2);
  assert(
    carouselMemories.every((memory) =>
      memory.mediaAssets.length >= 2 && memory.mediaAssets.length <= 4
    ),
  );
});

Deno.test("demo family specification observes family and memory constraints", () => {
  const memberSlugs = new Set(DEMO_FAMILY_MEMBERS.map((member) => member.slug));

  for (const memory of DEMO_MEMORIES) {
    assert(
      memory.tagSlugs.every((slug) => memberSlugs.has(slug)),
      `${memory.slug} has an unknown tag`,
    );
    assert(memory.tagSlugs.length > 0, `${memory.slug} needs at least one tag`);
    assert(
      !memory.caption.includes("—"),
      `${memory.slug} caption contains an em dash`,
    );

    if (memory.memoryType === "text_illustration") {
      assert(
        memory.tagSlugs.length <= 6,
        `${memory.slug} exceeds illustrated tag limit`,
      );
    }

    if (memory.memoryType === "media") {
      assert(
        memory.mediaAssets.length >= 1 && memory.mediaAssets.length <= 10,
        `${memory.slug} has an invalid media asset count`,
      );
      assert(hasUniqueValues(memory.mediaAssets.map((asset) => asset.slug)));

      for (const asset of memory.mediaAssets) {
        assert(
          asset.memberSlugs.length > 0,
          `${memory.slug}/${asset.slug} has no references`,
        );
        assert(
          asset.memberSlugs.every((slug) => memberSlugs.has(slug)),
          `${memory.slug}/${asset.slug} has an unknown asset reference`,
        );

        if (asset.kind === "photo") {
          assertEquals(asset.aspectRatio, "2:3");
        }

        if (asset.kind === "video") {
          assertEquals(asset.aspectRatio, "9:16");
          assert(
            asset.memberSlugs.length <= 9,
            `${memory.slug}/${asset.slug} exceeds the video reference limit`,
          );
        }
      }
    }
  }
});
