import type { MemoryHeaderRow, MemoryMediaAssetRow, ShareTokenRow } from './resolve';

/**
 * Thin Supabase REST (PostgREST) client -- same shape as
 * cloudflare/momora-export-worker/src/supabase.ts's `supabaseRequest`, but
 * without that worker's `authenticate()` helper: the QR viewer is public
 * and unauthenticated by design (owner decision, see README "Privacy
 * model"), so there is no end-user JWT to verify. Every request uses the
 * service-role key (bypasses RLS) because there is no `auth.uid()` to
 * evaluate the `memories`/`memory_media`/`media_share_tokens` SELECT
 * policies against -- this worker IS the authorization boundary. Round-19:
 * that boundary is now the `media_share_tokens` row itself (an unguessable
 * token that resolves to an ACTIVE row), not the memory id -- a token whose
 * row has been revoked (`revoked_at` set) or never existed is rejected
 * before the underlying memory is ever looked up (see `classifyShareToken`
 * in resolve.ts and `fetchShareToken` below), which is exactly the
 * revocation lever the old raw-memoryId scheme lacked.
 */

const JSON_HEADERS = { Accept: 'application/json' };

function restUrl(env: Env, resource: string, query: Record<string, string>): string {
  const url = new URL(`${env.SUPABASE_URL.replace(/\/$/, '')}/rest/v1/${resource}`);
  for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
  return url.toString();
}

async function supabaseRequest<T>(env: Env, resource: string, query: Record<string, string>): Promise<T> {
  const response = await fetch(restUrl(env, resource, query), {
    headers: {
      ...JSON_HEADERS,
      apikey: env.SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
    },
  });
  if (!response.ok) {
    throw new Error(`supabase_${response.status}`);
  }
  return (await response.json()) as T;
}

/**
 * Round-19: resolves a share token to its `media_share_tokens` row --
 * SELECTs `memory_id`/`revoked_at` regardless of revocation status (the
 * caller, `classifyShareToken` in resolve.ts, needs to tell "never minted"
 * apart from "minted, since revoked" to pick the right response page). The
 * table has no `authenticated` SELECT-through-RLS path this worker could
 * use anyway (see the migration) -- service-role is required here exactly
 * like every other read in this file.
 */
export async function fetchShareToken(env: Env, token: string): Promise<ShareTokenRow | null> {
  const rows = await supabaseRequest<ShareTokenRow[]>(env, 'media_share_tokens', {
    select: 'memory_id,revoked_at',
    token: `eq.${token}`,
    limit: '1',
  });
  return rows[0] ?? null;
}

export async function fetchMemoryHeader(env: Env, memoryId: string): Promise<MemoryHeaderRow | null> {
  const rows = await supabaseRequest<MemoryHeaderRow[]>(env, 'memories', {
    select: 'id,memory_type,memory_date,content',
    id: `eq.${memoryId}`,
    limit: '1',
  });
  return rows[0] ?? null;
}

/**
 * The book QR page links one memory to one representative asset. A `media`
 * memory can hold up to 10 ordered assets (memory_media.position), so this
 * takes position 0 -- the same asset `memories.media_key` denormalizes as
 * "first" (see supabase/migrations/20260603120000_multi_asset_media_memories.sql's
 * `replace_memory_media_assets`). Querying memory_media directly (rather
 * than reading memories.media_key/media_content_type) is deliberate: only
 * memory_media carries `preview_object_key`, needed for the HEIC/HEIF
 * fallback in resolve.ts, and `duration_ms` for the audio/video player.
 */
export async function fetchPrimaryMediaAsset(env: Env, memoryId: string): Promise<MemoryMediaAssetRow | null> {
  const rows = await supabaseRequest<MemoryMediaAssetRow[]>(env, 'memory_media', {
    select: 'object_key,content_type,duration_ms,preview_object_key',
    memory_id: `eq.${memoryId}`,
    order: 'position.asc',
    limit: '1',
  });
  return rows[0] ?? null;
}
