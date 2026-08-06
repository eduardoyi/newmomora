/**
 * Backfill: re-encode portrait/illustration objects whose REAL stored bytes
 * don't match their key's extension.
 *
 * Root cause (source-of-the-mismatch fix -- see
 * generate-portrait-illustration/index.ts's completeGeneration and
 * generate-illustration/index.ts's legacy publication path, both of which
 * now sniff+correct this at generation time; and compose-share-card/
 * index.ts's resolveImageMimeType header comment for the production-
 * incident history: a satori "Invalid WebP" crash, then a multi-MB PNG
 * payload once the crash itself was defended against by sniffing on the
 * READ side): OpenAI's images/edits endpoint has been observed to ignore
 * `output_format: 'webp'` and return PNG (sometimes JPEG) bytes anyway,
 * while the generators uploaded those bytes under a `.webp`-suffixed key
 * regardless. Existing rows written before the source fix can still carry
 * this mismatch -- typically a ~2-2.2MB PNG under a `.webp` key.
 *
 * Scans three sources:
 *   - `family_member_portrait_versions.illustrated_profile_key` (versioned
 *     portraits -- the live, served pointer)
 *   - `memories.illustration_key` (versioned memory illustrations)
 *   - `family_members.illustrated_profile_key` (LEGACY, pre-portrait-
 *     versions singular pointer -- read-only for authenticated writes since
 *     20260715120000_portrait_timeline.sql's
 *     `enforce_legacy_family_portrait_cutoff` trigger, and no live consumer
 *     resolves avatars from it anymore: src/utils/portrait-versions.ts's
 *     `resolveMemberPortraitFields` only reads the versioned table. Still
 *     included because hard-delete-expired-accounts/index.ts deletes
 *     whatever object it points at, so a multi-MB mismatched object sitting
 *     under it is real, billed R2 storage worth reclaiming.)
 *
 * Deliberately NEVER touches: `family_member_portrait_versions.
 * generation_output_key`, `portrait_generation_jobs.output_key`,
 * `memory_illustration_jobs.output_key`. Those are EPHEMERAL in-flight
 * attempt pointers that get cleared to null on completion/failure -- not
 * served images, and touching one risks racing a live generation attempt.
 * (Confirmed, not assumed: all of the columns this script DOES touch, plus
 * those three ephemeral ones, are already read directly off their DB
 * columns by hard-delete-expired-accounts/index.ts's `collectFamilyObjectKeys`
 * -- deletion coverage for a re-keyed object is therefore automatic and
 * needed no changes there.)
 *
 * Two different fix strategies, matched to what each column actually is:
 *
 *  - VERSIONED columns (family_member_portrait_versions, memories): the
 *    never-reuse-key invariant is preserved. A mismatch is re-encoded and
 *    uploaded under a FRESH key (never overwritten in place), the DB column
 *    is updated with an optimistic-concurrency guard (skipped if the row
 *    changed since it was read -- e.g. a live regeneration raced this
 *    script), and only THEN is the OLD object best-effort deleted.
 *
 *  - The one LEGACY singular column (family_members.illustrated_profile_key)
 *    has no versioned/immutable-key scheme to move to (its key builder,
 *    `buildFamilyPortraitKey`, is a single fixed position per member, not
 *    per-attempt). A PNG mismatch there is re-encoded and re-uploaded IN
 *    PLACE at the SAME key/extension -- the same size-only compromise
 *    generate-portrait-illustration's live path makes for the identical
 *    DB-enforced-key-format reason (see that file's completeGeneration
 *    comment). No DB write is needed for this case; only the R2 object's
 *    bytes change. Real (non-PNG) bytes there are left alone -- there is no
 *    size win worth a write.
 *
 * Idempotent: selection is sniff-based (compares each object's REAL bytes'
 * format, via `_shared/image-bytes.ts`'s `resolveRealImageBytesForStorage`,
 * against its key's current extension) rather than a one-time "processed"
 * flag, so re-running finds nothing left to do.
 *
 * CACHE NOTE (client interplay -- see this package's implementation
 * report): expo-image's `cacheKey` is pinned to the R2 object key itself
 * (src/utils/media-image-source.ts's header comment: "cacheKey = objectKey
 * can never pin stale bytes"; src/utils/portrait-versions.ts's
 * `resolveMemberPortraitFields` sets both `avatarImageKey` AND
 * `avatarUpdatedAt` to the resolved object key). A fresh key from this
 * script is therefore automatically a different cache identity -- clients
 * refetch naturally, no separate cache-version bump needed. A memory's
 * ALREADY-COMPOSED share card (the store-through cache PNG) is a
 * self-contained raster: it embeds whatever portrait bytes were live at
 * compose time and keeps rendering correctly regardless of this script
 * re-keying the source portrait afterward.
 *
 * Dry run (reports what would be done, touches nothing) -- same invocation
 * style as the other backfill scripts in this directory:
 * deno run --allow-all --env-file=supabase/.env.local --env-file=.env.local \
 *   supabase/scripts/backfill-portrait-reencode.ts
 *
 * Apply:
 * ... backfill-portrait-reencode.ts --apply
 *
 * Optional flags:
 *   --limit N        first N candidate rows only (per source table)
 *   --concurrency N  worker pool size (default 2 -- deliberately modest:
 *                    unlike a metadata-only backfill, every candidate here
 *                    downloads, decodes, and re-encodes a real image)
 *   --verify [N]     skip the backfill; instead sample N ALREADY-BACKFILLED
 *                     rows (default 10) and confirm the current object
 *                     downloads, sniffs to a format matching its extension
 *
 * Requires SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, R2_ACCESS_KEY_ID,
 * R2_SECRET_ACCESS_KEY, R2_ENDPOINT, R2_BUCKET (same names as every other
 * script in this directory -- no new secrets).
 */
