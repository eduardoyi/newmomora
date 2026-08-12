import { assert, assertEquals, assertThrows } from "jsr:@std/assert@1";

import {
  parseArgs,
  selectLikeActorSlugs,
  shouldRun,
} from "./seed-demo-engagement.ts";

Deno.test("engagement args default to a non-mutating all-phase run", () => {
  const options = parseArgs([]);
  assertEquals(options.apply, false);
  assertEquals(options.phase, "all");
  assertEquals(options.only.size, 0);
});

Deno.test("engagement args support phases, audit, and memory filters", () => {
  const options = parseArgs([
    "--apply",
    "--phase",
    "engagement",
    "--only",
    "Pancake Sun",
  ]);
  assertEquals(options.apply, true);
  assertEquals(options.phase, "engagement");
  assertEquals(shouldRun(options, "pancake-sun"), true);
  assertEquals(shouldRun(options, "sock-sandwich"), false);
  assertEquals(parseArgs(["--audit"]).phase, "audit");
});

Deno.test("like actor selection is stable and varied", () => {
  const first = selectLikeActorSlugs("pancake-sun");
  assertEquals(first, selectLikeActorSlugs("pancake-sun"));
  assert(first.length >= 2 && first.length <= 4);
  assertEquals(new Set(first).size, first.length);
  const allActors = new Set([
    ...selectLikeActorSlugs("pancake-sun"),
    ...selectLikeActorSlugs("sock-sandwich"),
    ...selectLikeActorSlugs("very-serious-birthday"),
    ...selectLikeActorSlugs("hallway-fort-admission"),
  ]);
  assert(allActors.size >= 3);
});

Deno.test("engagement args reject malformed values", () => {
  assertThrows(() => parseArgs(["--phase", "profiles"]));
  assertThrows(() => parseArgs(["--only"]));
  assertThrows(() => parseArgs(["--unexpected"]));
});
