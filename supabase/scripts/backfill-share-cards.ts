/**
 * Backfill the store-through share-card cache (docs/plans/
 * share-card-store-through.md) for every existing memory/asset that
 * predates the warm hooks (W3) or was never shared -- so the FIRST real
 * share of an old memory is already a cache hit instead of paying a cold
 * WORKER_RESOURCE_LIMIT-policed compose live, in front of the user. Mirrors
 * the structure of backfill-media-previews.ts: dry-run by default,
 * DATABASE_PAGE_SIZE-batched candidate paging, progress logging, a final
 * report.
 *
 * Unlike every other backfill script in this directory, this one does NOT
 * touch R2/the DB directly for the actual work -- it calls the DEPLOYED
 * `compose-share-card` function in `warm: true` mode over HTTP, exactly
 * like the client's `warmShareCardFireAndForget` (src/services/
 * share-card.ts) does, so the exact same compose/store/authz code path a
 * real warm hook exercises is what backfills these cards. The function
 * enforces normal role-based auth (active family member; a
 * viewer-sharing-disabled family still 403s a viewer) -- see
 * authorizeShareCardAccessFromQueryRow, supabase/functions/
 * compose-share-card/index.ts -- so every request here is made AS the
 * target's FAMILY OWNER (always allowed to share, regardless of the
 * viewer-sharing toggle), via a real minted session (service-role
 * `generateLink` + anon-key `verifyOtp`, the same pattern
 * seed-demo-account.ts's `createUserClient` uses to mint a demo session).
 *
 * Dry run (reports what would be warmed, touches nothing but the read-only
 * candidate selection + session minting):
 * deno run --allow-all --env-file=supabase/.env.local --env-file=.env.local \
 *   supabase/scripts/backfill-share-cards.ts
 * # or: npm run backfill:share-cards
 *
 * Apply (actually fires the warm requests):
 * ... supabase/scripts/backfill-share-cards.ts --apply
 * # or: npm run backfill:share-cards -- --apply
 *
 * Optional flags:
 *   --limit N           first N candidate targets only (memories first,
 *                        then media assets)
 *   --memory-id <uuid>  scope to a single memory (pilot run)
 *
 * Re-runnable: candidate selection is `share_card_key IS NULL`, and a
 * successful warm always sets that column (compose-share-card's
 * storeShareCardAndUpdateCache) -- so a second run only ever picks up
 * targets that are still missing a card (including ones that gave up on a
 * prior run).
 *
 * Requires SUPABASE_URL (or EXPO_PUBLIC_SUPABASE_URL), SUPABASE_ANON_KEY
 * (or EXPO_PUBLIC_SUPABASE_ANON_KEY), SUPABASE_SERVICE_ROLE_KEY -- same
 * names as every other script in this directory, no new secrets.
 *
 * NEVER prints secrets (tokens, keys) or memory content (captions) --
 * AGENTS.md logging discipline, same as compose-share-card's own server
 * logs. Every log line below is an id (memory/asset/family id), a count, or
 * a status code.
 */
import { createClient, type SupabaseClient } from 'npm:@supabase/supabase-js@2';

import { ALLOWED_IMAGE_CONTENT_TYPES } from '../../src/utils/media-validation.ts';

const DATABASE_PAGE_SIZE = 500;

// ---------------------------------------------------------------------------
// Pure helpers (exported + covered by backfill-share-cards.test.ts).
// ---------------------------------------------------------------------------

/** A single warm target: either a text_only/text_illustration memory's
 * per-MEMORY card, or a media memory's per-ASSET card -- mirrors
 * compose-share-card's own two cache-target shapes
 * (resolveShareCardCacheTarget, index.ts). `familyId` is carried along so
 * the caller can resolve/reuse a family-owner session without a second
 * lookup per target. */
export interface ShareCardBackfillTarget {
  kind: 'memory' | 'asset';
  memoryId: string;
  /** Only set for kind === 'asset'. */
  assetId?: string;
  familyId: string;
}