import { createClient } from 'npm:@supabase/supabase-js@2';

import { resolveRealImageBytesForStorage, sniffImageFormat, type StoredImageExtension } from '../functions/_shared/image-bytes.ts';
import { MAX_ILLUSTRATION_REFERENCE_EDGE, MAX_PORTRAIT_REFERENCE_EDGE } from '../functions/_shared/image-limits.ts';
import { deleteObject, getObjectBytes, putObjectBytes } from '../functions/_shared/r2.ts';
import { buildMemoryIllustrationKey, buildPortraitVersionAttemptKey, parseStorageKey } from '../functions/_shared/storage-keys.ts';

const DATABASE_PAGE_SIZE = 500;
const DEFAULT_CONCURRENCY = 2;
const DEFAULT_VERIFY_SAMPLE_SIZE = 10;
// Deliberately modest: this script re-encodes real images (CPU + a PUT + a
// DELETE per fixed row), unlike the lighter metadata-only backfills in this
// directory.
const PACE_DELAY_MS = 150;

// ---------------------------------------------------------------------------
// Pure helpers (exported + covered by backfill-portrait-reencode.test.ts).
// ---------------------------------------------------------------------------

export function extensionOf(objectKey: string): string {
  const dot = objectKey.lastIndexOf('.');
  return dot === -1 ? '' : objectKey.slice(dot + 1).toLowerCase();
}

/**
 * Mints a FRESH portrait-attempt key for the same version/member, carrying
 * the RESOLVED (real-bytes) extension -- never the old key's extension.
 * Throws rather than guessing when `oldKey` isn't a portrait attempt key
 * (defensive; the caller only ever passes keys read straight off
 * `family_member_portrait_versions.illustrated_profile_key`).
 */
