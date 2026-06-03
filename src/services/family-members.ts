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

export async function fetchFamilyMembers(): Promise<{
  data: FamilyMember[] | null;
  error: ServiceError | null;
}> {
  const { data, error } = await supabase
    .from('family_members')
    .select('*')
    .order('created_at', { ascending: true });

  if (error) {
    return { data: null, error: mapSupabaseError(error) };
  }

  return { data, error: null };
}

export async function createFamilyMember(
  input: CreateFamilyMemberInput,
): Promise<{ data: FamilyMember | null; error: ServiceError | null }> {
  const { data, error } = await supabase
    .from('family_members')
    .insert({
      user_id: input.userId,
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

export interface UpdateFamilyMemberWithPhotoInput {
  memberId: string;
  userId: string;
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
