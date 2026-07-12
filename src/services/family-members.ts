import { supabase } from '@/lib/supabase';
import type { Database } from '@/types/database';
import {
  buildProfilePhotoKey,
  type CreateFamilyMemberInput,
  type UpdateFamilyMemberInput,
} from '@/utils/family-members';
import { getUploadUrl, uploadToPresignedUrl } from '@/services/media';
import { prepareProfilePhotoForUpload } from '@/utils/profile-photo';

export type FamilyMember = Database['public']['Tables']['family_members']['Row'];

export interface ServiceError {
  message: string;
  code?: string;
}

export interface CreateFamilyMemberWithPhotoInput extends CreateFamilyMemberInput {
  photoUri: string;
  photoContentType: string;
}

function mapSupabaseError(error: { message: string; code?: string }): ServiceError {
  return {
    message: error.message,
    code: error.code,
  };
}

type FamilyMemberWithTagCount = FamilyMember & {
  memory_family_members: { count: number }[] | null;
};

export async function fetchFamilyMembers(): Promise<{
  data: FamilyMember[] | null;
  error: ServiceError | null;
}> {
  const { data, error } = await supabase
    .from('family_members')
    .select('*, memory_family_members(count)')
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
      illustrated_profile_status: 'pending',
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
      ...(input.profilePictureKey !== undefined
        ? { profile_picture_key: input.profilePictureKey }
        : {}),
      ...(input.illustratedProfileStatus !== undefined
        ? { illustrated_profile_status: input.illustratedProfileStatus }
        : {}),
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
  const { error } = await supabase.from('family_members').delete().eq('id', memberId);

  if (error) {
    return { error: mapSupabaseError(error) };
  }

  return { error: null };
}

/**
 * Recover a portrait job when the Edge Function times out after setting the
 * row to an in-progress state. The status predicates avoid overwriting a
 * portrait that completed while the client was handling the timeout.
 */
export async function markPortraitGenerationFailed(
  memberId: string,
): Promise<{ error: ServiceError | null }> {
  const { error } = await supabase
    .from('family_members')
    .update({ illustrated_profile_status: 'failed' })
    .eq('id', memberId)
    .in('illustrated_profile_status', ['pending', 'generating']);

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
  /** When true and a new photo is uploaded, mark portrait pending for regeneration. */
  regeneratePortrait?: boolean;
}

export async function updateFamilyMemberWithPhoto(
  input: UpdateFamilyMemberWithPhotoInput,
): Promise<{ data: FamilyMember | null; error: ServiceError | null }> {
  let profilePictureKey: string | undefined;

  if (input.photoUri && input.photoContentType) {
    const preparedPhoto = await prepareProfilePhotoForUpload(input.photoUri);
    const objectKey = buildProfilePhotoKey(input.userId, input.memberId);
    const { data: uploadData, error: uploadUrlError } = await getUploadUrl(
      objectKey,
      preparedPhoto.contentType,
      input.familyId,
    );
    if (uploadUrlError || !uploadData) {
      return { data: null, error: uploadUrlError ?? { message: 'Upload URL was not returned' } };
    }
    const { error: uploadError } = await uploadToPresignedUrl(
      uploadData.uploadUrl,
      preparedPhoto.uri,
      preparedPhoto.contentType,
    );
    if (uploadError) {
      return { data: null, error: uploadError };
    }
    profilePictureKey = objectKey;
  }

  const shouldRegeneratePortrait = Boolean(profilePictureKey && input.regeneratePortrait);

  return updateFamilyMember(input.memberId, {
    name: input.name,
    dateOfBirth: input.dateOfBirth,
    gender: input.gender,
    additionalInfo: input.additionalInfo,
    nicknames: input.nicknames,
    ...(profilePictureKey ? { profilePictureKey } : {}),
    ...(shouldRegeneratePortrait ? { illustratedProfileStatus: 'pending' } : {}),
  });
}

export async function createFamilyMemberWithPhoto(
  input: CreateFamilyMemberWithPhotoInput,
): Promise<{ data: FamilyMember | null; error: ServiceError | null }> {
  const { data: member, error: createError } = await createFamilyMember(input);

  if (createError || !member) {
    return { data: null, error: createError };
  }

  const objectKey = buildProfilePhotoKey(input.userId, member.id);
  const preparedPhoto = await prepareProfilePhotoForUpload(input.photoUri);
  const { data: uploadData, error: uploadUrlError } = await getUploadUrl(
    objectKey,
    preparedPhoto.contentType,
    input.familyId,
  );

  if (uploadUrlError || !uploadData) {
    await deleteFamilyMember(member.id);
    return { data: null, error: uploadUrlError ?? { message: 'Upload URL was not returned' } };
  }

  const { error: uploadError } = await uploadToPresignedUrl(
    uploadData.uploadUrl,
    preparedPhoto.uri,
    preparedPhoto.contentType,
  );

  if (uploadError) {
    await deleteFamilyMember(member.id);
    return { data: null, error: uploadError };
  }

  return updateFamilyMember(member.id, {
    profilePictureKey: objectKey,
    illustratedProfileStatus: 'pending',
  });
}
