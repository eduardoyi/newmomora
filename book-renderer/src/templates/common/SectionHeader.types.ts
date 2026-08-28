/**
 * Pure type-only companion to `SectionHeader.tsx` (round-13 split, same
 * rationale as `FooterIndex.types.ts`): `fitter.ts` needs `SectionHeaderParams`'s
 * SHAPE but is otherwise plain TS with no React/DOM dependency (it's
 * imported directly by the memory-book outline eval script, which runs
 * under Deno). The `.tsx` file's own JSX body needs the JSX namespace
 * regardless of its imports, so a type-only import of it still drags in a
 * React/JSX resolution requirement Deno can't satisfy without a much
 * heavier toolchain wired in just for a type shape. Single source of truth:
 * `SectionHeader.tsx` re-exports this for existing consumers.
 */
export interface SectionHeaderParams {
  /** Date-range antetítulo, e.g. "October–November 2024". Absent when the
   *  outline hasn't supplied one yet — never invented. */
  kicker: string | null;
  title: string;
  special: boolean;
}
