// Living portraits backfill (docs/plans/living-portraits.md): claims motion for
// each family member's CURRENT portrait that has no usable loop yet and hands
// it to the portrait-motion Workflow. Driven in batches by
// supabase/scripts/backfill-portrait-motion.ts; the live trigger (a still
// publishing `ready`) is separate and lives in the portrait Workflow.
//
// Auth: x-cron-secret (validateCronSecret) OR `Authorization: Bearer
// <SUPABASE_SERVICE_ROLE_KEY>` (exact match). verify_jwt = false because the
// gateway would otherwise reject the non-JWT cron header.
import { validateCronSecret } from '../_shared/cron.ts';
import { errorResponse, jsonResponse } from '../_shared/errors.ts';
import { deleteObject } from '../_shared/r2.ts';
import { parseStorageKey } from '../_shared/storage-keys.ts';
import { createServiceClient } from '../_shared/supabase-admin.ts';
import { serveWithSentry } from '../_shared/sentry.ts';

const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 25;
const PAGE_SIZE = 1000;
// Must match the in_flight window in claim_portrait_motion.
const MOTION_IN_FLIGHT_MS = 15 * 60_000;

export interface PortraitMotionBackfillRequest {
  limit?: number;
  dryRun?: boolean;
}

export interface PortraitMotionBackfillResponse {
  eligible: number;
  claimed: number;
  dispatched: number;
  failed: number;
}

export interface PortraitMotionBackfillDependencies {
  createServiceClient: typeof createServiceClient;
  fetch: typeof fetch;
  deleteObject: typeof deleteObject;
  now: () => Date;
}

const DEFAULT_DEPENDENCIES: PortraitMotionBackfillDependencies = {
  createServiceClient,
  fetch: (...args: Parameters<typeof fetch>) => fetch(...args),
  deleteObject,
  now: () => new Date(),
};

export interface BackfillVersionRow {
  id: string;
  family_id: string;
  family_member_id: string;
  reference_date: string | null;
  created_at: string;
  illustrated_profile_key: string | null;
  motion_status: string | null;
  motion_source_key: string | null;
  motion_started_at: string | null;
}

function compareNewest(a: BackfillVersionRow, b: BackfillVersionRow): number {
  if (a.created_at !== b.created_at) return a.created_at < b.created_at ? 1 : -1;
  if (a.id !== b.id) return a.id < b.id ? 1 : -1;
  return 0;
}

/**
 * Mirrors resolveByDatePrecedence in src/utils/portrait-versions.ts for one
 * member's usable (ready, not deleting) versions: latest dated <= today
 * (newest created first on ties), else earliest dated > today, else the
 * newest undated legacy row.
 */
export function resolveCurrentPortraitVersion(
  versions: readonly BackfillVersionRow[],
  todayIso: string,
): BackfillVersionRow | null {
  const dated = versions.filter((v): v is BackfillVersionRow & { reference_date: string } => Boolean(v.reference_date));
  const before = dated
    .filter((v) => v.reference_date <= todayIso)
    .sort((a, b) => (a.reference_date < b.reference_date ? 1 : a.reference_date > b.reference_date ? -1 : 0) || compareNewest(a, b))[0];
  if (before) return before;
  const after = dated
    .filter((v) => v.reference_date > todayIso)
    .sort((a, b) => (a.reference_date < b.reference_date ? -1 : a.reference_date > b.reference_date ? 1 : 0) || compareNewest(a, b))[0];
  if (after) return after;
  return versions.filter((v) => !v.reference_date).sort(compareNewest)[0] ?? null;
}

/** True when claim_portrait_motion would not return already_ready / already_failed / in_flight. */
export function needsPortraitMotion(version: BackfillVersionRow, nowMs: number): boolean {
  if (!version.illustrated_profile_key) return false;
  const sourceMatches = version.motion_source_key === version.illustrated_profile_key;
  if (version.motion_status === 'ready' && sourceMatches) return false;
  if (version.motion_status === 'failed' && sourceMatches) return false;
  if (version.motion_status === 'pending' && sourceMatches) {
    const startedMs = version.motion_started_at ? Date.parse(version.motion_started_at) : Number.NaN;
    if (Number.isFinite(startedMs) && startedMs > nowMs - MOTION_IN_FLIGHT_MS) return false;
  }
  return true;
}

