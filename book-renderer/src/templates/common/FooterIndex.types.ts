/**
 * Pure type-only companion to `FooterIndex.tsx` (round-13 split): `fitter.ts`
 * needs `FooterIndexEntry`'s SHAPE but is otherwise plain TS with no React/
 * DOM dependency (it's imported directly by the memory-book outline eval
 * script, which runs under Deno — see `supabase/scripts/eval-memory-book-
 * outline.ts`). Importing the interface from the `.tsx` component file pulls
 * its whole render-time import graph (React JSX, `ScanMark.tsx`, etc.) into
 * that type-only import, which Deno's checker can't resolve without a much
 * heavier npm/JSX toolchain wired in just for a type shape. Splitting the
 * interface into this file (imported by BOTH `FooterIndex.tsx`, which
 * re-exports it for existing consumers, and `fitter.ts`) keeps a single
 * source of truth with zero behavior change on either side.
 */
export interface FooterIndexEntry {
  /** Primary (lowest) numeral — the React key and the consolidation sort key. */
  index: number;
  /** Every numeral this line represents, ascending — usually `[index]`, 2+ when same-date/caption entries consolidated (item 9). */
  indices: number[];
  date: string;
  /** The memory's own text, verbatim — never invented. */
  note: string | null;
  qr?: boolean;
}