export interface MemoryTargetRow {
  id: string;
  family_id: string;
}

export interface MediaAssetTargetRow {
  id: string;
  memory_id: string;
  content_type: string;
  /** Nested via `memories!inner(family_id)` -- null only if the FK is
   * somehow dangling (never expected; defensive-only, same posture as
   * compose-share-card's own row shapes). */
  memories: { family_id: string } | null;
}

/** Shapes `memories` rows (text_only/text_illustration, `share_card_key IS
 * NULL`) into per-MEMORY warm targets. Pure/sync -- no DB/network. */
export function shapeMemoryTargets(rows: MemoryTargetRow[]): ShareCardBackfillTarget[] {
  return rows.map((row) => ({ kind: 'memory', memoryId: row.id, familyId: row.family_id }));
}

/** Shapes `memory_media` rows (image content types only, `share_card_key IS
 * NULL`) into per-ASSET warm targets. Drops any row whose nested `memories`
 * join came back null (dangling FK -- defensive, never expected) rather
 * than throwing, since one bad row must never abort the whole backfill. */
export function shapeMediaAssetTargets(rows: MediaAssetTargetRow[]): ShareCardBackfillTarget[] {
  return rows
    .filter((row): row is MediaAssetTargetRow & { memories: { family_id: string } } => row.memories !== null)
    .map((row) => ({ kind: 'asset', memoryId: row.memory_id, assetId: row.id, familyId: row.memories.family_id }));
}

/** Short, id-only description for progress/report logging -- never includes
 * memory content (AGENTS.md logging discipline). */
export function describeTarget(target: ShareCardBackfillTarget): string {
  return target.kind === 'asset'
    ? `memory ${target.memoryId} asset ${target.assetId}`
    : `memory ${target.memoryId}`;
}

/** Supabase Edge Functions' platform resource-exhaustion status -- the only
 * status worth retrying (mirrors composeShareCard's/warmShareCardFireAndForget's
 * SHARE_CARD_RETRYABLE_STATUS, src/services/share-card.ts). Duplicated here
 * (not imported) because this script is a standalone Deno entry point, same
 * as every other cross-boundary constant in this codebase that Deno edge
 * functions/scripts can't import from src/ (see e.g. compose-share-card/
 * index.ts's own DEFAULT_MEDIA_ASPECT_RATIO comment for the same rationale).
 */
export const SHARE_CARD_RETRYABLE_STATUS = 546;

/** Max total attempts per target (initial + retries) before giving up. */
export const BACKFILL_WARM_MAX_ATTEMPTS = 6;

/** Fixed backoff between retry attempts, only on `SHARE_CARD_RETRYABLE_STATUS`. */
export const BACKFILL_WARM_RETRY_BACKOFF_MS = 3000;

/** How far apart consecutive warm HTTP requests should be paced, to respect
 * the deployed function's warm rate bucket (30/minute/user,
 * SHARE_CARD_WARM_RATE_LIMIT_MAX_PER_WINDOW) -- 2.5s gives headroom over the
 * strict 2s/request ceiling that bucket implies. */
export const BACKFILL_REQUEST_PACE_MS = 2500;

export type WarmRetryDecision =
  | { action: 'success' }
  | { action: 'retry'; delayMs: number }
  | { action: 'give_up' };

/**
 * Pure retry/backoff decision for a single warm attempt's outcome.
 * `status` is the HTTP status the warm endpoint returned (204 on success,
 * per compose-share-card's `warm: true` contract), or `'network_error'` for
 * a thrown fetch failure. Only `SHARE_CARD_RETRYABLE_STATUS` (546) is ever
 * retried, and only while `attempt < maxAttempts` -- every other outcome
 * (429, 4xx, 5xx, a network error) gives up immediately: retrying a 429
 * would only burn the warm bucket further (the exact production failure
 * mode this whole fix targets on the client's cold path too -- see
 * src/services/share-card.ts's composeShareCard/performWarmShareCardWithRetries),
 * and nothing else is fixed by retrying either.
 */
