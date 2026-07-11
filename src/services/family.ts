import { supabase } from '@/lib/supabase';
import type { Database } from '@/types/database';

export type Family = Database['public']['Tables']['families']['Row'];
export type FamilyMemberProfile =
  Database['public']['Functions']['get_family_member_profiles']['Returns'][number];

export interface ServiceError {
  message: string;
  code?: string;
}

function mapSupabaseError(error: { message: string; code?: string }): ServiceError {
  return {
    message: error.message,
    code: error.code,
  };
}

export interface FamilyMembershipRow {
  id: string;
  family_id: string;
  role: string;
  family: Pick<Family, 'id' | 'name' | 'illustration_style' | 'deleted_at'> | null;
}

/**
 * The caller's own family memberships (one row per family they belong to),
 * joined with the family name. RLS on `family_memberships` returns every
 * membership row for any family the caller belongs to (the shared-roster
 * policy), so this filters to `user_id = userId` explicitly to get just the
 * caller's own role per family.
 */
export async function fetchMyFamilyMemberships(userId: string): Promise<{
  data: FamilyMembershipRow[] | null;
  error: ServiceError | null;
}> {
  const { data, error } = await supabase
    .from('family_memberships')
    .select('id, family_id, role, family:families(id, name, illustration_style, deleted_at)')
    .eq('user_id', userId)
    .order('created_at', { ascending: true });

  if (error) {
    return { data: null, error: mapSupabaseError(error) };
  }

  return { data: (data ?? []) as unknown as FamilyMembershipRow[], error: null };
}

export async function createFamily(name: string): Promise<{
  data: Family | null;
  error: ServiceError | null;
}> {
  const { data, error } = await supabase.rpc('create_family', { name });

  if (error) {
    return { data: null, error: mapSupabaseError(error) };
  }

  return { data: data as Family, error: null };
}

export async function fetchFamilyMemberProfiles(familyId: string): Promise<{
  data: FamilyMemberProfile[] | null;
  error: ServiceError | null;
}> {
  const { data, error } = await supabase.rpc('get_family_member_profiles', { fam: familyId });

  if (error) {
    return { data: null, error: mapSupabaseError(error) };
  }

  return { data: data ?? [], error: null };
}

export async function updateFamilyName(familyId: string, name: string): Promise<{
  data: Family | null;
  error: ServiceError | null;
}> {
  const trimmed = name.trim();

  if (!trimmed) {
    return { data: null, error: { message: 'Family name is required', code: 'validation_error' } };
  }

  const { data, error } = await supabase
    .from('families')
    .update({ name: trimmed })
    .eq('id', familyId)
    .select('*')
    .maybeSingle();

  if (error) {
    return { data: null, error: mapSupabaseError(error) };
  }

  return { data, error: null };
}

export async function leaveFamily(familyId: string, userId: string): Promise<{
  error: ServiceError | null;
}> {
  const { error } = await supabase
    .from('family_memberships')
    .delete()
    .eq('family_id', familyId)
    .eq('user_id', userId);

  if (error) {
    return { error: mapSupabaseError(error) };
  }

  return { error: null };
}
