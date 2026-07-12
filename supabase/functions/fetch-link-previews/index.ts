import { getAuthenticatedUser } from '../_shared/auth.ts';
import { handleCors } from '../_shared/cors.ts';
import { errorResponse, jsonResponse } from '../_shared/errors.ts';
import { getCallerFamilyRole } from '../_shared/family-access.ts';
import { extractUrls, fetchPageTitle } from '../_shared/link-preview.ts';
import { createServiceClient, createUserClient } from '../_shared/supabase-admin.ts';

export interface FetchLinkPreviewsRequest {
  memoryId: string;
}

export interface LinkPreviewEntry {
  title: string | null;
  fetchedAt: string;
}

export type LinkPreviewMap = Record<string, LinkPreviewEntry>;

export interface FetchLinkPreviewsResponse {
  linkPreviews: LinkPreviewMap;
}

interface MemoryRow {
  id: string;
  family_id: string;
  content: string | null;
  link_previews: unknown;
}

const MAX_LINK_PREVIEW_URLS = 5;

const recentRunByMemory = new Map<string, number>();
const FETCH_COOLDOWN_MS = 5000;

function isWithinCooldown(memoryId: string): boolean {
  const lastRun = recentRunByMemory.get(memoryId);
  if (!lastRun) {
    return false;
  }

  return Date.now() - lastRun < FETCH_COOLDOWN_MS;
}

function markRun(memoryId: string): void {
  recentRunByMemory.set(memoryId, Date.now());
}

function isLinkPreviewEntry(value: unknown): value is LinkPreviewEntry {
  if (!value || typeof value !== 'object') {
    return false;
  }

  const entry = value as Record<string, unknown>;
  return (
    (typeof entry.title === 'string' || entry.title === null) &&
    typeof entry.fetchedAt === 'string'
  );
}

/** Defensively narrows the jsonb column: malformed entries are treated as absent. */
export function normalizeLinkPreviews(value: unknown): LinkPreviewMap {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }

  const result: LinkPreviewMap = {};
  for (const [url, entry] of Object.entries(value as Record<string, unknown>)) {
    if (isLinkPreviewEntry(entry)) {
      result[url] = entry;
    }
  }

  return result;
}

export interface LinkPreviewFetchPlan {
  /** Up to the first 5 unique URLs in first-seen order; extra URLs are ignored. */
  urls: string[];
  /** Subset of `urls` that are new or previously failed (title: null) -- need a fetch. */
  toFetch: string[];
  /** Existing non-null entries for URLs still present in content -- kept as-is. */
  preserved: LinkPreviewMap;
}

/**
 * Diffs `content`'s URLs against the stored preview map: URLs no longer in
 * content are dropped (pruned) simply by not appearing in `urls`; existing
 * non-null entries for URLs still present are preserved without refetching;
 * new URLs and previously-failed (`title: null`) URLs are queued in
 * `toFetch`.
 */
export function planLinkPreviewFetch(
  content: string | null,
  existing: LinkPreviewMap,
): LinkPreviewFetchPlan {
  const urls = [...new Set(extractUrls(content))].slice(0, MAX_LINK_PREVIEW_URLS);
  const preserved: LinkPreviewMap = {};
  const toFetch: string[] = [];

  for (const url of urls) {
    const existingEntry = existing[url];
    if (existingEntry && existingEntry.title !== null) {
      preserved[url] = existingEntry;
    } else {
      toFetch.push(url);
    }
  }

  return { urls, toFetch, preserved };
}

/**
 * Fetches titles for every URL in `plan.toFetch` (parallel) and merges them
 * with `plan.preserved`. A fetch failure (rejection or thrown error) never
 * aborts the batch -- it just yields `title: null` for that one URL, same
 * as `fetchPageTitle`'s own null-on-failure contract.
 */
export async function fetchLinkPreviewsForPlan(
  plan: LinkPreviewFetchPlan,
  fetchTitle: (url: string) => Promise<string | null> = fetchPageTitle,
): Promise<LinkPreviewMap> {
  const fetchedAt = new Date().toISOString();
  const settled = await Promise.allSettled(plan.toFetch.map((url) => fetchTitle(url)));

  const merged: LinkPreviewMap = { ...plan.preserved };
  plan.toFetch.forEach((url, index) => {
    const result = settled[index];
    merged[url] = {
      title: result.status === 'fulfilled' ? result.value : null,
      fetchedAt,
    };
  });

  return merged;
}

/**
 * Writes `linkPreviews` via the service-role client, but only if `content`
 * still matches `snapshotContent`. The content predicate is part of the
 * UPDATE itself so a concurrent edit cannot land between a re-check and the
 * write. Deliberately compares
 * `content`, not `updated_at` (see docs/plans/inline-links.md §4): the
 * memory's own AI pipeline bumps `updated_at` on nearly every create, which
 * would make an `updated_at` guard discard fetched titles almost every time.
 */