export function deriveFreshPortraitVersionKey(
  oldKey: string,
  extension: StoredImageExtension,
  freshAttemptId: string,
): string {
  const parsed = parseStorageKey(oldKey);
  if (!parsed || parsed.kind !== 'portrait_version_portrait' || !parsed.portraitVersionId) {
    throw new Error(`Cannot parse portrait attempt key: ${oldKey}`);
  }
  return buildPortraitVersionAttemptKey(
    parsed.ownerUserId,
    parsed.entityId,
    parsed.portraitVersionId,
    freshAttemptId,
    extension,
  );
}

/** Same idea as `deriveFreshPortraitVersionKey`, for a memory illustration key. */
export function deriveFreshIllustrationKey(
  oldKey: string,
  extension: StoredImageExtension,
  freshGenerationId: string,
): string {
  const parsed = parseStorageKey(oldKey);
  if (!parsed || parsed.kind !== 'memory_illustration') {
    throw new Error(`Cannot parse memory illustration key: ${oldKey}`);
  }
  return buildMemoryIllustrationKey(parsed.ownerUserId, parsed.entityId, freshGenerationId, extension);
}

// ---------------------------------------------------------------------------
// Script entry point -- everything below has side effects (network/env) and
// is intentionally not exported/tested directly; the pure helpers above are.
// ---------------------------------------------------------------------------

function requireEnv(name: string): string {
  const value = Deno.env.get(name);
  if (!value) {
    throw new Error(`Missing ${name}`);
  }
  return value;
}

function getFlagValue(name: string): string | undefined {
  const index = Deno.args.indexOf(name);
  if (index === -1) return undefined;
  const value = Deno.args[index + 1];
  return value === undefined || value.startsWith('--') ? undefined : value;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function withOneRetry<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (firstError) {
    console.warn('Transient failure, retrying once:', firstError instanceof Error ? firstError.message : firstError);
    return await fn();
  }
}

type ReencodeTarget =
  | { source: 'portrait_version'; rowId: string; oldKey: string }
  | { source: 'memory_illustration'; rowId: string; oldKey: string }
  | { source: 'legacy_family_member'; rowId: string; oldKey: string };

interface ProcessCounters {
  reencoded: number;
  alreadyConsistent: number;
  skippedUnrecognized: number;
  skippedConcurrentUpdate: number;
  failed: number;
  totalOldBytes: number;
  totalNewBytes: number;
}

function newCounters(): ProcessCounters {
  return {
    reencoded: 0,
    alreadyConsistent: 0,
    skippedUnrecognized: 0,
    skippedConcurrentUpdate: 0,
    failed: 0,
    totalOldBytes: 0,
    totalNewBytes: 0,
  };
}

