// `analyze-memory`: the forward-looking endpoint name for full memory
// enrichment (docs/plans/memory-book.md §5 Stage A). Phase 1 ships it as a
// thin wrapper over `analyze-emotion`'s handler -- same request shape
// (`{memoryId}`), same response contract, same auth/cooldown/billing/write
// logic, all of which already lives in `_shared/analyze-memory-core.ts` plus
// `analyze-emotion/index.ts`'s HTTP plumbing around it. Duplicating that
// plumbing here instead of re-exporting it would be the kind of drift this
// package is explicitly trying to avoid; this repo already has precedent
// for one function importing another's handler directly (see
// `billing-reconcile-owners/index.ts` importing from `../billing-reconcile/
// index.ts`).
//
// Future clients that want a distinct `analyze-memory` request/response
// shape are a phase-2 change -- when that happens, give this file its own
// handler built on the same `_shared/analyze-memory-core.ts` primitives
// rather than growing `analyze-emotion/index.ts` further.
export { handleAnalyzeEmotion as handleAnalyzeMemory } from '../analyze-emotion/index.ts';

import { handleAnalyzeEmotion } from '../analyze-emotion/index.ts';

if (import.meta.main) {
  Deno.serve(handleAnalyzeEmotion);
}
