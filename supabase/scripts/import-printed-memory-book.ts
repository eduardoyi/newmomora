/**
 * One-off OWNER-RUN import: puts an already-printed dogfood book (an
 * existing `book-renderer/book-data/<slug>/` local export, e.g.
 * `enzo-year-two`/`mara-year-one`) into the production `memory_books` table
 * so it shows up on the new shelf, without ever having gone through the
 * durable generation pipeline (`generate-memory-book` /
 * `workflow-memory-book-bridge` / `cloudflare/memory-book-worker`).
 *
 * CRITICAL data-fidelity problem this script exists to solve: the local
 * export's `manifest.json` has asset `file` values that are LOCAL disk paths
 * (`assets/<memoryId>-<n>.jpg`, relative to the export directory) -- not R2
 * object keys. That manifest can never be stored in `book_document` as-is;
 * the app would try to resolve those paths as R2 keys and fail every image.
 * The PRINTED CURATION, however, lives entirely in `book.outline.json`
 * (elements, coverCandidates/heroCandidates/panoramaCandidates/
 * guaranteedPanoramaIds, dedication, backCoverLine, counts, pageCap/
 * pageEstimate...) and is inserted BYTE-FOR-BYTE, unmodified -- the printed
 * book's actual layout depends on it, and (per fitter.ts's own "legacy
 * compatibility" hero-fallback comment, which names these exact books)
 * these two exports predate the current outline.json contract in small,
 * known ways (`enzo-year-two` has `coverCandidates` + `language: "es-CO"`;
 * `mara-year-one` has NO `coverCandidates` at all and carries `pageCap`/
 * `pageEstimate` at the top level) -- none of that is normalized here.
 *
 * The MANIFEST is rebuilt fresh against prod so every asset `file` is a live
 * R2 preview key, reusing the shared manifest-assembly module
 * (`../functions/_shared/memory-book-manifest.ts` -- the same module
 * `workflow-memory-book-bridge`'s `handleLoadGenerationContext` and
 * `eval-memory-book-assets.ts` both build on) rather than reimplementing
 * `buildManifestAsset`/`buildManifestMemory`/etc. Every memory id the
 * printed outline references anywhere (`collectMemoryIdsFromElements` over
 * every element, unioned with `panoramaCandidates`/`heroCandidates`/
 * `coverCandidates` via `mergeCandidateMemoryIds`, further unioned with the
 * outline's own `guaranteedPanoramaIds` -- NOT part of `ParsedOutline`'s
 * typed shape, so read directly off the raw parsed JSON) is looked up in
 * prod, via a service-role client, the SAME way
 * `handleLoadGenerationContext` loads its rows (`memories`, `memory_media`,
 * `memory_family_members` -> `family_members`, `memory_milestones`,
 * `memory_likes`/`memory_comments`, `family_member_portrait_versions`) --
 * except scoped by explicit memory id (this book's already-frozen curation)
 * rather than by date window, and read once with no pagination (a single
 * book's referenced-memory count is always small; contrast
 * `eval-memory-book-assets.ts`'s full chunked/paginated loaders, built for
 * exporting a whole outline run's worth of assets).
 *
 * DELIBERATE SIMPLIFICATION -- no R2 downloads, no pixel measurement: this
 * script never fetches any object body (unlike `eval-memory-book-assets.ts`,
 * which downloads+measures every asset to get real preview pixel
 * dimensions). `memory_media` has no width/height column (only
 * `aspect_ratio` -- see `docs/TECH_SPEC.md`'s `memory_media` table), so
 * getting REAL preview-file pixel dimensions genuinely requires a download.
 * Building that whole pipeline (HEIC transcode, video poster extraction,
 * Laplacian sharpness scoring, ...) for a one-off re-import of two ALREADY
 * fully-exported, ALREADY-PRINTED books would be reimplementing most of
 * `eval-memory-book-assets.ts` to re-derive facts that script already
 * measured once, correctly, from the SAME underlying R2 objects (a photo's
 * pixel dimensions don't change based on which object key currently points
 * at it). Instead: `width`/`height`/`originalWidth`/`originalHeight` are
 * CARRIED OVER from the local `manifest.json`'s own already-measured asset
 * entries (matched to the live, freshly-selected `memory_media` row by
 * memory id + position order -- see `buildRebuiltAssets` below), while the
 * `file` key itself is always freshly resolved against LIVE prod
 * `memory_media` rows via `selectMediaAsset` (imported from
 * `./eval-memory-book-assets.ts`, the exact same pure selection rule the
 * original export used: prefer `preview_object_key`, fall back to
 * `object_key` for jpeg/png/webp, skip HEIC-without-preview). A memory whose
 * live/local asset counts don't line up (media edited since the book was
 * printed) falls back to an aspect-ratio-derived sentinel (same
 * `applyWidthHeight` semantics `book-renderer/src/model/edits.ts` and
 * `_shared/memory-book-cover.ts` already use elsewhere) and is reported
 * LOUDLY as a warning rather than silently guessed. `originalFile` is
 * omitted entirely, matching `eval-memory-book-assets.ts`'s own export
 * pipeline (which never sets it either -- it's a `memory-book-5c` print/
 * backfill-only field, applied to an already-frozen `ready` manifest by a
 * separate patch step, not at export time).
 *
 * Portraits are matched the same "carry the id, refresh the key" way: the
 * local export's `manifest.json` portrait file names embed the exact
 * `family_member_portrait_versions.id` each one came from
 * (`assets/portrait-<id>.jpg` / `assets/portrait-<id>-source.jpg`, see
 * `portraitFileName`/`portraitSourceFileName` in `eval-memory-book-assets.ts`)
 * -- this script extracts those ids and queries prod for EXACTLY that set
 * (`.in('id', ...)`), rather than re-deriving the reference-date window
 * (which would silently re-include a portrait the original export
 * deliberately dropped via `--exclude-portrait-id`, or include one added
 * since). A portrait id that no longer resolves, or is no longer
 * `illustrated_profile_status = 'ready'`, is reported and simply omitted --
 * same "the export just has fewer portraits" tolerance the real pipeline
 * already has for a bare manifest.
 *
 * Missing-memory tolerance (verified, not assumed): `book-renderer/src/
 * model/loader.ts`'s `resolveElementMemories` explicitly SKIPS any
 * `element.memoryIds` entry that doesn't resolve against
 * `manifest.memories` ("Resolves an outline element's memoryIds to manifest
 * records, skipping any missing"; `resolveMemory` returns `null` for a
 * miss). So an outline element referencing a memory id that no longer
 * resolves in prod (deleted, or moved to another family) is NOT a rendering
 * error -- the renderer already tolerates a manifest that omits it, minus
 * that one moment's page content. This script still reports every such id
 * LOUDLY (counts + ids, never memory text) in both dry-run and `--apply`
 * modes, so the owner can judge whether the resulting book is still
 * acceptable before committing to `--apply`.
 *
 * `cover_asset_key` is computed via `_shared/memory-book-cover.ts`'s
 * `pickCoverAssetKey(bookDocument)` -- no `coverEdit` argument, since a
 * freshly-imported row can't have a `memory_book_edits` row yet.
 *
 * DRY-RUN BY DEFAULT: prints exactly what each book WOULD insert (ids,
 * scope, resolved/unresolved memory counts + the unresolved ids, computed
 * `cover_asset_key`, `requested_by`, `page_budget`) plus every warning, and
 * writes nothing. `--apply` performs the inserts. `--force-duplicate`
 * inserts a NEW row even when an existing `memory_books` row already covers
 * the identical (family_id, child_id, scope_kind, scope dates) in ANY
 * status -- this script NEVER updates an existing row, only ever inserts.
 *
 * PII rule: stdout is counts/ids/keys only -- never memory text/captions
 * (`memories.content`), matching `eval-memory-book-assets.ts`'s own PII
 * rule. A dumped R2 object key, when one appears in a warning, is never
 * itself family content, but is still kept as printed by Supabase (object
 * keys are not memory text) -- no separate basename-only rule is needed
 * here since (unlike `eval-memory-book-assets.ts`) this script never prints
 * raw failed-download keys (there are no downloads to fail).
 *
 * Usage:
 *   npm run import:printed-memory-book -- book-renderer/book-data/enzo-year-two
 *   npm run import:printed-memory-book -- book-renderer/book-data/enzo-year-two book-renderer/book-data/mara-year-one
 *   npm run import:printed-memory-book -- book-renderer/book-data/enzo-year-two --apply
 *   npm run import:printed-memory-book -- book-renderer/book-data/enzo-year-two --apply --force-duplicate
 *
 * Requires Supabase service-role env vars in supabase/.env.local
 * (SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY) -- see `createAdminClient`
 * below, which mirrors `eval-memory-book-assets.ts`'s own local
 * `createAdminClient` byte-for-byte (same env var names/fallbacks). This
 * script must typecheck even when it cannot be run (no live Supabase env in
 * every environment it's edited from).
 */
