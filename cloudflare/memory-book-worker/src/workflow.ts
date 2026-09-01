import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers';
import { NonRetryableError } from 'cloudflare:workflows';
import {
  resolveOutlineLanguage,
  type OutlineIntegrityViolation,
} from '../../../supabase/functions/_shared/memory-book-outline.ts';
import {
  collectMemoryIdsFromElements,
  mergeCandidateMemoryIds,
} from '../../../supabase/functions/_shared/memory-book-manifest.ts';
import { BridgeError, ensureShareTokens, failBook, loadGenerationContext, publishBook, reconcileBook } from './bridge';
import { verifyCoverCandidates } from './cover-verify';
import { measureOriginalDimensionsForJobs, type DimensionMeasurementJob } from './dimensions';
import { buildBookManifest, selectMediaAsset } from './manifest';
import { runOutlineStage } from './outline';
import type { Env, GenerationContextResponse, WorkflowDispatchPayload } from './types';

const BRIDGE_STEP_RETRIES = { limit: 3, delay: '2 seconds', backoff: 'exponential' } as const;

/**
 * Coarse, closed error-code set for the row's `failure_reason` -- never the
 * raw thrown error/message, which could echo request/response bodies. See
 * AGENTS.md/CLAUDE.md "never log memory content" -- the same discipline
 * applies to what gets PERSISTED as a failure reason, not only what's
 * logged with console.*.
 */
type FailureCode =
  | 'CONTEXT_LOAD_FAILED'
  | 'NO_ELIGIBLE_MEMORIES'
  | 'OUTLINE_GENERATION_FAILED'
  | 'DIMENSION_MEASUREMENT_FAILED'
  | 'MANIFEST_BUILD_FAILED'
  | 'UNKNOWN_ERROR';

function errorCode(error: unknown): FailureCode {
  if (error instanceof NoEligibleMemoriesError) return 'NO_ELIGIBLE_MEMORIES';
  if (error instanceof ContextLoadError || error instanceof NonRetryableError) return 'CONTEXT_LOAD_FAILED';
  if (error instanceof OutlineStageError) return 'OUTLINE_GENERATION_FAILED';
  if (error instanceof DimensionMeasurementError) return 'DIMENSION_MEASUREMENT_FAILED';
  if (error instanceof ManifestStageError) return 'MANIFEST_BUILD_FAILED';
  return 'UNKNOWN_ERROR';
}

class ContextLoadError extends Error {}
class NoEligibleMemoriesError extends Error {}
class OutlineStageError extends Error {}
/** `measureOriginalDimensionsForJobs` itself fails open per-asset (never
 * throws for an individual unreadable photo -- see dimensions.ts), so
 * reaching this class at all means something broke at the step level
 * (e.g. the R2 binding itself), not an ordinary "some photo couldn't be
 * measured" outcome -- those are silent, expected omissions, not failures. */
class DimensionMeasurementError extends Error {}
/** Covers both manifest assembly AND the publish call itself -- they share
 * one step (see the "build manifest and publish" step.do below), so a
 * failure anywhere in it is ambiguous about whether publish was ever
 * reached; `hasAmbiguousPublishOutcome` below reconciles rather than
 * assuming either way. */
class ManifestStageError extends Error {}

