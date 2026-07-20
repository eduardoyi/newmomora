import { supabase } from '@/lib/supabase';
import type { Database } from '@/types/database';
import {
  type CreateFamilyMemberInput,
  type UpdateFamilyMemberInput,
} from '@/utils/family-members';
import { invokeEdgeFunction } from '@/services/ai';
import { createPortraitVersion } from '@/services/portrait-versions';
import type {
  FamilyMemberPortraitVersion,
  PortraitDateSource,
  PortraitResolvedMemberFields,
} from '@/utils/portrait-versions';
import { getLocalTodayIso } from '@/utils/portrait-versions';

export type FamilyMemberRow = Database['public']['Tables']['family_members']['Row'];
export type FamilyMember = FamilyMemberRow & Partial<PortraitResolvedMemberFields>;

export interface ServiceError {
  message: string;
  code?: string;
}

export interface CreateFamilyMemberWithPhotoInput extends CreateFamilyMemberInput {
  photoUri: string;
  photoContentType: string;
  photoReferenceDate?: string;
  photoDateSource?: Exclude<PortraitDateSource, 'legacy_unknown'>;
}

function mapSupabaseError(error: { message: string; code?: string }): ServiceError {
  return {
    message: error.message,
    code: error.code,
  };
}

type FamilyMemberWithTagCount = FamilyMemberRow & {
  memory_family_members: { count: number }[] | null;
};

export async function fetchFamilyMembers(familyId: string): Promise<{
  data: FamilyMember[] | null;
  error: ServiceError | null;
}> {
  const { data, error } = await supabase
    .from('family_members')
    .select('*, memory_family_members(count)')
    .eq('family_id', familyId)
    .order('created_at', { ascending: true });

  if (error) {
    return { data: null, error: mapSupabaseError(error) };
  }

  // Most-tagged members first so they surface at the top of the family
  // screen and the front of the memory tag chips. The stable sort keeps
  // created_at order within equal counts.
  const members = ((data ?? []) as FamilyMemberWithTagCount[])
    .map(({ memory_family_members, ...member }) => ({
      member: member as FamilyMember,
      tagCount: memory_family_members?.[0]?.count ?? 0,
    }))
    .sort((a, b) => b.tagCount - a.tagCount)
    .map((entry) => entry.member);

  return { data: members, error: null };
}

export async function createFamilyMember(
  input: CreateFamilyMemberInput,
): Promise<{ data: FamilyMember | null; error: ServiceError | null }> {
  const { data, error } = await supabase
    .from('family_members')
    .insert({
      user_id: input.userId,
      family_id: input.familyId,
      name: input.name.trim(),
      date_of_birth: input.dateOfBirth,
      gender: input.gender?.trim() || null,
      additional_info: input.additionalInfo?.trim() || null,
      nicknames: input.nicknames ?? null,
    })
    .select('*')
    .single();

  if (error) {
    return { data: null, error: mapSupabaseError(error) };
  }

  return { data, error: null };
}

export async function updateFamilyMember(
  memberId: string,
  input: UpdateFamilyMemberInput,
): Promise<{ data: FamilyMember | null; error: ServiceError | null }> {
  const { data, error } = await supabase
    .from('family_members')
    .update({
      ...(input.name !== undefined ? { name: input.name.trim() } : {}),
      ...(input.dateOfBirth !== undefined ? { date_of_birth: input.dateOfBirth } : {}),
      ...(input.gender !== undefined ? { gender: input.gender } : {}),
      ...(input.additionalInfo !== undefined ? { additional_info: input.additionalInfo } : {}),
      ...(input.nicknames !== undefined ? { nicknames: input.nicknames } : {}),
    })
    .eq('id', memberId)
    .select('*')
    .single();

  if (error) {
    return { data: null, error: mapSupabaseError(error) };
  }

  return { data, error: null };
}

export async function deleteFamilyMember(
  memberId: string,
): Promise<{ error: ServiceError | null }> {
  const { error } = await invokeEdgeFunction('delete-family-member', { familyMemberId: memberId });

  if (error) {
    return { error: mapSupabaseError(error) };
  }

  return { error: null };
}

export interface UpdateFamilyMemberWithPhotoInput {
  memberId: string;
  userId: string;
  familyId: string;
  name?: string;
  dateOfBirth?: string | null;
  gender?: string | null;
  additionalInfo?: string | null;
  nicknames?: string[] | null;
  photoUri?: string;
  photoContentType?: string;
  photoReferenceDate?: string;
  photoDateSource?: Exclude<PortraitDateSource, 'legacy_unknown'>;
}

export async function updateFamilyMemberWithPhoto(
  input: UpdateFamilyMemberWithPhotoInput,
): Promise<{
  data: FamilyMember | null;
  portraitVersion: FamilyMemberPortraitVersion | null;
  error: ServiceError | null;
}> {
  const updated = await updateFamilyMember(input.memberId, {
    name: input.name,
    dateOfBirth: input.dateOfBirth,
    gender: input.gender,
    additionalInfo: input.additionalInfo,
    nicknames: input.nicknames,
  });
  if (updated.error || !updated.data) {
    return { data: null, portraitVersion: null, error: updated.error };
  }

  if (!input.photoUri || !input.photoContentType) {
    return { data: updated.data, portraitVersion: null, error: null };
  }

  const { data: portraitVersion, error } = await createPortraitVersion({
    userId: input.userId,
    familyId: input.familyId,
    familyMemberId: input.memberId,
    photoUri: input.photoUri,
    photoContentType: input.photoContentType,
    referenceDate: input.photoReferenceDate ?? getLocalTodayIso(),
    dateSource: input.photoDateSource ?? 'default_today',
    dateOfBirth: input.dateOfBirth ?? updated.data.date_of_birth,
  });

  return { data: updated.data, portraitVersion, error };
}

export async function createFamilyMemberWithPhoto(
  input: CreateFamilyMemberWithPhotoInput,
): Promise<{
  data: FamilyMember | null;
  portraitVersion: FamilyMemberPortraitVersion | null;
  error: ServiceError | null;
}> {
  const { data: member, error: createError } = await createFamilyMember(input);

  if (createError || !member) {
    return { data: null, portraitVersion: null, error: createError };
  }

  const { data: portraitVersion, error } = await createPortraitVersion({
    userId: input.userId,
    familyId: input.familyId,
    familyMemberId: member.id,
    photoUri: input.photoUri,
    photoContentType: input.photoContentType,
    referenceDate: input.photoReferenceDate ?? getLocalTodayIso(),
    dateSource: input.photoDateSource ?? 'default_today',
    dateOfBirth: input.dateOfBirth,
  });

  if (error || !portraitVersion) {
    await deleteFamilyMember(member.id);
    return { data: null, portraitVersion: null, error: error ?? { message: 'Portrait version was not created' } };
  }

  return { data: member, portraitVersion, error: null };
}