export function selectBackfillCandidates(
  versions: readonly BackfillVersionRow[],
  todayIso: string,
  nowMs: number,
): BackfillVersionRow[] {
  const byMember = new Map<string, BackfillVersionRow[]>();
  for (const version of versions) {
    const list = byMember.get(version.family_member_id) ?? [];
    list.push(version);
    byMember.set(version.family_member_id, list);
  }
  const candidates: BackfillVersionRow[] = [];
  for (const list of byMember.values()) {
    const current = resolveCurrentPortraitVersion(list, todayIso);
    if (current && needsPortraitMotion(current, nowMs)) candidates.push(current);
  }
  return candidates.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/** `/dispatch/portrait` -> `/dispatch/portrait-motion` on the configured Worker URL. */
export function toPortraitMotionDispatchUrl(portraitWorkflowUrl: string): string {
  const url = new URL(portraitWorkflowUrl);
  if (!url.pathname.endsWith('/dispatch/portrait')) {
    throw new Error('Unexpected portrait workflow URL');
  }
  url.pathname = `${url.pathname.slice(0, -'/dispatch/portrait'.length)}/dispatch/portrait-motion`;
  return url.toString();
}

function hex(bytes: ArrayBuffer): string {
  return [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** Same HMAC as dispatchPortraitWorkflow in generate-portrait-illustration. */
async function dispatchPortraitMotionWorkflow(
  fetchFn: typeof fetch,
  payload: { versionId: string; motionToken: string },
): Promise<void> {
  const endpoint = Deno.env.get('CLOUDFLARE_PORTRAIT_WORKFLOW_URL');
  const secret = Deno.env.get('CLOUDFLARE_PORTRAIT_DISPATCH_SECRET');
  if (!endpoint || !secret) {
    throw new Error('Cloudflare portrait workflow is not configured');
  }

  const timestamp = String(Date.now());
  const nonce = crypto.randomUUID();
  const rawBody = JSON.stringify(payload);
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const signature = hex(await crypto.subtle.sign(
    'HMAC',
    key,
    new TextEncoder().encode(`${timestamp}.${nonce}.${rawBody}`),
  ));
  const response = await fetchFn(toPortraitMotionDispatchUrl(endpoint), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-dispatch-timestamp': timestamp,
      'x-dispatch-nonce': nonce,
      'x-dispatch-signature': signature,
    },
    body: rawBody,
  });
  await response.text().catch(() => '');
  // An existing deterministic instance is an idempotent 202; tolerate 409 too.
  if (!response.ok && response.status !== 409) {
    throw new Error(`Cloudflare portrait motion dispatch failed (${response.status})`);
  }
}

async function digest(value: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)));
}

async function isServiceRoleBearer(req: Request): Promise<boolean> {
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  const header = req.headers.get('Authorization');
  if (!serviceRoleKey || !header) return false;
  const [left, right] = await Promise.all([digest(header), digest(`Bearer ${serviceRoleKey}`)]);
  let mismatch = 0;
  for (let index = 0; index < left.length; index += 1) mismatch |= left[index] ^ right[index];
  return mismatch === 0;
}

type ServiceClient = ReturnType<typeof createServiceClient>;

async function loadUsableVersions(supabase: ServiceClient): Promise<BackfillVersionRow[]> {
  const rows: BackfillVersionRow[] = [];
  for (let from = 0; ; from += PAGE_SIZE) {
    const { data, error } = await supabase
      .from('family_member_portrait_versions')
      .select('id, family_id, family_member_id, reference_date, created_at, illustrated_profile_key, motion_status, motion_source_key, motion_started_at')
      .eq('illustrated_profile_status', 'ready')
      .not('illustrated_profile_key', 'is', null)
      .is('deletion_token', null)
      .order('id', { ascending: true })
      .range(from, from + PAGE_SIZE - 1);
    if (error) throw error;
    rows.push(...((data ?? []) as BackfillVersionRow[]));
    if (!data || data.length < PAGE_SIZE) break;
  }
  return rows;
}

/**
 * Families/members in (or past) deletion can never be claimed. Dropping them
 * up front keeps `eligible` honest, so a script that loops until eligible = 0
 * always terminates.
 */