export function decideWarmRetry(
  status: number | 'network_error',
  attempt: number,
  maxAttempts = BACKFILL_WARM_MAX_ATTEMPTS,
): WarmRetryDecision {
  if (status === 204) {
    return { action: 'success' };
  }
  if (status === SHARE_CARD_RETRYABLE_STATUS && attempt < maxAttempts) {
    return { action: 'retry', delayMs: BACKFILL_WARM_RETRY_BACKOFF_MS };
  }
  return { action: 'give_up' };
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

function supabaseUrl(): string {
  return Deno.env.get('SUPABASE_URL') ?? requireEnv('EXPO_PUBLIC_SUPABASE_URL');
}

function supabaseAnonKey(): string {
  return Deno.env.get('SUPABASE_ANON_KEY') ?? requireEnv('EXPO_PUBLIC_SUPABASE_ANON_KEY');
}

function getFlagValue(name: string): string | undefined {
  const index = Deno.args.indexOf(name);
  if (index === -1) {
    return undefined;
  }
  const value = Deno.args[index + 1];
  return value === undefined || value.startsWith('--') ? undefined : value;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function warmEndpointUrl(): string {
  return `${supabaseUrl().replace(/\/$/, '')}/functions/v1/compose-share-card`;
}

/** Resolves + mints a real user session for a family's OWNER (role ===
 * 'owner'), via the SAME generateLink/verifyOtp pattern
 * seed-demo-account.ts's `createUserClient` uses for its demo session --
 * service-role `generateLink` (no email delivery, just mints a magic-link
 * token) followed by an anon-key client `verifyOtp` against that token.
 * Cached per family id (a `Map<familyId, Promise<string | null>>` passed in
 * by the caller) so a family with many targets only mints one session.
 * Returns null (never throws) when the family has no resolvable owner or
 * minting fails -- every target in that family is then reported as given
 * up rather than aborting the whole run. Never logs the owner's email or
 * the minted token (AGENTS.md logging discipline / secrets rule).
 */
async function mintFamilyOwnerAccessToken(admin: SupabaseClient, familyId: string): Promise<string | null> {
  const { data: membership, error: membershipError } = await admin
    .from('family_memberships')
    .select('user_id')
    .eq('family_id', familyId)
    .eq('role', 'owner')
    .limit(1)
    .maybeSingle();

  if (membershipError || !membership) {
    console.error(`Could not resolve an owner for family ${familyId}, skipping its targets`);
    return null;
  }

  const { data: userData, error: userError } = await admin.auth.admin.getUserById(membership.user_id);
  if (userError || !userData.user?.email) {
    console.error(`Could not resolve owner account for family ${familyId}, skipping its targets`);
    return null;
  }

  const { data: linkData, error: linkError } = await admin.auth.admin.generateLink({
    type: 'magiclink',
    email: userData.user.email,
  });
  if (linkError || !linkData.properties?.hashed_token) {
    console.error(`Could not mint an owner session for family ${familyId}, skipping its targets`);
    return null;
  }

  const verifier = createClient(supabaseUrl(), supabaseAnonKey(), {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const { data: sessionData, error: sessionError } = await verifier.auth.verifyOtp({
    type: 'magiclink',
    token_hash: linkData.properties.hashed_token,
  });
  if (sessionError || !sessionData.session) {
    console.error(`Could not verify an owner session for family ${familyId}, skipping its targets`);
    return null;
  }

  return sessionData.session.access_token;
}

function getOrMintFamilyOwnerAccessToken(
  admin: SupabaseClient,
  familyId: string,
  cache: Map<string, Promise<string | null>>,
): Promise<string | null> {
  const cached = cache.get(familyId);
  if (cached) {
    return cached;
  }
  const promise = mintFamilyOwnerAccessToken(admin, familyId);
  cache.set(familyId, promise);
  return promise;
}

/** A single HTTP attempt against the deployed warm endpoint. Returns the
 * response status (204 on success), or `'network_error'` for a thrown
 * fetch failure -- never throws, so the caller's retry loop never needs a
 * try/catch of its own. */
async function attemptWarmRequest(
  accessToken: string,
  anonKey: string,
  target: ShareCardBackfillTarget,
): Promise<number | 'network_error'> {
  try {
    const response = await fetch(warmEndpointUrl(), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${accessToken}`,
        apikey: anonKey,
      },
      body: JSON.stringify({ memoryId: target.memoryId, mediaAssetId: target.assetId, warm: true }),
    });
    return response.status;
  } catch {
    return 'network_error';
  }
}

interface ProcessResult {
  stored: boolean;
}

/** Warms one target with bounded retries (decideWarmRetry), pacing every
 * actual HTTP attempt at least BACKFILL_REQUEST_PACE_MS apart (a 546 retry's
 * own 3s backoff already clears that bar; this only adds an explicit wait
 * between a GIVE-UP/SUCCESS on one target and the first attempt on the
 * next). `lastRequestAt` is a single-element mutable box (not a module-level
 * `let`) so this stays easily testable/composable without shared global
 * state across script invocations. */
async function processTarget(
  accessToken: string,
  anonKey: string,
  target: ShareCardBackfillTarget,
  lastRequestAt: { current: number },
): Promise<ProcessResult> {
  for (let attempt = 1; attempt <= BACKFILL_WARM_MAX_ATTEMPTS; attempt++) {
    const elapsedSinceLastRequest = Date.now() - lastRequestAt.current;
    const paceWaitMs = Math.max(0, BACKFILL_REQUEST_PACE_MS - elapsedSinceLastRequest);
    if (paceWaitMs > 0) {
      await delay(paceWaitMs);
    }

    const status = await attemptWarmRequest(accessToken, anonKey, target);
    lastRequestAt.current = Date.now();

    const decision = decideWarmRetry(status, attempt);
    if (decision.action === 'success') {
      console.log(`${describeTarget(target)}: warmed (204)`);
      return { stored: true };
    }
    if (decision.action === 'retry') {
      console.log(`${describeTarget(target)}: attempt ${attempt} got ${status}, retrying in ${decision.delayMs}ms`);
      await delay(decision.delayMs);
      lastRequestAt.current = Date.now();
      continue;
    }
    console.error(`${describeTarget(target)}: gave up after ${attempt} attempt(s), last status ${status}`);
    return { stored: false };
  }
  // Unreachable given BACKFILL_WARM_MAX_ATTEMPTS bounds the loop above, but
  // TypeScript needs an exhaustive return.
  return { stored: false };
}

async function fetchMemoryTargets(admin: SupabaseClient, memoryIdFilter?: string): Promise<MemoryTargetRow[]> {
  const rows: MemoryTargetRow[] = [];
  for (let offset = 0; ; offset += DATABASE_PAGE_SIZE) {
    let query = admin
      .from('memories')
      .select('id, family_id')
      .in('memory_type', ['text_only', 'text_illustration'])
      .is('share_card_key', null)
      .order('created_at', { ascending: true })
      .order('id', { ascending: true })
      .range(offset, offset + DATABASE_PAGE_SIZE - 1);

    if (memoryIdFilter) {
      query = query.eq('id', memoryIdFilter);
    }

    const { data, error } = await query;
    if (error) {
      throw new Error(`Could not load memory targets: ${error.message}`);
    }
    rows.push(...data);
    if (data.length < DATABASE_PAGE_SIZE) {
      break;
    }
  }
  return rows;
}

async function fetchMediaAssetTargets(admin: SupabaseClient, memoryIdFilter?: string): Promise<MediaAssetTargetRow[]> {
  const rows: MediaAssetTargetRow[] = [];
  const imageContentTypes = [...ALLOWED_IMAGE_CONTENT_TYPES];
  for (let offset = 0; ; offset += DATABASE_PAGE_SIZE) {
    let query = admin
      .from('memory_media')
      .select('id, memory_id, content_type, memories!inner(family_id)')
      .is('share_card_key', null)
      .in('content_type', imageContentTypes)
      .order('created_at', { ascending: true })
      .order('id', { ascending: true })
      .range(offset, offset + DATABASE_PAGE_SIZE - 1);

    if (memoryIdFilter) {
      query = query.eq('memory_id', memoryIdFilter);
    }

    const { data, error } = await query;
    if (error) {
      throw new Error(`Could not load media asset targets: ${error.message}`);
    }
    rows.push(...(data as unknown as MediaAssetTargetRow[]));
    if (data.length < DATABASE_PAGE_SIZE) {
      break;
    }
  }
  return rows;
}

async function main(): Promise<void> {
  const serviceRoleKey = requireEnv('SUPABASE_SERVICE_ROLE_KEY');
  const admin = createClient(supabaseUrl(), serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const anonKey = supabaseAnonKey();

  const shouldApply = Deno.args.includes('--apply');
  const limitFlag = getFlagValue('--limit');
  const limit = limitFlag ? Number(limitFlag) : undefined;
  const memoryIdFilter = getFlagValue('--memory-id');

  const [memoryRows, assetRows] = await Promise.all([
    fetchMemoryTargets(admin, memoryIdFilter),
    fetchMediaAssetTargets(admin, memoryIdFilter),
  ]);

  const allTargets = [...shapeMemoryTargets(memoryRows), ...shapeMediaAssetTargets(assetRows)];
  const targets = limit ? allTargets.slice(0, limit) : allTargets;

  if (targets.length === 0) {
    console.log('No share cards need backfilling');
    return;
  }

  const familyCount = new Set(targets.map((t) => t.familyId)).size;
  console.log(
    `Found ${targets.length} candidate target(s) (${memoryRows.length} memory card(s), ` +
      `${assetRows.length} asset card(s)) across ${familyCount} famil${familyCount === 1 ? 'y' : 'ies'}`,
  );
  console.log(`${shouldApply ? 'Applying' : 'Dry-running'} share-card backfill`);

  if (!shouldApply) {
    for (const target of targets) {
      console.log(`Would warm ${describeTarget(target)} (family ${target.familyId})`);
    }
    console.log(`Dry run finished: ${targets.length} target(s) would be warmed`);
    return;
  }

  const ownerTokenCache = new Map<string, Promise<string | null>>();
  const lastRequestAt = { current: 0 };

  let storedCount = 0;
  let gaveUpCount = 0;
  const gaveUpTargets: string[] = [];
  let noOwnerCount = 0;

  for (const target of targets) {
    const accessToken = await getOrMintFamilyOwnerAccessToken(admin, target.familyId, ownerTokenCache);
    if (!accessToken) {
      noOwnerCount += 1;
      gaveUpCount += 1;
      gaveUpTargets.push(describeTarget(target));
      continue;
    }

    const result = await processTarget(accessToken, anonKey, target, lastRequestAt);
    if (result.stored) {
      storedCount += 1;
    } else {
      gaveUpCount += 1;
      gaveUpTargets.push(describeTarget(target));
    }
  }

  console.log(
    `Finished: ${storedCount} share card(s) warmed, ${gaveUpCount} gave up` +
      (noOwnerCount > 0 ? ` (${noOwnerCount} due to an unresolvable family owner)` : '') +
      (gaveUpTargets.length > 0 ? ` [${gaveUpTargets.join(', ')}]` : ''),
  );

  if (gaveUpCount > 0) {
    Deno.exit(1);
  }
}

if (import.meta.main) {
  await main();
}