async function main(): Promise<void> {
  const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? requireEnv('EXPO_PUBLIC_SUPABASE_URL');
  const serviceRoleKey = requireEnv('SUPABASE_SERVICE_ROLE_KEY');
  // Nested closures below (rather than a standalone function taking `admin`
  // as a parameter) so `admin`'s type flows from this `createClient(...)`
  // call by inference -- giving it a standalone parameter type trips a known
  // supabase-js generic-default mismatch across separate call sites (same
  // reasoning as backfill-media-previews.ts's `runVerification`).
  const admin = createClient(supabaseUrl, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  // Generic over the page-fetcher's own resolved row type (inferred from
  // each LITERAL call site's `.from('...').select('...')` chain below) --
  // deliberately NOT a generic-table/generic-column helper: a dynamic
  // `.from(table)`/`.select(variableString)` trips supabase-js's typed
  // query-builder overload resolution (`GenericStringError`/`ParserError`
  // types) the moment the select/table name isn't a string literal at the
  // call site. Every other backfill script in this directory sidesteps the
  // same issue by hardcoding one query per source table; this generator
  // does the same, just factored so the offset/limit paging loop isn't
  // repeated three times.
  async function* pageRows<T>(
    tableLabel: string,
    fetchPage: (offset: number) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>,
    limit: number | undefined,
  ): AsyncGenerator<T> {
    let yielded = 0;
    for (let offset = 0; ; offset += DATABASE_PAGE_SIZE) {
      const { data, error } = await fetchPage(offset);
      if (error) {
        throw new Error(`Could not load ${tableLabel} rows: ${error.message}`);
      }
      for (const row of data ?? []) {
        if (limit !== undefined && yielded >= limit) return;
        yielded += 1;
        yield row;
      }
      if (!data || data.length < DATABASE_PAGE_SIZE) break;
      if (limit !== undefined && yielded >= limit) return;
    }
  }

  async function verifyRow(
    tableLabel: string,
    rowId: string,
    objectKey: string,
    counts: { passed: number; failed: number },
  ): Promise<void> {
    try {
      const bytes = await getObjectBytes(objectKey);
      const sniffed = sniffImageFormat(bytes);
      const expectedExtension = sniffed === 'png' || sniffed === 'jpeg' ? 'jpg' : sniffed === 'webp' ? 'webp' : null;
      const actualExtension = extensionOf(objectKey);
      // Legacy singular family_members portraits live at a FIXED key
      // (`.../family/{memberId}/portrait.webp`) with no versioning scheme, so
      // the backfill re-encodes them IN PLACE: JPEG bytes under the frozen
      // `.webp` name is the intended, documented end state (all consumers
      // sniff bytes; Content-Type is stored correctly). Report it as such
      // rather than as a failure.
      const isLegacyInPlacePortrait = objectKey.endsWith('/portrait.webp') && sniffed === 'jpeg';
      if (isLegacyInPlacePortrait) {
        counts.passed += 1;
        console.log(`${tableLabel} ${rowId}: OK (legacy in-place, jpeg under frozen .webp key -- expected) (${objectKey}, ${bytes.length}B)`);
        return;
      }
      if (!expectedExtension || expectedExtension !== actualExtension) {
        throw new Error(`sniffed format ${String(sniffed)} does not match extension .${actualExtension} (${objectKey})`);
      }
      counts.passed += 1;
      console.log(`${tableLabel} ${rowId}: OK (${objectKey}, ${bytes.length}B, sniffed ${sniffed})`);
    } catch (verifyError) {
      counts.failed += 1;
      console.error(`${tableLabel} ${rowId}: verification failed`, verifyError instanceof Error ? verifyError.message : verifyError);
    }
  }

  async function runVerification(sampleSize: number): Promise<void> {
    const counts = { passed: 0, failed: 0 };

    const { data: portraitVersionRows, error: portraitVersionError } = await admin
      .from('family_member_portrait_versions')
      .select('id, illustrated_profile_key')
      .not('illustrated_profile_key', 'is', null)
      .limit(sampleSize);
    if (portraitVersionError) throw new Error(`Could not sample family_member_portrait_versions: ${portraitVersionError.message}`);
    for (const row of portraitVersionRows ?? []) {
      await verifyRow('family_member_portrait_versions', row.id, row.illustrated_profile_key as string, counts);
    }

    const { data: memoryRows, error: memoryError } = await admin
      .from('memories')
      .select('id, illustration_key')
      .not('illustration_key', 'is', null)
      .limit(sampleSize);
    if (memoryError) throw new Error(`Could not sample memories: ${memoryError.message}`);
    for (const row of memoryRows ?? []) {
      await verifyRow('memories', row.id, row.illustration_key as string, counts);
    }

    const { data: familyMemberRows, error: familyMemberError } = await admin
      .from('family_members')
      .select('id, illustrated_profile_key')
      .not('illustrated_profile_key', 'is', null)
      .limit(sampleSize);
    if (familyMemberError) throw new Error(`Could not sample family_members: ${familyMemberError.message}`);
    for (const row of familyMemberRows ?? []) {
      await verifyRow('family_members', row.id, row.illustrated_profile_key as string, counts);
    }

    console.log(`Verification finished: ${counts.passed} passed, ${counts.failed} failed`);
    if (counts.failed > 0) {
      Deno.exit(1);
    }
  }

  const shouldVerify = Deno.args.includes('--verify');
  if (shouldVerify) {
    const sampleSize = Number(getFlagValue('--verify') ?? DEFAULT_VERIFY_SAMPLE_SIZE);
    await runVerification(sampleSize);
    return;
  }

  const shouldApply = Deno.args.includes('--apply');
  const limitFlag = getFlagValue('--limit');
  const limit = limitFlag ? Number(limitFlag) : undefined;
  const concurrencyFlag = getFlagValue('--concurrency');
  const concurrency = concurrencyFlag ? Number(concurrencyFlag) : DEFAULT_CONCURRENCY;

  const targets: ReencodeTarget[] = [];

  // 1. family_member_portrait_versions -- the live, served portrait pointer.
  for await (
    const row of pageRows(
      'family_member_portrait_versions',
      (offset) =>
        admin
          .from('family_member_portrait_versions')
          .select('id, illustrated_profile_key')
          .not('illustrated_profile_key', 'is', null)
          .order('id', { ascending: true })
          .range(offset, offset + DATABASE_PAGE_SIZE - 1),
      limit,
    )
  ) {
    targets.push({ source: 'portrait_version', rowId: row.id, oldKey: row.illustrated_profile_key as string });
  }

  // 2. memories -- the live, served illustration pointer.
  for await (
    const row of pageRows(
      'memories',
      (offset) =>
        admin
          .from('memories')
          .select('id, illustration_key')
          .not('illustration_key', 'is', null)
          .order('id', { ascending: true })
          .range(offset, offset + DATABASE_PAGE_SIZE - 1),
      limit,
    )
  ) {
    targets.push({ source: 'memory_illustration', rowId: row.id, oldKey: row.illustration_key as string });
  }

  // 3. family_members -- legacy singular pointer (see header comment).
  for await (
    const row of pageRows(
      'family_members',
      (offset) =>
        admin
          .from('family_members')
          .select('id, illustrated_profile_key')
          .not('illustrated_profile_key', 'is', null)
          .order('id', { ascending: true })
          .range(offset, offset + DATABASE_PAGE_SIZE - 1),
      limit,
    )
  ) {
    targets.push({ source: 'legacy_family_member', rowId: row.id, oldKey: row.illustrated_profile_key as string });
  }

  if (targets.length === 0) {
    console.log('No portrait/illustration rows to scan');
    return;
  }

  console.log(`Scanning ${targets.length} candidate row(s) across all three sources`);
  console.log(`${shouldApply ? 'Applying' : 'Dry-running'} portrait/illustration byte re-encode`);

  const counters = newCounters();

  async function processTarget(target: ReencodeTarget): Promise<void> {
    const label = `${target.source} ${target.rowId}`;
    try {
      const bytes = await withOneRetry(() => getObjectBytes(target.oldKey));
      const currentExtension = extensionOf(target.oldKey);
      const maxEdge = target.source === 'memory_illustration'
        ? MAX_ILLUSTRATION_REFERENCE_EDGE
        : MAX_PORTRAIT_REFERENCE_EDGE;
      const resolved = await resolveRealImageBytesForStorage(bytes, maxEdge);

      if (sniffImageFormat(bytes) === null) {
        counters.skippedUnrecognized += 1;
        console.warn(`${label}: unrecognized byte format at ${target.oldKey}, skipping`);
        return;
      }

      if (resolved.extension === currentExtension) {
        counters.alreadyConsistent += 1;
        return;
      }

      // Only the legacy singular column re-uses its key; the two versioned
      // columns always mint a fresh one (never-reuse-key invariant).
      if (target.source === 'legacy_family_member') {
        if (!resolved.reencoded) {
          // Already-jpeg/webp bytes under a mismatched extension: nothing
          // that a size-only fix can improve here, and there is no
          // versioned key scheme to correct the extension into. Leave it.
          counters.alreadyConsistent += 1;
          return;
        }
        console.log(`${label}: ${bytes.length}B -> ${resolved.bytes.length}B${shouldApply ? '' : ' (dry run)'} (in place at ${target.oldKey})`);
        if (shouldApply) {
          await withOneRetry(() => putObjectBytes(target.oldKey, resolved.bytes, resolved.contentType));
        }
        counters.reencoded += 1;
        counters.totalOldBytes += bytes.length;
        counters.totalNewBytes += resolved.bytes.length;
        return;
      }

      const freshId = crypto.randomUUID();
      const freshKey = target.source === 'portrait_version'
        ? deriveFreshPortraitVersionKey(target.oldKey, resolved.extension, freshId)
        : deriveFreshIllustrationKey(target.oldKey, resolved.extension, freshId);

      console.log(
        `${label}: ${bytes.length}B -> ${resolved.bytes.length}B${shouldApply ? '' : ' (dry run)'} ` +
          `${target.oldKey} -> ${freshKey}`,
      );

      if (!shouldApply) {
        counters.reencoded += 1;
        counters.totalOldBytes += bytes.length;
        counters.totalNewBytes += resolved.bytes.length;
        return;
      }

      await withOneRetry(() => putObjectBytes(freshKey, resolved.bytes, resolved.contentType));

      const table = target.source === 'portrait_version' ? 'family_member_portrait_versions' : 'memories';
      const column = target.source === 'portrait_version' ? 'illustrated_profile_key' : 'illustration_key';
      const { data: updated, error: updateError } = await admin
        .from(table)
        .update({ [column]: freshKey })
        .eq('id', target.rowId)
        .eq(column, target.oldKey)
        .select('id');
      if (updateError) throw updateError;

      if (!updated || updated.length === 0) {
        // A live generation (or a concurrent run of this same script)
        // already changed this row since it was read. The new object we
        // just uploaded is an orphan pointing nowhere -- clean it up and
        // leave the row alone; never touch the old object in this branch,
        // some other writer now owns it.
        counters.skippedConcurrentUpdate += 1;
        console.warn(`${label}: row changed since it was read, discarding the new object and leaving it alone`);
        await deleteObject(freshKey).catch(() => undefined);
        return;
      }

      // Old object is deleted only AFTER the row update committed -- never
      // in the other order (see header comment).
      await deleteObject(target.oldKey).catch((error) => {
        console.warn(`${label}: best-effort delete of the old object failed`, error instanceof Error ? error.message : error);
      });

      counters.reencoded += 1;
      counters.totalOldBytes += bytes.length;
      counters.totalNewBytes += resolved.bytes.length;
    } catch (error) {
      counters.failed += 1;
      console.error(`${label}: failed`, error instanceof Error ? error.message : 'unknown error');
    } finally {
      await delay(PACE_DELAY_MS);
    }
  }

  let nextIndex = 0;
  async function runWorker(): Promise<void> {
    while (nextIndex < targets.length) {
      const target = targets[nextIndex];
      nextIndex += 1;
      await processTarget(target);
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, targets.length) }, () => runWorker()));

  console.log(
    `Finished: ${counters.reencoded} object(s) ${shouldApply ? 're-encoded' : 'would be re-encoded'}, ` +
      `${counters.alreadyConsistent} already consistent, ${counters.skippedUnrecognized} unrecognized bytes (skipped), ` +
      `${counters.skippedConcurrentUpdate} skipped (concurrent update), ${counters.failed} failed`,
  );
  console.log(
    `Bytes: ${counters.totalOldBytes} original -> ${counters.totalNewBytes} re-encoded` +
      (counters.totalOldBytes > 0
        ? ` (${(100 * (1 - counters.totalNewBytes / counters.totalOldBytes)).toFixed(1)}% reduction)`
        : ''),
  );

  if (counters.failed > 0) {
    Deno.exit(1);
  }
}

if (import.meta.main) {
  await main();
}