async function loadFencedIds(supabase: ServiceClient): Promise<{ families: Set<string>; members: Set<string> }> {
  const [{ data: families, error: familiesError }, { data: members, error: membersError }] = await Promise.all([
    supabase.from('families').select('id').or('deleted_at.not.is.null,deletion_fence_token.not.is.null'),
    supabase.from('family_members').select('id').not('deletion_fence_token', 'is', null),
  ]);
  if (familiesError) throw familiesError;
  if (membersError) throw membersError;
  return {
    families: new Set((families ?? []).map((row: { id: string }) => row.id)),
    members: new Set((members ?? []).map((row: { id: string }) => row.id)),
  };
}

export async function handlePortraitMotionBackfill(
  req: Request,
  dependencyOverrides: Partial<PortraitMotionBackfillDependencies> = {},
): Promise<Response> {
  const dependencies = { ...DEFAULT_DEPENDENCIES, ...dependencyOverrides };
  if (req.method !== 'POST') return errorResponse('Method not allowed', 405, 'method_not_allowed');
  if (!validateCronSecret(req) && !(await isServiceRoleBearer(req))) {
    return errorResponse('Unauthorized', 401, 'unauthorized');
  }

  let body: PortraitMotionBackfillRequest = {};
  const rawBody = await req.text();
  if (rawBody.trim()) {
    try {
      body = JSON.parse(rawBody) as PortraitMotionBackfillRequest;
    } catch {
      return errorResponse('Invalid JSON body', 400, 'invalid_json');
    }
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return errorResponse('Invalid request body', 400, 'validation_error');
  }
  const limit = body.limit ?? DEFAULT_LIMIT;
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT ||
    (body.dryRun !== undefined && typeof body.dryRun !== 'boolean')) {
    return errorResponse('limit must be 1-25 and dryRun a boolean', 400, 'validation_error');
  }

  const supabase = dependencies.createServiceClient();
  const now = dependencies.now();
  let candidates: BackfillVersionRow[];
  try {
    const [versions, fenced] = await Promise.all([loadUsableVersions(supabase), loadFencedIds(supabase)]);
    candidates = selectBackfillCandidates(
      versions.filter((v) => !fenced.families.has(v.family_id) && !fenced.members.has(v.family_member_id)),
      now.toISOString().slice(0, 10),
      now.getTime(),
    );
  } catch {
    console.error('portrait-motion-backfill candidate lookup failed');
    return errorResponse('Candidate lookup failed', 500, 'internal_error');
  }

  const result: PortraitMotionBackfillResponse = { eligible: candidates.length, claimed: 0, dispatched: 0, failed: 0 };
  if (body.dryRun === true) return jsonResponse(result);

  for (const candidate of candidates.slice(0, limit)) {
    try {
      const { data, error } = await supabase.rpc('claim_portrait_motion', {
        p_version_id: candidate.id,
        p_force: false,
      });
      if (error) throw error;
      const claim = (Array.isArray(data) ? data[0] : data) as {
        outcome?: string;
        motion_token?: string | null;
        stale_motion_key?: string | null;
      } | undefined;
      // Anything but a fresh claim (raced by the live trigger, or deleted
      // since the lookup) is somebody else's work.
      if (claim?.outcome !== 'claimed' || typeof claim.motion_token !== 'string') continue;
      result.claimed += 1;
      const staleKey = claim.stale_motion_key;
      if (typeof staleKey === 'string' && parseStorageKey(staleKey)?.kind === 'portrait_version_motion') {
        try {
          await dependencies.deleteObject(staleKey);
        } catch {
          console.error('portrait-motion-backfill stale sheet delete failed', candidate.id);
        }
      }
      try {
        await dispatchPortraitMotionWorkflow(dependencies.fetch, {
          versionId: candidate.id,
          motionToken: claim.motion_token,
        });
        result.dispatched += 1;
      } catch {
        // The claim stays pending and becomes eligible again after 15 minutes.
        console.error('portrait-motion-backfill dispatch failed', candidate.id);
        result.failed += 1;
      }
    } catch {
      console.error('portrait-motion-backfill claim failed', candidate.id);
      result.failed += 1;
    }
  }
  return jsonResponse(result);
}

if (import.meta.main) {
  serveWithSentry('portrait-motion-backfill', (request) => handlePortraitMotionBackfill(request));
}