export async function writeLinkPreviewsIfContentUnchanged(
  serviceClient: ReturnType<typeof createServiceClient>,
  memoryId: string,
  linkPreviews: LinkPreviewMap,
  snapshotContent: string | null,
): Promise<boolean> {
  let updateQuery = serviceClient
    .from('memories')
    .update({ link_previews: linkPreviews })
    .eq('id', memoryId);

  updateQuery = snapshotContent === null
    ? updateQuery.is('content', null)
    : updateQuery.eq('content', snapshotContent);

  const { data: updated, error: updateError } = await updateQuery
    .select('id')
    .maybeSingle();

  if (updateError) {
    console.error('fetch-link-previews write failed', updateError.message);
    return false;
  }

  return updated !== null;
}

interface FetchLinkPreviewDependencies {
  getAuthenticatedUser: typeof getAuthenticatedUser;
  getCallerFamilyRole: typeof getCallerFamilyRole;
  createUserClient: typeof createUserClient;
  createServiceClient: typeof createServiceClient;
  fetchTitle: (url: string) => Promise<string | null>;
  isWithinCooldown: (memoryId: string) => boolean;
  markRun: (memoryId: string) => void;
}

const defaultDependencies: FetchLinkPreviewDependencies = {
  getAuthenticatedUser,
  getCallerFamilyRole,
  createUserClient,
  createServiceClient,
  fetchTitle: fetchPageTitle,
  isWithinCooldown,
  markRun,
};

export async function handleFetchLinkPreviews(
  req: Request,
  dependencyOverrides: Partial<FetchLinkPreviewDependencies> = {},
): Promise<Response> {
  const dependencies = { ...defaultDependencies, ...dependencyOverrides };
  const corsResponse = handleCors(req);
  if (corsResponse) {
    return corsResponse;
  }

  if (req.method !== 'POST') {
    return errorResponse('Method not allowed', 405, 'method_not_allowed');
  }

  const user = await dependencies.getAuthenticatedUser(req);
  if (!user) {
    return errorResponse('Unauthorized', 401, 'unauthorized');
  }

  let body: FetchLinkPreviewsRequest;
  try {
    body = await req.json();
  } catch {
    return errorResponse('Invalid JSON body', 400, 'invalid_json');
  }

  const { memoryId } = body;

  if (!memoryId || typeof memoryId !== 'string') {
    return errorResponse('memoryId is required', 400, 'validation_error');
  }

  if (dependencies.isWithinCooldown(memoryId)) {
    return errorResponse('Link preview fetch was run too recently', 429, 'rate_limited');
  }

  const authHeader = req.headers.get('Authorization');
  if (!authHeader) {
    return errorResponse('Unauthorized', 401, 'unauthorized');
  }

  const supabase = dependencies.createUserClient(authHeader);
  // Mirrors analyze-emotion: the write runs on the service-role client so a
  // viewer-triggered fetch still persists (a viewer's user-client UPDATE
  // would silently match zero rows under the manager+ `memories` RLS
  // policy). Membership (any role) authorizes triggering the fetch; the
  // enrichment write itself is a system write.
  const serviceClient = dependencies.createServiceClient();

  const { data: memory, error: memoryError } = await supabase
    .from('memories')
    .select('id, family_id, content, link_previews')
    .eq('id', memoryId)
    .maybeSingle();

  if (memoryError) {
    console.error('fetch-link-previews memory lookup failed', memoryError.message);
    return errorResponse('Failed to load memory', 500, 'internal_error');
  }

  if (!memory) {
    return errorResponse('Memory not found', 404, 'MEMORY_NOT_FOUND');
  }

  const callerRole = await dependencies.getCallerFamilyRole(
    supabase,
    memory.family_id,
    user.id,
  );
  if (!callerRole) {
    return errorResponse('Not authorized for this memory', 403, 'forbidden');
  }

  dependencies.markRun(memoryId);

  const row = memory as MemoryRow;
  const existing = normalizeLinkPreviews(row.link_previews);
  const plan = planLinkPreviewFetch(row.content, existing);
  const merged = await fetchLinkPreviewsForPlan(plan, dependencies.fetchTitle);

  await writeLinkPreviewsIfContentUnchanged(serviceClient, memoryId, merged, row.content);

  const response: FetchLinkPreviewsResponse = { linkPreviews: merged };
  return jsonResponse(response);
}

if (import.meta.main) {
  Deno.serve((req) => handleFetchLinkPreviews(req));
}
