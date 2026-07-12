import {
  createFamilyMemberWithPhoto,
  fetchFamilyMembers,
  updateFamilyMemberWithPhoto,
} from '@/services/family-members';
import { getUploadUrl, uploadToPresignedUrl } from '@/services/media';
import { supabase } from '@/lib/supabase';

jest.mock('@/lib/supabase', () => ({
  supabase: {
    from: jest.fn(),
    functions: {
      invoke: jest.fn(),
    },
  },
}));

jest.mock('@/services/media', () => ({
  getUploadUrl: jest.fn(),
  uploadToPresignedUrl: jest.fn(),
  getMediaUrls: jest.fn(),
}));

jest.mock('@/utils/profile-photo', () => ({
  prepareProfilePhotoForUpload: jest.fn(async (uri: string) => ({
    uri: `${uri}-prepared`,
    contentType: 'image/jpeg',
  })),
}));

const mockedSupabase = supabase as jest.Mocked<typeof supabase>;
const mockedGetUploadUrl = getUploadUrl as jest.MockedFunction<typeof getUploadUrl>;
const mockedUploadToPresignedUrl = uploadToPresignedUrl as jest.MockedFunction<
  typeof uploadToPresignedUrl
>;

describe('family-members service integration', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('fetchFamilyMembers orders members by tag count, then created_at', async () => {
    const order = jest.fn().mockResolvedValue({
      data: [
        { id: 'member-1', name: 'Maya', memory_family_members: [{ count: 2 }] },
        { id: 'member-2', name: 'Leo', memory_family_members: [{ count: 7 }] },
        { id: 'member-3', name: 'Ana', memory_family_members: [] },
        { id: 'member-4', name: 'Sol', memory_family_members: [{ count: 2 }] },
      ],
      error: null,
    });
    const select = jest.fn().mockReturnValue({ order });
    mockedSupabase.from.mockReturnValue({ select } as never);

    const result = await fetchFamilyMembers();

    expect(select).toHaveBeenCalledWith('*, memory_family_members(count)');
    expect(order).toHaveBeenCalledWith('created_at', { ascending: true });
    expect(result.data).toEqual([
      { id: 'member-2', name: 'Leo' },
      { id: 'member-1', name: 'Maya' },
      { id: 'member-4', name: 'Sol' },
      { id: 'member-3', name: 'Ana' },
    ]);
  });

  it('createFamilyMemberWithPhoto uploads photo and updates profile key', async () => {
    const member = {
      id: 'member-1',
      user_id: 'user-1',
      name: 'Maya',
      profile_picture_key: null,
    };

    const insertSingle = jest.fn().mockResolvedValue({ data: member, error: null });
    const insertSelect = jest.fn().mockReturnValue({ single: insertSingle });
    const insert = jest.fn().mockReturnValue({ select: insertSelect });

    const updateSingle = jest.fn().mockResolvedValue({
      data: {
        ...member,
        profile_picture_key: 'user-1/family/member-1/photo.webp',
      },
      error: null,
    });
    const updateSelect = jest.fn().mockReturnValue({ single: updateSingle });
    const updateEq = jest.fn().mockReturnValue({ select: updateSelect });
    const update = jest.fn().mockReturnValue({ eq: updateEq });

    const deleteEq = jest.fn().mockResolvedValue({ error: null });
    const deleteFn = jest.fn().mockReturnValue({ eq: deleteEq });

    mockedSupabase.from.mockImplementation((table: string) => {
      if (table === 'family_members') {
        return {
          insert,
          update,
          delete: deleteFn,
        } as never;
      }

      throw new Error(`Unexpected table ${table}`);
    });

    mockedGetUploadUrl.mockResolvedValue({
      data: {
        uploadUrl: 'https://upload.example',
        objectKey: 'user-1/family/member-1/photo.webp',
        expiresIn: 900,
      },
      error: null,
    });

    mockedUploadToPresignedUrl.mockResolvedValue({ error: null });

    const result = await createFamilyMemberWithPhoto({
      userId: 'user-1',
      familyId: 'family-1',
      name: 'Maya',
      dateOfBirth: '2020-05-24',
      photoUri: 'file:///photo.jpg',
      photoContentType: 'image/jpeg',
    });

    expect(result.error).toBeNull();
    expect(result.data?.profile_picture_key).toBe('user-1/family/member-1/photo.webp');
    expect(mockedGetUploadUrl).toHaveBeenCalledWith(
      'user-1/family/member-1/photo.webp',
      'image/jpeg',
      'family-1',
    );
    expect(mockedUploadToPresignedUrl).toHaveBeenCalledWith(
      'https://upload.example',
      'file:///photo.jpg-prepared',
      'image/jpeg',
    );
  });

  it('rolls back member creation when upload fails', async () => {
    const member = {
      id: 'member-1',
      user_id: 'user-1',
      name: 'Maya',
      profile_picture_key: null,
    };

    const insertSingle = jest.fn().mockResolvedValue({ data: member, error: null });
    const insertSelect = jest.fn().mockReturnValue({ single: insertSingle });
    const insert = jest.fn().mockReturnValue({ select: insertSelect });

    const deleteEq = jest.fn().mockResolvedValue({ error: null });
    const deleteFn = jest.fn().mockReturnValue({ eq: deleteEq });

    mockedSupabase.from.mockReturnValue({
      insert,
      delete: deleteFn,
    } as never);

    mockedGetUploadUrl.mockResolvedValue({
      data: null,
      error: { message: 'Unauthorized' },
    });

    const result = await createFamilyMemberWithPhoto({
      userId: 'user-1',
      familyId: 'family-1',
      name: 'Maya',
      dateOfBirth: '2020-05-24',
      photoUri: 'file:///photo.jpg',
      photoContentType: 'image/jpeg',
    });

    expect(result.data).toBeNull();
    expect(result.error?.message).toBe('Unauthorized');
    expect(deleteEq).toHaveBeenCalledWith('id', 'member-1');
  });

  it('updateFamilyMemberWithPhoto skips portrait pending when regeneratePortrait is false', async () => {
    const member = {
      id: 'member-1',
      user_id: 'user-1',
      name: 'Maya',
      profile_picture_key: 'user-1/family/member-1/photo-old.webp',
      illustrated_profile_status: 'ready',
    };

    const updateSingle = jest.fn().mockResolvedValue({
      data: {
        ...member,
        profile_picture_key: 'user-1/family/member-1/photo.webp',
        illustrated_profile_status: 'ready',
      },
      error: null,
    });
    const updateSelect = jest.fn().mockReturnValue({ single: updateSingle });
    const updateEq = jest.fn().mockReturnValue({ select: updateSelect });
    const update = jest.fn().mockReturnValue({ eq: updateEq });

    mockedSupabase.from.mockReturnValue({ update } as never);

    mockedGetUploadUrl.mockResolvedValue({
      data: {
        uploadUrl: 'https://upload.example',
        objectKey: 'user-1/family/member-1/photo.webp',
        expiresIn: 900,
      },
      error: null,
    });
    mockedUploadToPresignedUrl.mockResolvedValue({ error: null });

    await updateFamilyMemberWithPhoto({
      memberId: 'member-1',
      userId: 'user-1',
      familyId: 'family-1',
      photoUri: 'file:///photo.jpg',
      photoContentType: 'image/jpeg',
      regeneratePortrait: false,
    });

    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({
        profile_picture_key: 'user-1/family/member-1/photo.webp',
      }),
    );
    expect(update).toHaveBeenCalledWith(
      expect.not.objectContaining({
        illustrated_profile_status: 'pending',
      }),
    );
  });

  it('updateFamilyMemberWithPhoto marks portrait pending when regeneratePortrait is true', async () => {
    const member = {
      id: 'member-1',
      user_id: 'user-1',
      name: 'Maya',
      illustrated_profile_status: 'ready',
    };

    const updateSingle = jest.fn().mockResolvedValue({
      data: { ...member, illustrated_profile_status: 'pending' },
      error: null,
    });
    const updateSelect = jest.fn().mockReturnValue({ single: updateSingle });
    const updateEq = jest.fn().mockReturnValue({ select: updateSelect });
    const update = jest.fn().mockReturnValue({ eq: updateEq });

    mockedSupabase.from.mockReturnValue({ update } as never);

    mockedGetUploadUrl.mockResolvedValue({
      data: {
        uploadUrl: 'https://upload.example',
        objectKey: 'user-1/family/member-1/photo.webp',
        expiresIn: 900,
      },
      error: null,
    });
    mockedUploadToPresignedUrl.mockResolvedValue({ error: null });

    await updateFamilyMemberWithPhoto({
      memberId: 'member-1',
      userId: 'user-1',
      familyId: 'family-1',
      photoUri: 'file:///photo.jpg',
      photoContentType: 'image/jpeg',
      regeneratePortrait: true,
    });

    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({
        illustrated_profile_status: 'pending',
      }),
    );
  });
});
