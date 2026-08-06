import { getAuthenticatedNonAnonymousUser } from '../_shared/auth.ts';
import { handleCors } from '../_shared/cors.ts';
import { errorResponse, jsonResponse } from '../_shared/errors.ts';
import {
  getCallerFamilyRoles,
  resolveReferencedStorageKeys,
  resolveStorageKeyFamilyIds,
} from '../_shared/family-access.ts';
import { createPresignedGetUrls, R2_URL_EXPIRY } from '../_shared/r2.ts';
import { createServiceClient } from '../_shared/supabase-admin.ts';

const MAX_KEYS = 50;
// How many omitted key ids to log for debugging -- keys are opaque ids (not
// memory content), so logging a few is fine, but we cap it so a batch full
// of stale keys doesn't spam the log with all 50.
const OMITTED_LOG_SAMPLE_SIZE = 5;

export interface GetMediaUrlRequest {
  keys: string[];
}

export interface GetMediaUrlResponse {
  urls: Record<string, string>;
  expiresIn: number;
}

export interface GetMediaUrlDependencies {
  getAuthenticatedUser: typeof getAuthenticatedNonAnonymousUser;
  createServiceClient: typeof createServiceClient;
  resolveStorageKeyFamilyIds: typeof resolveStorageKeyFamilyIds;
  getCallerFamilyRoles: typeof getCallerFamilyRoles;
  resolveReferencedStorageKeys: typeof resolveReferencedStorageKeys;
  createPresignedGetUrls: typeof createPresignedGetUrls;
}

// WP-SEC: the default dependency rejects an anonymous Auth session (returns
// null, same as no/invalid auth), same as every other normal Edge Function --
// see _shared/auth.ts. Tests may still inject any `getAuthenticatedUser`
// fake directly to exercise this function's own logic in isolation.
export const DEFAULT_DEPENDENCIES: GetMediaUrlDependencies = {
  getAuthenticatedUser: getAuthenticatedNonAnonymousUser,
  createServiceClient,
  resolveStorageKeyFamilyIds,
  getCallerFamilyRoles,
  resolveReferencedStorageKeys,
  createPresignedGetUrls,
};

export async function handleGetMediaUrl(
  req: Request,
  dependencies: GetMediaUrlDependencies = DEFAULT_DEPENDENCIES,
): Promise<Response> {
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

  let body: GetMediaUrlRequest;
  try {
    body = await req.json();
  } catch {
    return errorResponse('Invalid JSON body', 400, 'invalid_json');
  }

  const { keys } = body;

  // Malformed requests (not an array, empty, too many keys, non-string
  // entries) still fail the whole call -- these are client bugs, not stale
  // cache entries, and there is no partial response that makes sense for
  // them.
  if (!Array.isArray(keys) || keys.length === 0) {
    return errorResponse('keys must be a non-empty array', 400, 'validation_error');
  }

  if (keys.length > MAX_KEYS) {
    return errorResponse(`Maximum ${MAX_KEYS} keys allowed`, 400, 'validation_error');
  }

  for (const key of keys) {
    if (typeof key !== 'string' || !key.trim()) {
      return errorResponse('Each key must be a non-empty string', 400, 'validation_error');
    }
  }

  const serviceClient = dependencies.createServiceClient();
  const resolved = await dependencies.resolveStorageKeyFamilyIds(serviceClient, keys);

  const familyIds = [
    ...new Set(
      resolved
        .map((entry) => entry.familyId)
        .filter((familyId): familyId is string => familyId !== null),
    ),
  ];
  const roles = await dependencies.getCallerFamilyRoles(serviceClient, familyIds, user.id);
  const referenced = await dependencies.resolveReferencedStorageKeys(serviceClient, resolved);

  // Per-key tolerance (production incident, 2026-08-06): a backfill re-keyed
  // ~90 objects and deleted the old ones, so clients' persisted (7-day)
  // caches still reference now-deleted keys. Those stale keys ride in the
  // same shared client-side batch as unrelated, perfectly valid keys (see
  // src/services/media.ts's request coalescer, which merges up to 50 keys
  // from independently-mounted rows into one call) -- so failing the WHOLE
  // batch for ONE bad key was taking down large chunks of unrelated image
  // loads. Each key is now resolved/authorized/reference-checked
  // independently; a key that fails ANY check (unparseable, family
  // unresolved, caller not a member of that key's family, or not currently
  // referenced by its owning row) is simply OMITTED from `urls` rather than
  // failing the request.
  //
  // Security note: omission leaks no more information than the old
  // all-or-nothing 400/403 did -- arguably less. Previously a denied key
  // told the caller "something in this batch is invalid/forbidden" (batch
  // granularity); now a missing key says only "this key has no URL", which
  // is indistinguishable from a key that never existed. No response field
  // reveals *why* a key was omitted (bad parse vs. wrong family vs.
  // unreferenced all look identical to the caller), so this is not a new
  // oracle for enumerating other families' object keys.
  const authorizedKeys: string[] = [];
  const omittedKeys: string[] = [];

  for (const entry of resolved) {
    const role = entry.familyId !== null ? roles.get(entry.familyId) ?? null : null;
    const isAuthorized = entry.familyId !== null && role !== null && referenced.has(entry.objectKey);

    if (isAuthorized) {
      authorizedKeys.push(entry.objectKey);
    } else {
      omittedKeys.push(entry.objectKey);
    }
  }

  if (omittedKeys.length > 0) {
    // Counts only, plus a small id sample for debugging -- object keys are
    // opaque ids (allowed in logs), never memory/family-member content.
    console.log(
      `get-media-url: requested=${keys.length} served=${authorizedKeys.length} omitted=${omittedKeys.length} omittedSample=${JSON.stringify(omittedKeys.slice(0, OMITTED_LOG_SAMPLE_SIZE))}`,
    );
  }

  try {
    const urls =
      authorizedKeys.length > 0 ? await dependencies.createPresignedGetUrls(authorizedKeys) : {};

    const response: GetMediaUrlResponse = {
      urls,
      expiresIn: R2_URL_EXPIRY.download,
    };

    return jsonResponse(response);
  } catch (error) {
    console.error('get-media-url failed', error instanceof Error ? error.message : 'unknown');
    return errorResponse('Failed to create media URLs', 500, 'internal_error');
  }
}

if (import.meta.main) {
  Deno.serve((request) => handleGetMediaUrl(request));
}