import { createClient, type SupabaseClient } from 'npm:@supabase/supabase-js@2';
import {
  buildManifest,
  buildManifestAsset,
  buildManifestIllustration,
  buildManifestMemory,
  buildManifestMilestone,
  buildManifestPortrait,
  buildManifestScope,
  buildTaggedMember,
  collectMemoryIdsFromElements,
  generateShareToken,
  memoryNeedsShareToken,
  mergeCandidateMemoryIds,
  parseOutlineJson,
  type BookManifest,
  type ManifestAsset,
  type ManifestAssetKind,
  type ManifestIllustration,
  type ManifestLanguage,
  type ManifestMemory,
  type ManifestMilestone,
  type ManifestTaggedMember,
  type ParsedOutline,
} from '../functions/_shared/memory-book-manifest.ts';
import { pickCoverAssetKey } from '../functions/_shared/memory-book-cover.ts';
// Reused rather than reimplemented -- same precedent as
// backfill-video-posters.ts importing deriveMediaPreviewKey from
// backfill-media-previews.ts. Pure function, no R2/Deno globals.
import { selectMediaAsset } from './eval-memory-book-assets.ts';

// ── CLI ──────────────────────────────────────────────────────────────────

interface CliOptions {
  bookDirs: string[];
  apply: boolean;
  forceDuplicate: boolean;
}

export const CLI_USAGE =
  'Usage: import-printed-memory-book.ts <book-dir> [<book-dir> ...] [--apply] [--force-duplicate]';

/** Same hardening posture as eval-memory-book-outline.ts/
 * eval-memory-book-assets.ts's own `parseArgs`: an unrecognized token is a
 * hard error (with usage), never silently dropped. Positional (non-`--`)
 * tokens are book directories -- at least one required. */
