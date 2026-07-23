import { supabase } from '@/lib/supabase';
import { invokeEdgeFunction } from '@/services/ai';
import { deleteStorageObject, getUploadUrl, uploadToPresignedUrl } from '@/services/media';
import {
  createPortraitVersion,
  deletePortraitVersion,
  fetchFamilyPortraitVersions,
  generatePortraitVersion,
  updatePortraitVersionDate,
} from '@/services/portrait-versions';

jest.mock('@/lib/supabase', () => ({
  supabase: { from: jest.fn(), rpc: jest.fn() },
}));

jest.mock('@/services/ai', () => ({
  invokeEdgeFunction: jest.fn(),
}));

jest.mock('@/services/media', () => ({
  deleteStorageObject: jest.fn(),
  getUploadUrl: jest.fn(),
  uploadToPresignedUrl: jest.fn(),
}));

jest.mock('@/utils/profile-photo', () => ({
  prepareProfilePhotoForUpload: jest.fn(async (uri: string) => ({
    uri: `${uri}-stripped.jpg`,
    contentType: 'image/jpeg',
  })),
}));

const mockedSupabase = supabase as jest.Mocked<typeof supabase>;
const mockedGetUploadUrl = getUploadUrl as jest.MockedFunction<typeof getUploadUrl>;
const mockedUpload = uploadToPresignedUrl as jest.MockedFunction<typeof uploadToPresignedUrl>;
const mockedDelete = deleteStorageObject as jest.MockedFunction<typeof deleteStorageObject>;
const mockedInvoke = invokeEdgeFunction as jest.MockedFunction<typeof invokeEdgeFunction>;

describe('portrait versions service integration', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockedGetUploadUrl.mockResolvedValue({
      data: { uploadUrl: 'https://upload.example', objectKey: 'key', expiresIn: 900 },
      error: null,
    });
    mockedUpload.mockResolvedValue({ error: null });
    mockedDelete.mockResolvedValue({ error: null });
  });

  it('loads one family timeline with deterministic server ordering', async () => {
    const secondOrder = jest.fn().mockResolvedValue({ data: [{ id: 'v1' }], error: null });
    const firstOrder = jest.fn().mockReturnValue({ order: secondOrder });
    const eq = jest.fn().mockReturnValue({ order: firstOrder });
    const select = jest.fn().mockReturnValue({ eq });
    mockedSupabase.from.mockReturnValue({ select } as never);

    const result = await fetchFamilyPortraitVersions('family-1');

    expect(eq).toHaveBeenCalledWith('family_id', 'family-1');
    expect(result.data).toEqual([{ id: 'v1' }]);
  });

  it('uploads stripped JPEG bytes before creating the immutable row', async () => {
    (mockedSupabase.rpc as jest.Mock).mockResolvedValue({
      data: [{ id: 'version-1', profile_picture_key: 'user-1/family/member-1/portraits/version-1/photo.jpg' }],
      error: null,
    });

    const result = await createPortraitVersion({
      versionId: 'version-1',
      userId: 'user-1',
      familyId: 'family-1',
      familyMemberId: 'member-1',
      photoUri: 'file:///photo.heic',
      photoContentType: 'image/heic',
      referenceDate: '2024-03-02',
      dateSource: 'exif',
      dateOfBirth: '2020-01-01',
    });

    const objectKey = 'user-1/family/member-1/portraits/version-1/photo.jpg';
    expect(mockedGetUploadUrl).toHaveBeenCalledWith(objectKey, 'image/jpeg', 'family-1');
    expect(mockedUpload).toHaveBeenCalledWith(
      'https://upload.example',
      'file:///photo.heic-stripped.jpg',
      'image/jpeg',
    );
    expect(mockedSupabase.rpc).toHaveBeenCalledWith('create_family_member_portrait_version', {
      version_id: 'version-1',
      target_family_member_id: 'member-1',
      portrait_reference_date: '2024-03-02',
      portrait_date_source: 'exif',
      source_profile_picture_key: objectKey,
    });
    expect(result.data?.id).toBe('version-1');
  });

  it('rolls back the uploaded source when row creation fails', async () => {
    (mockedSupabase.rpc as jest.Mock).mockResolvedValue({ data: null, error: { message: 'Denied' } });

    const result = await createPortraitVersion({
      versionId: 'version-2',
      userId: 'user-1',
      familyId: 'family-1',
      familyMemberId: 'member-1',
      photoUri: 'file:///photo.jpg',
      photoContentType: 'image/jpeg',
      referenceDate: '2024-03-02',
      dateSource: 'manual',
    });

    expect(result.error?.message).toBe('Denied');
    expect(mockedDelete).toHaveBeenCalledWith(
      'user-1/family/member-1/portraits/version-2/photo.jpg',
    );
  });

  it('uses the secured date, generation, and deletion contracts with legacy and queued responses', async () => {
    (mockedSupabase.rpc as jest.Mock).mockResolvedValue({ data: [{ id: 'version-1' }], error: null });
    mockedInvoke
      .mockResolvedValueOnce({ data: { success: true }, error: null })
      .mockResolvedValueOnce({ data: { success: true, queued: true, jobId: 'job-1' }, error: null })
      .mockResolvedValue({ data: { success: true }, error: null });

    await updatePortraitVersionDate('version-1', '2024-05-01');
    const legacy = await generatePortraitVersion('version-1');
    const queued = await generatePortraitVersion('version-2');
    await deletePortraitVersion('version-1');

    expect(legacy).toEqual({ data: { success: true }, error: null });
    expect(queued).toEqual({ data: { success: true, queued: true, jobId: 'job-1' }, error: null });

    expect(mockedSupabase.rpc).toHaveBeenCalledWith(
      'update_family_member_portrait_version_date',
      { target_version_id: 'version-1', portrait_reference_date: '2024-05-01' },
    );
    expect(mockedInvoke).toHaveBeenCalledWith('generate-portrait-illustration', {
      portraitVersionId: 'version-1',
    });
    expect(mockedInvoke).toHaveBeenCalledWith('generate-portrait-illustration', {
      portraitVersionId: 'version-2',
    });
    expect(mockedInvoke).toHaveBeenCalledWith('delete-portrait-version', {
      portraitVersionId: 'version-1',
    });
  });
});