export class MemoryBookWorkflow extends WorkflowEntrypoint<Env, WorkflowDispatchPayload> {
  async run(event: Readonly<WorkflowEvent<WorkflowDispatchPayload>>, step: WorkflowStep) {
    const { bookId, attemptId } = event.payload;

    try {
      // ── step 1: load the frozen scope + every raw row the outline/
      // manifest stages need. The bridge re-verifies attemptId is still
      // current before returning anything, so a superseded/failed attempt
      // bails here -- cheaply, before any OpenAI call. ──────────────────────
      const context = await step.do(
        'load generation context',
        { retries: BRIDGE_STEP_RETRIES, timeout: '30 seconds' },
        async (): Promise<GenerationContextResponse> => {
          try {
            return await loadGenerationContext(this.env, bookId, attemptId);
          } catch (error) {
            // A rejected (non-retryable) bridge response means the book is
            // no longer this attempt's to work on (superseded/terminal) --
            // stop the Workflow's own step retry loop immediately rather
            // than spending its retry budget on a request that can never
            // succeed.
            if (error instanceof BridgeError && !error.retryable) {
              throw new NonRetryableError(errorMessageOnly(error));
            }
            throw new ContextLoadError(errorMessageOnly(error));
          }
        },
      );

      if (context.memories.length === 0) {
        throw new NoEligibleMemoriesError('no memories in scope window');
      }

      // ── step 2: curate the outline (candidates, backbone, the shared
      // outline LLM call + parse, single placement, dissolve, reading
      // order). retries: 1 -- the OpenAI fetch already retries once
      // internally on 429/5xx; a Workflow-level retry here is only for an
      // infra-level step failure, not a hedge against a bad model call. ────
      const outline = await step.do(
        'curate outline',
        { retries: { limit: 1, delay: '5 seconds' }, timeout: '120 seconds' },
        async () => {
          try {
            const result = await runOutlineStage(this.env, context);
            return {
              elements: result.elements,
              parsed: result.parsed,
              violations: result.violations,
              usage: result.usage,
              counts: result.counts,
            };
          } catch (error) {
            throw new OutlineStageError(errorMessageOnly(error));
          }
        },
      );

      // ── step 3: cover-verify pass -- fails open by design (shared
      // module), so this step should never itself terminalize the book. ────
      const coverVerify = await step.do(
        'verify cover candidates',
        { retries: { limit: 2, delay: '3 seconds', backoff: 'exponential' }, timeout: '60 seconds' },
        async () => {
          const previewKeyByMemoryId = new Map<string, string | null>();
          for (const memory of context.memories) {
            const media = context.media.filter((m) => m.memory_id === memory.id).sort((a, b) => a.position - b.position);
            const firstUsable = media.find((m) => m.preview_object_key) ?? media.find((m) => m.content_type.startsWith('image/'));
            previewKeyByMemoryId.set(memory.id, firstUsable?.preview_object_key ?? firstUsable?.object_key ?? null);
          }
          return await verifyCoverCandidates(this.env, outline.parsed.coverCandidates, previewKeyByMemoryId);
        },
      );

      // Pure computation (no I/O) -- pulled out of the manifest-build step
      // below so BOTH it and the dimension-measurement step (which needs
      // to know which memories' media are actually worth measuring) can
      // see it without computing it twice.
      const referencedMemoryIds = mergeCandidateMemoryIds(
        collectMemoryIdsFromElements(outline.elements),
        outline.parsed.panoramaCandidates,
        outline.parsed.heroCandidates,
        coverVerify.coverCandidates,
      );

      // ── step 4: measure original (not preview) pixel dimensions for
      // every photo asset the manifest will reference -- book-renderer's
      // fitter (cover/panorama/full-bleed gates) reads `originalWidth`/
      // `originalHeight`, which only a real image-header read can produce
      // (the exported `width`/`height` stay a preview-capped placeholder,
      // see manifest.ts's header comment). Fails open per-asset (never
      // throws) -- see dimensions.ts -- so this step's own retries are only
      // for an infra-level failure of the step itself, not a hedge against
      // any individual unreadable photo. ───────────────────────────────────
      const originalDimensionsByMediaId = await step.do(
        'measure original photo dimensions',
        { retries: { limit: 2, delay: '3 seconds', backoff: 'exponential' }, timeout: '90 seconds' },
        async () => {
          try {
            const referenced = new Set(referencedMemoryIds);
            const jobs: DimensionMeasurementJob[] = [];
            for (const row of context.media) {
              if (!referenced.has(row.memory_id)) continue;
              if (selectMediaAsset(row)?.kind !== 'photo') continue;
              jobs.push({ id: row.id, objectKey: row.object_key, contentType: row.content_type });
            }
            return await measureOriginalDimensionsForJobs(this.env.MEMORY_BOOK_PREVIEWS, jobs);
          } catch (error) {
            throw new DimensionMeasurementError(errorMessageOnly(error));
          }
        },
      );

      // ── step 5: mint share tokens, assemble the manifest + outline.json-
      // shaped document, publish via CAS. All in one step so the (possibly
      // sizeable) book_document is only ever built once, and this step's
      // OWN durable return value stays small ({published, bookId}) even
      // though the document itself is large in local memory -- it's handed
      // to the bridge as an HTTP body, never returned from step.do. ────────
      const publishResult = await step.do(
        'build manifest and publish',
        { retries: BRIDGE_STEP_RETRIES, timeout: '30 seconds' },
        async () => {
          try {
            const shareTokenCandidateIds = referencedMemoryIds.filter((id) => {
              const memory = context.memories.find((m) => m.id === id);
              if (!memory) return false;
              return memory.memory_type === 'audio' || memory.memory_type === 'media';
            });
            const shareTokens = shareTokenCandidateIds.length > 0
              ? await ensureShareTokens(this.env, bookId, attemptId, shareTokenCandidateIds)
              : { tokensByMemoryId: {} };
            const shareTokensByMemoryId = new Map(Object.entries(shareTokens.tokensByMemoryId));

            // outline.parsed.language is already a validated BCP-47 code
            // (parseOutlineResponse resolves it via this same function);
            // re-resolving here is a defensive no-op. book-renderer only
            // ships Spanish/English furniture copy, so any "es*" tag (es,
            // es-MX, ...) maps to 'es' and everything else to 'en'.
            const resolvedLanguage = resolveOutlineLanguage(outline.parsed.language, context.configuredLanguage);
            const manifestLanguage: 'es' | 'en' = resolvedLanguage.toLowerCase().startsWith('es') ? 'es' : 'en';

            const manifest = buildBookManifest({
              context,
              memoryIds: referencedMemoryIds,
              outlineRunId: attemptId,
              language: manifestLanguage,
              shareTokensByMemoryId,
              originalDimensionsByMediaId,
            });

            const violations: OutlineIntegrityViolation[] = [...outline.violations, ...coverVerify.violations];

            const outlineDocument = {
              runId: attemptId,
              child: context.child
                ? { id: context.child.id, name: context.child.name }
                : { id: context.book.familyId, name: context.familyName },
              scope: { type: manifest.scope.kind },
              window: {
                start: context.book.windowStart,
                endExclusive: context.book.windowEndExclusive,
                label: context.book.scopeLabel,
              },
              language: resolvedLanguage,
              pageEstimate: estimatePageCount(outline.elements),
              imageCount: referencedMemoryIds.filter((id) => (manifest.memories[id]?.assets.length ?? 0) > 0).length,
              pageCap: context.book.pageBudget,
              counts: outline.counts,
              elements: outline.elements,
              heroCandidates: outline.parsed.heroCandidates,
              coverCandidates: coverVerify.coverCandidates,
              panoramaCandidates: outline.parsed.panoramaCandidates,
              dedication: outline.parsed.dedication,
              backCoverLine: outline.parsed.backCoverLine,
              internalEditorialNote: outline.parsed.internalEditorialNote,
              integrity: { violations },
            };

            const bookDocument = { outline: outlineDocument, manifest };

            const usage = {
              outlineTokens: outline.usage,
              coverVerifyTokens: coverVerify.usage,
            };
            // Cost line -- IDs/token counts only, never memory content (see
            // AGENTS.md/CLAUDE.md "never log memory content").
            console.log('memory_book_generation_usage', {
              bookId,
              attemptId,
              outlinePromptTokens: usage.outlineTokens?.prompt_tokens ?? 0,
              outlineCompletionTokens: usage.outlineTokens?.completion_tokens ?? 0,
              coverVerifyPromptTokens: usage.coverVerifyTokens?.prompt_tokens ?? 0,
              coverVerifyCompletionTokens: usage.coverVerifyTokens?.completion_tokens ?? 0,
            });

            const published = await publishBook(this.env, bookId, attemptId, bookDocument);
            return { published: published.published, bookId };
          } catch (error) {
            throw new ManifestStageError(errorMessageOnly(error));
          }
        },
      );

      if (publishResult.published) {
        return { bookId, status: 'ready' as const };
      }

      // Publish reported "not published" (CAS lost, superseded) rather than
      // throwing -- nothing to clean up (book_document is inline JSON, not
      // an R2 object), so this is a normal terminal outcome, not a failure.
      return { bookId, status: 'superseded' as const };
    } catch (error) {
      if (hasAmbiguousPublishOutcome(error)) {
        // The publish call itself may have landed. Reconcile rather than
        // guessing -- never generate another outline merely to resolve
        // publication ambiguity.
        const reconciled = await step.do(
          'reconcile publication',
          { retries: BRIDGE_STEP_RETRIES, timeout: '30 seconds' },
          async () => await reconcileBook(this.env, bookId, attemptId),
        );
        if (reconciled.outcome === 'succeeded') return { bookId, status: 'ready' as const };
        if (reconciled.outcome === 'superseded') return { bookId, status: 'superseded' as const };
        // 'retry' or 'failed' both fall through to the ordinary failure
        // path below -- 'retry' without a fresh publish attempt is treated
        // conservatively as a failure here (V5a has no separate retry-
        // publish step); the row's own failed state is safely recoverable
        // by a fresh dispatch (see generate-memory-book/index.ts's retry
        // handling), unlike a lost paid image generation.
      }

      const code = errorCode(error);
      await step.do(
        'record generation failure',
        { retries: BRIDGE_STEP_RETRIES, timeout: '30 seconds' },
        async () => await failBook(this.env, bookId, attemptId, code),
      );
      return { bookId, status: 'failed' as const, code };
    }
  }
}