export function parseArgs(args: string[]): CliOptions {
  const bookDirs: string[] = [];
  let apply = false;
  let forceDuplicate = false;

  for (const arg of args) {
    if (arg === '--apply') {
      apply = true;
    } else if (arg === '--force-duplicate') {
      forceDuplicate = true;
    } else if (arg.startsWith('--')) {
      throw new Error(`Unknown argument: "${arg}"\n${CLI_USAGE}`);
    } else {
      bookDirs.push(arg.replace(/\/+$/, ''));
    }
  }

  if (bookDirs.length === 0) {
    throw new Error(`At least one <book-dir> is required.\n${CLI_USAGE}`);
  }

  return { bookDirs, apply, forceDuplicate };
}

// ── Service-role client (mirrors eval-memory-book-assets.ts's own
// createAdminClient byte-for-byte -- same env var names/fallbacks. This
// script has no separate RLS-scoped "authed client" at all, unlike the eval
// scripts: every read AND the final write go through service role, the same
// way handleLoadGenerationContext/handlePublish in
// workflow-memory-book-bridge/index.ts do.) ─────────────────────────────

function createAdminClient(): SupabaseClient {
  const supabaseUrl = Deno.env.get('EXPO_PUBLIC_SUPABASE_URL') ?? Deno.env.get('SUPABASE_URL');
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!supabaseUrl || !serviceRoleKey) {
    throw new Error('Missing Supabase env vars in supabase/.env.local (SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY)');
  }
  return createClient(supabaseUrl, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

// ── Pure helpers ─────────────────────────────────────────────────────────

/** Order-preserving de-dupe across any number of id lists. */
export function dedupeIds(...idLists: string[][]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const list of idLists) {
    for (const id of list) {
      if (!seen.has(id)) {
        seen.add(id);
        out.push(id);
      }
    }
  }
  return out;
}

const MIN_PAGE_BUDGET = 18;
const MAX_PAGE_BUDGET = 122;
const DEFAULT_PAGE_BUDGET = 122;

/**
 * `memory_books.page_budget` must be an integer in [18, 122] (migration
 * 20260901100000_memory_books.sql's check constraint). Prefers the
 * outline's own `pageCap` (the actual ceiling the printed book was fit
 * against) over `pageEstimate` (just an estimate of how many pages the
 * curated content would fill, which can legitimately exceed the cap -- e.g.
 * mara-year-one's outline has `pageCap: 122` but `pageEstimate: 202`, so
 * using the estimate here would violate the column's own check constraint
 * outright). Falls back to `DEFAULT_PAGE_BUDGET` when neither is a finite
 * number. Always clamped into range regardless of source, so a slightly
 * out-of-band value from an old outline run can never fail the insert.
 */
export function resolvePageBudget(outline: { pageCap?: unknown; pageEstimate?: unknown }): number {
  const pageCap = typeof outline.pageCap === 'number' && Number.isFinite(outline.pageCap) ? outline.pageCap : null;
  const pageEstimate =
    typeof outline.pageEstimate === 'number' && Number.isFinite(outline.pageEstimate) ? outline.pageEstimate : null;
  const chosen = pageCap ?? pageEstimate ?? DEFAULT_PAGE_BUDGET;
  return Math.min(MAX_PAGE_BUDGET, Math.max(MIN_PAGE_BUDGET, Math.round(chosen)));
}

const PORTRAIT_FILE_PATTERN =
  /^assets\/portrait-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:-source)?\.[a-z0-9]+$/i;

/** Extracts the `family_member_portrait_versions.id` embedded in a local
 * export's portrait file name (`portraitFileName`/`portraitSourceFileName`
 * in eval-memory-book-assets.ts) -- `null` for anything that doesn't match
 * (an old/hand-edited export). */
export function extractPortraitVersionId(file: string): string | null {
  const match = PORTRAIT_FILE_PATTERN.exec(file);
  return match ? match[1] : null;
}

/** Same aspect-ratio-derived sentinel `applyWidthHeight` (book-renderer's
 * edits.ts) and `_shared/memory-book-cover.ts`'s `buildCoverEditCandidate`
 * use when a real pixel measurement isn't available: a tiny width at the
 * correct aspect ratio, so any width-based trust gate fails closed rather
 * than fabricating a plausible pixel count. */
export function sentinelDimensions(aspectRatio: number): { width: number; height: number } {
  return { width: Math.round(100 * aspectRatio), height: 100 };
}

// ── Local export shape (loose -- only the fields this script reads) ──────

interface LocalManifestAsset {
  kind?: unknown;
  width?: unknown;
  height?: unknown;
  originalWidth?: unknown;
  originalHeight?: unknown;
}

interface LocalManifestMemory {
  assets?: LocalManifestAsset[];
  illustration?: { width?: unknown; height?: unknown } | null;
}

interface LocalManifestPortrait {
  file?: unknown;
}

