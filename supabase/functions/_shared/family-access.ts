import type { SupabaseClient } from 'npm:@supabase/supabase-js@2';
import { parseStorageKey, type ParsedStorageKey } from './storage-keys.ts';

export type FamilyRole = 'owner' | 'manager' | 'viewer';

export const MANAGER_ROLES: FamilyRole[] = ['owner', 'manager'];

export function isManagerRole(role: FamilyRole | null): boolean {
  return role === 'owner' || role === 'manager';
}

interface FamilyRow {
  id: string;
  owner_id: string;
  deleted_at: string | null;
}

interface MembershipRow {
  family_id: string;
  role: FamilyRole;
}

/**
 * Batch-resolves the caller's role in each of `familyIds`, mirroring the
 * `is_family_member` / `has_family_role` SQL helpers (including the owner
 * exemption on `deleted_at`): a soft-deleted family is invisible to
 * everyone except its owner. Two queries total regardless of how many
 * family ids are passed. Returns null for any family the caller has no
 * (visible) role in.
 */
export async function getCallerFamilyRoles(
  supabase: SupabaseClient,
  familyIds: string[],
  callerId: string,
): Promise<Map<string, FamilyRole | null>> {
  const uniqueIds = [...new Set(familyIds)];
  const result = new Map<string, FamilyRole | null>();

  if (uniqueIds.length === 0) {
    return result;
  }

  for (const id of uniqueIds) {
    result.set(id, null);
  }

  const { data: families } = await supabase
    .from('families')
    .select('id, owner_id, deleted_at')
    .in('id', uniqueIds);

  const { data: memberships } = await supabase
    .from('family_memberships')
    .select('family_id, role')
    .eq('user_id', callerId)
    .in('family_id', uniqueIds);

  const membershipByFamilyId = new Map<string, FamilyRole>(
    ((memberships ?? []) as MembershipRow[]).map((row) => [row.family_id, row.role]),
  );

  for (const family of (families ?? []) as FamilyRow[]) {
    const role = membershipByFamilyId.get(family.id) ?? null;

    if (family.deleted_at && family.owner_id !== callerId) {
      result.set(family.id, null);
      continue;
    }

    result.set(family.id, role);
  }

  return result;
}

export async function getCallerFamilyRole(
  supabase: SupabaseClient,
  familyId: string,
  callerId: string,
): Promise<FamilyRole | null> {
  const roles = await getCallerFamilyRoles(supabase, [familyId], callerId);
  return roles.get(familyId) ?? null;
}

export interface ResolvedStorageKey {
  objectKey: string;
  parsed: ParsedStorageKey | null;
  familyId: string | null;
}

/**
 * Resolves the owning family for each object key by parsing the entity id
 * embedded in the key (memory id or family_members id) and looking up that
 * row's `family_id` -- NEVER by whether some `memory_media` row references
 * the key (spoofable: direct inserts don't constrain `object_key`). Batches
 * to one query per entity type regardless of key count. Unparsable keys or
 * keys whose entity id doesn't exist resolve to `familyId: null`.
 */
export async function resolveStorageKeyFamilyIds(
  supabase: SupabaseClient,
  objectKeys: string[],
): Promise<ResolvedStorageKey[]> {
  const entries = objectKeys.map((objectKey) => ({
    objectKey,
    parsed: parseStorageKey(objectKey),
  }));

  const memoryIds = new Set<string>();
  const memberIds = new Set<string>();

  for (const entry of entries) {
    if (!entry.parsed) {
      continue;
    }

    if (entry.parsed.kind === 'memory_media' || entry.parsed.kind === 'memory_illustration') {
      memoryIds.add(entry.parsed.entityId);
    } else {
      memberIds.add(entry.parsed.entityId);
    }
  }

  const memoryFamilyById = new Map<string, string>();
  if (memoryIds.size > 0) {
    const { data } = await supabase
      .from('memories')
      .select('id, family_id')
      .in('id', [...memoryIds]);

    for (const row of (data ?? []) as Array<{ id: string; family_id: string }>) {
      memoryFamilyById.set(row.id, row.family_id);
    }
  }

  const memberFamilyById = new Map<string, string>();
  if (memberIds.size > 0) {
    const { data } = await supabase
      .from('family_members')
      .select('id, family_id')
      .in('id', [...memberIds]);

    for (const row of (data ?? []) as Array<{ id: string; family_id: string }>) {
      memberFamilyById.set(row.id, row.family_id);
    }
  }

  return entries.map((entry) => {
    if (!entry.parsed) {
      return { ...entry, familyId: null };
    }

    const familyId =
      entry.parsed.kind === 'memory_media' || entry.parsed.kind === 'memory_illustration'
        ? memoryFamilyById.get(entry.parsed.entityId) ?? null
        : memberFamilyById.get(entry.parsed.entityId) ?? null;

    return { ...entry, familyId };
  });
}