function hasAmbiguousPublishOutcome(error: unknown): boolean {
  return error instanceof ManifestStageError;
}

/** Never forward a raw caught error's message into a persisted field or
 * console line -- it could echo request/response bodies. Every thrown
 * error here is one of this file's own closed error classes; their own
 * `message` is always a short, non-PII code string set at the throw site. */
function errorMessageOnly(error: unknown): string {
  return error instanceof Error ? error.message.slice(0, 200) : 'unknown_error';
}

/** Approximate, informational-only page estimate (V5a deliberately skips
 * the eval CLI's `fitBook` oracle -- see reading-order.ts's header comment).
 * One page per referenced memory plus a nominal structural/spread-title
 * overhead; the renderer's own fitter computes the REAL page count and
 * capacity report at render time (5b/5c, out of scope here). */
function estimatePageCount(elements: { kind: string; memoryIds: string[] }[]): number {
  const STRUCTURAL_PAGE_OVERHEAD: Record<string, number> = {
    cover: 2,
    title: 2,
    'through-the-years': 1,
    themed: 1,
    backbone: 0,
    birthday: 1,
    firsts: 1,
    closing: 1,
  };
  let pages = 0;
  for (const element of elements) {
    pages += STRUCTURAL_PAGE_OVERHEAD[element.kind] ?? 0;
    pages += element.memoryIds.length;
  }
  return pages;
}