interface LocalManifest {
  scope?: { kind?: unknown; label?: unknown; start?: unknown; end?: unknown };
  language?: unknown;
  outlineRun?: unknown;
  memories?: Record<string, LocalManifestMemory>;
  portraits?: LocalManifestPortrait[];
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

// ── Prod row shapes (same hand-typed convention as eval-memory-book-assets.ts) ──

interface DbMemoryRow {
  id: string;
  content: string | null;
  memory_date: string;
  memory_type: string;
  emotion: string | null;
  topics: string[];
  illustration_key: string | null;
}

interface DbMediaRow {
  id: string;
  memory_id: string;
  object_key: string;
  preview_object_key: string | null;
  content_type: string;
  position: number;
  duration_ms: number | null;
  aspect_ratio: number | null;
}

interface DbFamilyMemberRow {
  id: string;
  name: string;
  date_of_birth: string | null;
}

interface DbPortraitVersionRow {
  id: string;
  reference_date: string | null;
  illustrated_profile_key: string | null;
  illustrated_profile_status: string;
  profile_picture_key: string;
}

// ── Per-book result ──────────────────────────────────────────────────────

interface ExistingBookRow {
  id: string;
  status: string;
}

interface BookImportSummary {
  bookDir: string;
  childId: string;
  childName: string;
  familyId: string;
  requestedBy: string;
  scopeLabel: string;
  scopeStartDate: string;
  scopeEndDate: string;
  memoriesReferenced: number;
  memoriesResolved: number;
  unresolvedMemoryIds: string[];
  coverAssetKey: string | null;
  pageBudget: number;
  existingDuplicates: ExistingBookRow[];
  willInsert: boolean;
  warnings: string[];
}

interface BookImportOutcome {
  bookDir: string;
  ok: true;
  summary: BookImportSummary;
  insertRow: Record<string, unknown>;
}

interface BookImportFailure {
  bookDir: string;
  ok: false;
  errors: string[];
}

type BookImportResult = BookImportOutcome | BookImportFailure;

// ── Per-book processing ──────────────────────────────────────────────────

async function loadBook(bookDir: string): Promise<
  | { ok: true; rawOutlineJson: Record<string, unknown>; parsedOutline: ParsedOutline; localManifest: LocalManifest }
  | { ok: false; errors: string[] }
> {
  const outlinePath = `${bookDir}/book.outline.json`;
  const manifestPath = `${bookDir}/manifest.json`;

  let rawOutlineText: string;
  let rawManifestText: string;
  try {
    rawOutlineText = await Deno.readTextFile(outlinePath);
  } catch {
    return { ok: false, errors: [`Missing ${outlinePath}`] };
  }
  try {
    rawManifestText = await Deno.readTextFile(manifestPath);
  } catch {
    return { ok: false, errors: [`Missing ${manifestPath}`] };
  }

  let rawOutlineJson: Record<string, unknown>;
  let localManifest: LocalManifest;
  try {
    rawOutlineJson = JSON.parse(rawOutlineText) as Record<string, unknown>;
  } catch (error) {
    return { ok: false, errors: [`${outlinePath} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`] };
  }
  try {
    localManifest = JSON.parse(rawManifestText) as LocalManifest;
  } catch (error) {
    return { ok: false, errors: [`${manifestPath} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`] };
  }

  let parsedOutline: ParsedOutline;
  try {
    parsedOutline = parseOutlineJson(rawOutlineJson);
  } catch (error) {
    return { ok: false, errors: [`Failed to parse ${outlinePath}: ${error instanceof Error ? error.message : String(error)}`] };
  }

  if (!localManifest.scope || typeof localManifest.scope !== 'object') {
    return { ok: false, errors: [`${manifestPath} is missing "scope" -- cannot resolve scope_start_date/scope_end_date`] };
  }
  const { start, end, label } = localManifest.scope;
  if (typeof start !== 'string' || typeof end !== 'string' || typeof label !== 'string') {
    return { ok: false, errors: [`${manifestPath}'s "scope" is missing start/end/label`] };
  }

  return { ok: true, rawOutlineJson, parsedOutline, localManifest };
}

/**
 * Selects+builds every `ManifestAsset` for one memory: LIVE file/kind from
 * freshly-queried `memory_media` rows (via `selectMediaAsset`, the exact
 * selection rule the original export used), width/height/original
 * dimensions CARRIED OVER from the local export's already-measured asset at
 * the same position -- see this file's header comment "no R2 downloads, no
 * pixel measurement". Falls back to an aspect-ratio sentinel (with a
 * warning) for any asset the local export can't account for (a length or
 * kind mismatch -- media edited since the book was printed).
 */
function buildRebuiltAssets(
  memoryId: string,
  prodMediaRows: DbMediaRow[],
  localAssets: LocalManifestAsset[],
  warnings: string[],
): ManifestAsset[] {
  const sortedProd = [...prodMediaRows].sort((a, b) => a.position - b.position);
  const selected = sortedProd
    .map((row) => ({ row, selection: selectMediaAsset({ contentType: row.content_type, objectKey: row.object_key, previewObjectKey: row.preview_object_key }) }))
    .filter((entry): entry is { row: DbMediaRow; selection: { key: string; kind: ManifestAssetKind } } => entry.selection !== null);

  if (selected.length !== localAssets.length) {
    warnings.push(
      `memory ${memoryId}: prod resolves ${selected.length} live asset(s) but the local export had ${localAssets.length} -- ` +
        'media may have changed since the book was printed. Falling back to aspect-ratio sentinel dimensions for this memory\'s assets (file keys are still live).',
    );
  }

  return selected.map((entry, index) => {
    const local = localAssets[index];
    const dbAspectRatio = entry.row.aspect_ratio;
    const localKindMatches = local && local.kind === entry.selection.kind;

    let width: number;
    let height: number;
    let originalDimensions: { width: number; height: number } | null = null;

    if (localKindMatches && isFiniteNumber(local.width) && isFiniteNumber(local.height)) {
      width = local.width;
      height = local.height;
      if (isFiniteNumber(local.originalWidth) && isFiniteNumber(local.originalHeight)) {
        originalDimensions = { width: local.originalWidth, height: local.originalHeight };
      }
    } else {
      if (local && !localKindMatches) {
        warnings.push(
          `memory ${memoryId} asset #${index}: local export kind "${String(local.kind)}" does not match the live-resolved kind ` +
            `"${entry.selection.kind}" -- using an aspect-ratio sentinel instead of the local export's measured dimensions.`,
        );
      }
      const sentinel = sentinelDimensions(dbAspectRatio ?? 1);
      width = sentinel.width;
      height = sentinel.height;
    }

    return buildManifestAsset({
      file: entry.selection.key,
      width,
      height,
      kind: entry.selection.kind,
      durationMs: entry.row.duration_ms,
      dbAspectRatio,
      originalDimensions,
    });
  });
}

async function processBook(
  admin: SupabaseClient,
  bookDir: string,
  options: { forceDuplicate: boolean; apply: boolean },
): Promise<BookImportResult> {
  const loaded = await loadBook(bookDir);
  if (!loaded.ok) return { bookDir, ok: false, errors: loaded.errors };
  const { rawOutlineJson, parsedOutline, localManifest } = loaded;
  const warnings: string[] = [];

  // ── Memory id collection: every element's memoryIds, unioned with
  // panorama/hero/cover candidates AND the outline's own
  // guaranteedPanoramaIds (not part of ParsedOutline's typed shape -- read
  // directly off the raw parsed JSON, same "tolerant of absence" posture as
  // the other candidate arrays). ──────────────────────────────────────────
  const guaranteedPanoramaIds = Array.isArray(rawOutlineJson.guaranteedPanoramaIds)
    ? rawOutlineJson.guaranteedPanoramaIds.filter((id): id is string => typeof id === 'string')
    : [];
  const elementMemoryIds = collectMemoryIdsFromElements(parsedOutline.elements);
  const candidateMemoryIds = mergeCandidateMemoryIds(
    elementMemoryIds,
    parsedOutline.panoramaCandidates,
    parsedOutline.heroCandidates,
    parsedOutline.coverCandidates,
  );
  const referencedMemoryIds = dedupeIds(candidateMemoryIds, guaranteedPanoramaIds);

  // ── Resolve child -> family, and requested_by = the family's owner. ────
  const childId = parsedOutline.child.id;
  const { data: childRow, error: childError } = await admin
    .from('family_members')
    .select('id, family_id, name, date_of_birth')
    .eq('id', childId)
    .maybeSingle();
  if (childError) return { bookDir, ok: false, errors: [`family_members lookup failed: ${childError.message}`] };
  if (!childRow) {
    return { bookDir, ok: false, errors: [`Child (family_members.id = ${childId}, outline.child.name = "${parsedOutline.child.name}") was not found in prod -- aborting.`] };
  }
  const familyId = childRow.family_id as string;
  const childDateOfBirth = childRow.date_of_birth as string | null;

  const { data: ownerRow, error: ownerError } = await admin
    .from('family_memberships')
    .select('user_id')
    .eq('family_id', familyId)
    .eq('role', 'owner')
    .maybeSingle();
  if (ownerError) return { bookDir, ok: false, errors: [`family_memberships owner lookup failed: ${ownerError.message}`] };
  if (!ownerRow) return { bookDir, ok: false, errors: [`No 'owner' family_memberships row found for family ${familyId} -- aborting.`] };
  const requestedBy = ownerRow.user_id as string;

  // ── Scope fields (from the local export's already-resolved, inclusive-end
  // scope -- see loadBook's validation). scope_kind is always 'age_year'
  // for these dogfood exports (both outlines are scope.type === 'age-year'). ──
  const scopeStartDate = localManifest.scope!.start as string;
  const scopeEndDate = localManifest.scope!.end as string;
  const scopeLabel = localManifest.scope!.label as string;
  const scopeKind = 'age_year' as const;

  // ── Dedupe check: an existing row for this EXACT scope, in ANY status,
  // is reported and skipped unless --force-duplicate. Never an update. ────
  const { data: existingRows, error: existingError } = await admin
    .from('memory_books')
    .select('id, status')
    .eq('family_id', familyId)
    .eq('child_id', childId)
    .eq('scope_kind', scopeKind)
    .eq('scope_start_date', scopeStartDate)
    .eq('scope_end_date', scopeEndDate);
  if (existingError) return { bookDir, ok: false, errors: [`memory_books dedupe check failed: ${existingError.message}`] };
  const existingDuplicates: ExistingBookRow[] = (existingRows ?? []) as ExistingBookRow[];
  const willInsert = existingDuplicates.length === 0 || options.forceDuplicate;
  if (existingDuplicates.length > 0) {
    warnings.push(
      `${existingDuplicates.length} existing memory_books row(s) already cover this exact scope: ` +
        existingDuplicates.map((r) => `${r.id} (${r.status})`).join(', ') +
        (options.forceDuplicate ? ' -- --force-duplicate set, inserting a NEW row anyway (never overwriting).' : ' -- SKIPPING (pass --force-duplicate to insert anyway).'),
    );
  }

  // ── Load prod data for every referenced memory id. ──────────────────────
  const [memoriesRes, mediaRes, tagsRes, milestonesRes, likesRes, commentsRes, familyMembersRes] = await Promise.all([
    referencedMemoryIds.length > 0
      ? admin.from('memories').select('id, content, memory_date, memory_type, emotion, topics, illustration_key').eq('family_id', familyId).in('id', referencedMemoryIds)
      : Promise.resolve({ data: [] as DbMemoryRow[], error: null }),
    referencedMemoryIds.length > 0
      ? admin.from('memory_media').select('id, memory_id, object_key, preview_object_key, content_type, position, duration_ms, aspect_ratio').in('memory_id', referencedMemoryIds)
      : Promise.resolve({ data: [] as DbMediaRow[], error: null }),
    referencedMemoryIds.length > 0
      ? admin.from('memory_family_members').select('memory_id, family_member_id').in('memory_id', referencedMemoryIds)
      : Promise.resolve({ data: [] as Array<{ memory_id: string; family_member_id: string }>, error: null }),
    referencedMemoryIds.length > 0
      ? admin.from('memory_milestones').select('memory_id, milestone_id, detail').neq('status', 'dismissed').in('memory_id', referencedMemoryIds)
      : Promise.resolve({ data: [] as Array<{ memory_id: string; milestone_id: string; detail: string | null }>, error: null }),
    referencedMemoryIds.length > 0
      ? admin.from('memory_likes').select('memory_id').in('memory_id', referencedMemoryIds)
      : Promise.resolve({ data: [] as Array<{ memory_id: string }>, error: null }),
    referencedMemoryIds.length > 0
      ? admin.from('memory_comments').select('memory_id').in('memory_id', referencedMemoryIds)
      : Promise.resolve({ data: [] as Array<{ memory_id: string }>, error: null }),
    admin.from('family_members').select('id, name, date_of_birth').eq('family_id', familyId),
  ]);
  for (const [label, res] of [
    ['memories', memoriesRes], ['memory_media', mediaRes], ['memory_family_members', tagsRes],
    ['memory_milestones', milestonesRes], ['memory_likes', likesRes], ['memory_comments', commentsRes],
    ['family_members', familyMembersRes],
  ] as const) {
    if (res.error) return { bookDir, ok: false, errors: [`${label} query failed: ${res.error.message}`] };
  }

  const memoriesById = new Map<string, DbMemoryRow>((memoriesRes.data as DbMemoryRow[]).map((row) => [row.id, row]));
  const mediaByMemory = new Map<string, DbMediaRow[]>();
  for (const row of mediaRes.data as DbMediaRow[]) {
    const list = mediaByMemory.get(row.memory_id) ?? [];
    list.push(row);
    mediaByMemory.set(row.memory_id, list);
  }
  const tagsByMemory = new Map<string, string[]>();
  for (const row of tagsRes.data as Array<{ memory_id: string; family_member_id: string }>) {
    const list = tagsByMemory.get(row.memory_id) ?? [];
    list.push(row.family_member_id);
    tagsByMemory.set(row.memory_id, list);
  }
  const milestonesByMemory = new Map<string, Array<{ milestone_id: string; detail: string | null }>>();
  for (const row of milestonesRes.data as Array<{ memory_id: string; milestone_id: string; detail: string | null }>) {
    const list = milestonesByMemory.get(row.memory_id) ?? [];
    list.push({ milestone_id: row.milestone_id, detail: row.detail });
    milestonesByMemory.set(row.memory_id, list);
  }
  const engagementByMemory = new Map<string, number>();
  for (const row of likesRes.data as Array<{ memory_id: string }>) {
    engagementByMemory.set(row.memory_id, (engagementByMemory.get(row.memory_id) ?? 0) + 1);
  }
  for (const row of commentsRes.data as Array<{ memory_id: string }>) {
    engagementByMemory.set(row.memory_id, (engagementByMemory.get(row.memory_id) ?? 0) + 1);
  }
  const familyMembersById = new Map<string, DbFamilyMemberRow>((familyMembersRes.data as DbFamilyMemberRow[]).map((row) => [row.id, row]));

  const unresolvedMemoryIds = referencedMemoryIds.filter((id) => !memoriesById.has(id));
  const resolvedMemoryIds = referencedMemoryIds.filter((id) => memoriesById.has(id));

  // ── Share tokens: select-or-mint, same contract as
  // workflow-memory-book-bridge's handleEnsureShareTokens -- NEVER touches
  // an already-active token, only fills a gap. The printed book's physical
  // QR codes already encode whatever was minted at export time, so this is
  // expected to be a pure read in practice. ───────────────────────────────
  const shareTokensByMemory = new Map<string, string>();
  if (resolvedMemoryIds.length > 0) {
    const { data: existingTokens, error: tokensError } = await admin
      .from('media_share_tokens')
      .select('memory_id, token')
      .in('memory_id', resolvedMemoryIds)
      .is('revoked_at', null);
    if (tokensError) return { bookDir, ok: false, errors: [`media_share_tokens lookup failed: ${tokensError.message}`] };
    for (const row of (existingTokens ?? []) as Array<{ memory_id: string; token: string }>) {
      shareTokensByMemory.set(row.memory_id, row.token);
    }
    const eligibleWithoutToken = resolvedMemoryIds.filter((id) => {
      const memoryRow = memoriesById.get(id)!;
      const assets = mediaByMemory.get(id) ?? [];
      const kinds = assets
        .map((row) => selectMediaAsset({ contentType: row.content_type, objectKey: row.object_key, previewObjectKey: row.preview_object_key }))
        .filter((s): s is { key: string; kind: ManifestAssetKind } => s !== null)
        .map((s) => ({ kind: s.kind }));
      return memoryNeedsShareToken(memoryRow.memory_type, kinds) && !shareTokensByMemory.has(id);
    });
    if (eligibleWithoutToken.length > 0 && !options.apply) {
      // Dry-run must write NOTHING -- not even a "gap-filling" token mint.
      // Report the gap and use placeholder tokens locally so the rest of
      // the dry-run (manifest assembly, cover pick) still exercises the
      // real code path; the --apply run mints for real below.
      warnings.push(`DRY-RUN: would mint ${eligibleWithoutToken.length} NEW share token(s) for QR-eligible memories that have none active -- unexpected for an already-printed book, double-check the physical QR codes still resolve.`);
      for (const memory_id of eligibleWithoutToken) shareTokensByMemory.set(memory_id, 'dry-run-placeholder-token');
    } else if (eligibleWithoutToken.length > 0) {
      const newRows = eligibleWithoutToken.map((memory_id) => ({ memory_id, token: generateShareToken() }));
      const { error: insertTokensError } = await admin.from('media_share_tokens').insert(newRows);
      if (insertTokensError) return { bookDir, ok: false, errors: [`media_share_tokens mint failed: ${insertTokensError.message}`] };
      for (const row of newRows) shareTokensByMemory.set(row.memory_id, row.token);
      warnings.push(`Minted ${newRows.length} NEW share token(s) for QR-eligible memories that had none active -- unexpected for an already-printed book, double-check the physical QR codes still resolve.`);
    }
  }

  // ── Portraits: match by the id embedded in the local export's own
  // filenames, then re-query prod for EXACTLY that set. ──────────────────
  const localPortraitVersionIds = dedupeIds(
    (localManifest.portraits ?? [])
      .map((p) => (typeof p.file === 'string' ? extractPortraitVersionId(p.file) : null))
      .filter((id): id is string => id !== null),
  );
  let portraits: ReturnType<typeof buildManifestPortrait>[] = [];
  if (localPortraitVersionIds.length > 0) {
    const { data: portraitRows, error: portraitError } = await admin
      .from('family_member_portrait_versions')
      .select('id, reference_date, illustrated_profile_key, illustrated_profile_status, profile_picture_key')
      .in('id', localPortraitVersionIds);
    if (portraitError) return { bookDir, ok: false, errors: [`family_member_portrait_versions lookup failed: ${portraitError.message}`] };
    const portraitById = new Map<string, DbPortraitVersionRow>((portraitRows as DbPortraitVersionRow[]).map((row) => [row.id, row]));
    const resolved: ReturnType<typeof buildManifestPortrait>[] = [];
    for (const id of localPortraitVersionIds) {
      const row = portraitById.get(id);
      if (!row || row.illustrated_profile_status !== 'ready' || !row.illustrated_profile_key || !row.reference_date) {
        warnings.push(`portrait version ${id} (from the local export) no longer resolves to a ready portrait in prod -- omitted (the app tolerates a shorter portraits[] array).`);
        continue;
      }
      resolved.push(
        buildManifestPortrait({
          file: row.illustrated_profile_key,
          sourceFile: row.profile_picture_key,
          referenceDate: row.reference_date,
          dateOfBirth: childDateOfBirth,
        }),
      );
    }
    portraits = resolved;
  }

  // ── Per-memory manifest assembly. ───────────────────────────────────────
  const manifestMemories: Record<string, ManifestMemory> = {};
  for (const memoryId of resolvedMemoryIds) {
    const memoryRow = memoriesById.get(memoryId)!;
    const localMemory = localManifest.memories?.[memoryId];

    const taggedMembers: ManifestTaggedMember[] = [];
    for (const familyMemberId of tagsByMemory.get(memoryId) ?? []) {
      const familyMember = familyMembersById.get(familyMemberId);
      if (!familyMember) continue;
      taggedMembers.push(buildTaggedMember({ name: familyMember.name, dateOfBirth: familyMember.date_of_birth, memoryDate: memoryRow.memory_date }));
    }

    const milestones: ManifestMilestone[] = (milestonesByMemory.get(memoryId) ?? []).map((row) => buildManifestMilestone(row.milestone_id, row.detail));

    const assets = buildRebuiltAssets(memoryId, mediaByMemory.get(memoryId) ?? [], localMemory?.assets ?? [], warnings);

    let illustration: ManifestIllustration | null = null;
    if (memoryRow.illustration_key) {
      const localIllustration = localMemory?.illustration;
      if (localIllustration && isFiniteNumber(localIllustration.width) && isFiniteNumber(localIllustration.height)) {
        illustration = buildManifestIllustration({ file: memoryRow.illustration_key, width: localIllustration.width, height: localIllustration.height });
      } else {
        warnings.push(`memory ${memoryId}: prod has illustration_key but the local export had no matching illustration dimensions -- using a 100x100 sentinel.`);
        illustration = buildManifestIllustration({ file: memoryRow.illustration_key, width: 100, height: 100 });
      }
    } else if (localMemory?.illustration) {
      warnings.push(`memory ${memoryId}: the local export had an illustration but prod no longer has illustration_key -- omitted (rebuilt manifest reflects current prod truth).`);
    }

    manifestMemories[memoryId] = buildManifestMemory({
      memory: { memory_date: memoryRow.memory_date, memory_type: memoryRow.memory_type, content: memoryRow.content, emotion: memoryRow.emotion, topics: memoryRow.topics },
      assets,
      milestones,
      taggedMembers,
      engagement: engagementByMemory.get(memoryId) ?? 0,
      illustration,
      shareToken: shareTokensByMemory.get(memoryId) ?? null,
    });
  }

  const language: ManifestLanguage = localManifest.language === 'es' ? 'es' : 'en';
  const manifest: BookManifest = buildManifest({
    child: { id: childId, name: parsedOutline.child.name },
    scope: buildManifestScope(parsedOutline.scope.type, parsedOutline.window),
    outlineRun: typeof localManifest.outlineRun === 'string' ? localManifest.outlineRun : parsedOutline.runId,
    memories: manifestMemories,
    portraits,
    language,
    downloadFailures: [], // No downloads happen in this script -- see header comment.
    assetMode: 'preview',
  });

  const bookDocument = { outline: rawOutlineJson, manifest };
  const coverAssetKey = pickCoverAssetKey(bookDocument);
  const pageBudget = resolvePageBudget(rawOutlineJson);

  if (unresolvedMemoryIds.length > 0) {
    warnings.push(`${unresolvedMemoryIds.length} of ${referencedMemoryIds.length} referenced memory id(s) no longer resolve in prod: ${unresolvedMemoryIds.join(', ')} -- omitted from the manifest (the renderer already tolerates this, see this file's header comment).`);
  }

  const insertRow: Record<string, unknown> = {
    family_id: familyId,
    child_id: childId,
    requested_by: requestedBy,
    scope_kind: scopeKind,
    scope_start_date: scopeStartDate,
    scope_end_date: scopeEndDate,
    scope_label: scopeLabel,
    status: 'ready',
    page_budget: pageBudget,
    book_document: bookDocument,
    cover_asset_key: coverAssetKey,
    generation_completed_at: new Date().toISOString(),
    // workflow_instance_id / generation_attempt_id / failure_reason: left
    // unset (null) -- memory_books_ready_has_document is the ONLY check
    // constraint gating status = 'ready', and it only requires
    // book_document (verified against
    // supabase/migrations/20260901100000_memory_books.sql). created_at:
    // left unset so the column default (now()) applies.
  };

  return {
    bookDir,
    ok: true,
    insertRow,
    summary: {
      bookDir,
      childId,
      childName: parsedOutline.child.name,
      familyId,
      requestedBy,
      scopeLabel,
      scopeStartDate,
      scopeEndDate,
      memoriesReferenced: referencedMemoryIds.length,
      memoriesResolved: resolvedMemoryIds.length,
      unresolvedMemoryIds,
      coverAssetKey,
      pageBudget,
      existingDuplicates,
      willInsert,
      warnings,
    },
  };
}

// ── Reporting + main ─────────────────────────────────────────────────────

function printSummary(summary: BookImportSummary): void {
  console.log(`\n=== ${summary.bookDir} ===`);
  console.log(`  child: ${summary.childId} ("${summary.childName}") -- family ${summary.familyId}`);
  console.log(`  requested_by (family owner): ${summary.requestedBy}`);
  console.log(`  scope: age_year "${summary.scopeLabel}" [${summary.scopeStartDate}, ${summary.scopeEndDate}]`);
  console.log(`  page_budget: ${summary.pageBudget}`);
  console.log(`  memories: ${summary.memoriesResolved}/${summary.memoriesReferenced} resolved in prod` + (summary.unresolvedMemoryIds.length > 0 ? ` (${summary.unresolvedMemoryIds.length} unresolved: ${summary.unresolvedMemoryIds.join(', ')})` : ''));
  console.log(`  cover_asset_key: ${summary.coverAssetKey ?? '(null -- no candidate cleared the width gate)'}`);
  if (summary.existingDuplicates.length > 0) {
    console.log(`  EXISTING duplicate row(s) for this exact scope: ${summary.existingDuplicates.map((r) => `${r.id} (${r.status})`).join(', ')}`);
  }
  console.log(`  action: ${summary.willInsert ? 'WOULD INSERT' : 'WOULD SKIP (duplicate exists -- pass --force-duplicate to insert anyway)'}`);
  for (const warning of summary.warnings) {
    console.log(`  WARNING: ${warning}`);
  }
}

async function main(): Promise<void> {
  let options: CliOptions;
  try {
    options = parseArgs(Deno.args);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    Deno.exit(1);
    return;
  }

  console.log(options.apply ? 'Running in --apply mode -- rows WILL be inserted.' : 'Dry run (default) -- no rows will be written. Pass --apply to insert.');

  const admin = createAdminClient();
  let hadError = false;
  const toInsert: Array<{ bookDir: string; row: Record<string, unknown> }> = [];

  for (const bookDir of options.bookDirs) {
    const result = await processBook(admin, bookDir, { forceDuplicate: options.forceDuplicate, apply: options.apply });
    if (!result.ok) {
      hadError = true;
      console.log(`\n=== ${result.bookDir} ===`);
      for (const error of result.errors) console.log(`  ERROR: ${error}`);
      continue;
    }
    printSummary(result.summary);
    if (result.summary.willInsert) toInsert.push({ bookDir: result.bookDir, row: result.insertRow });
  }

  if (options.apply) {
    for (const { bookDir, row } of toInsert) {
      const { data, error } = await admin.from('memory_books').insert(row).select('id').maybeSingle();
      if (error) {
        hadError = true;
        console.log(`\n${bookDir}: INSERT FAILED -- ${error.message}`);
      } else {
        console.log(`\n${bookDir}: INSERTED as memory_books.id = ${data?.id}`);
      }
    }
  } else if (toInsert.length > 0) {
    console.log(`\n${toInsert.length} book(s) would be inserted. Re-run with --apply to actually insert.`);
  }

  if (hadError) Deno.exit(1);
}

if (import.meta.main) await main();
