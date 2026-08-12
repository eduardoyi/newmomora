import { assertEquals, assertThrows } from "jsr:@std/assert@1";

import { parseArgs, shouldRun } from "./seed-demo-top-up.ts";

Deno.test("top-up args default to a non-mutating all-phase run", () => {
  const options = parseArgs([]);
  assertEquals(options.apply, false);
  assertEquals(options.phase, "all");
  assertEquals(options.only.size, 0);
});

Deno.test("top-up args support audit, phase, and slug filters", () => {
  const options = parseArgs([
    "--apply",
    "--phase",
    "portraits",
    "--only",
    "Maya Infant 2021 02",
  ]);
  assertEquals(options.apply, true);
  assertEquals(options.phase, "portraits");
  assertEquals(shouldRun(options, "maya-infant-2021-02"), true);
  assertEquals(shouldRun(options, "theo-baby-2023-07"), false);
  assertEquals(parseArgs(["--audit"]).phase, "audit");
});

Deno.test("top-up args reject malformed values", () => {
  assertThrows(() => parseArgs(["--phase", "everything"]));
  assertThrows(() => parseArgs(["--only"]));
  assertThrows(() => parseArgs(["--unexpected"]));
});
