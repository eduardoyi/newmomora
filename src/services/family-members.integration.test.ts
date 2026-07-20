import {
  createFamilyMemberWithPhoto,
  fetchFamilyMembers,
  updateFamilyMemberWithPhoto,
} from '@/services/family-members';
import { invokeEdgeFunction } from '@/services/ai';
import { createPortraitVersion } from '@/services/portrait-versions';
import { supabase } from '@/lib/supabase';

jest.mock('@/lib/supabase', () => ({
  supabase: { from: jest.fn() },
}));

jest.mock('@/services/ai', () => ({
  invokeEdgeFunction: jest.fn().mockResolvedValue({ data: { success: true }, error: null }),
}));

jest.mock('@/services/portrait-versions', () => ({
  createPortraitVersion: jest.fn(),
}));

const mockedSupabase = supabase as jest.Mocked<typeof supabase>;
const mockedCreatePortraitVersion = createPortraitVersion as jest.MockedFunction<
  typeof createPortraitVersion
>;
const mockedInvokeEdgeFunction = invokeEdgeFunction as jest.MockedFunction<typeof invokeEdgeFunction>;

describe('family-members service integration', () => {
  beforeEach(() => jest.clearAllMocks());

  it('orders family members by tag count', async () => {
    const order = jest.fn().mockResolvedValue({
      data: [
        { id: 'member-1', name: 'Maya', memory_family_members: [{ count: 2 }] },
        { id: 'member-2', name: 'Leo', memory_family_members: [{ count: 7 }] },
      ],
      error: null,
    });
    const eq = jest.fn().mockReturnValue({ order });
    const select = jest.fn().mockReturnValue({ eq });
    mockedSupabase.from.mockReturnValue({ select } as never);

    const result = await fetchFamilyMembers('family-1');

    expect(eq).toHaveBeenCalledWith('family_id', 'family-1');
    expect(result.data?.map((member) => member.id)).toEqual(['member-2', 'member-1']);
  });

  it('creates the member then its first immutable portrait version', async () => {
    const member = { id: 'member-1', family_id: 'family-1', date_of_birth: '2020-05-24' };
    const single = jest.fn().mockResolvedValue({ data: member, error: null });
    const select = jest.fn().mockReturnValue({ single });
    const insert = jest.fn().mockReturnValue({ select });
    mockedSupabase.from.mockReturnValue({ insert } as never);
    mockedCreatePortraitVersion.mockResolvedValue({
      data: { id: 'portrait-1' } as never,
      error: null,
    });

    const result = await createFamilyMemberWithPhoto({
      userId: 'user-1',
      familyId: 'family-1',
      name: 'Maya',
      dateOfBirth: '2020-05-24',
      photoUri: 'file:///photo.jpg',
      photoContentType: 'image/jpeg',
      photoReferenceDate: '2024-04-02',
      photoDateSource: 'exif',
    });

    expect(result.portraitVersion?.id).toBe('portrait-1');
    expect(mockedCreatePortraitVersion).toHaveBeenCalledWith(
      expect.objectContaining({
        familyMemberId: 'member-1',
        referenceDate: '2024-04-02',
        dateSource: 'exif',
      }),
    );
  });

  it('deletes the newly created member if its initial portrait version fails', async () => {
    const single = jest.fn().mockResolvedValue({
      data: { id: 'member-1', family_id: 'family-1' },
      error: null,
    });
    const select = jest.fn().mockReturnValue({ single });
    mockedSupabase.from.mockReturnValue({ insert: jest.fn().mockReturnValue({ select }) } as never);
    mockedCreatePortraitVersion.mockResolvedValue({
      data: null,
      error: { message: 'Upload failed' },
    });

    const result = await createFamilyMemberWithPhoto({
      userId: 'user-1',
      familyId: 'family-1',
      name: 'Maya',
      dateOfBirth: '2020-05-24',
      photoUri: 'file:///photo.jpg',
      photoContentType: 'image/jpeg',
    });

    expect(result.error?.message).toBe('Upload failed');
    expect(mockedInvokeEdgeFunction).toHaveBeenCalledWith('delete-family-member', {
      familyMemberId: 'member-1',
    });
  });

  it('adds an edited photo as another version instead of replacing legacy keys', async () => {
    const updatePayloads: unknown[] = [];
    const single = jest.fn().mockResolvedValue({
      data: { id: 'member-1', date_of_birth: '2020-05-24' },
      error: null,
    });
    const select = jest.fn().mockReturnValue({ single });
    const eq = jest.fn().mockReturnValue({ select });
    const update = jest.fn((payload) => {
      updatePayloads.push(payload);
      return { eq };
    });
    mockedSupabase.from.mockReturnValue({ update } as never);
    mockedCreatePortraitVersion.mockResolvedValue({
      data: { id: 'portrait-2' } as never,
      error: null,
    });

    const result = await updateFamilyMemberWithPhoto({
      memberId: 'member-1',
      userId: 'user-1',
      familyId: 'family-1',
      name: 'Maya',
      photoUri: 'file:///new.jpg',
      photoContentType: 'image/jpeg',
      photoReferenceDate: '2025-01-02',
      photoDateSource: 'manual',
    });

    expect(result.portraitVersion?.id).toBe('portrait-2');
    expect(updatePayloads[0]).not.toEqual(
      expect.objectContaining({ profile_picture_key: expect.anything() }),
    );
    expect(mockedCreatePortraitVersion).toHaveBeenCalledWith(
      expect.objectContaining({ familyMemberId: 'member-1', referenceDate: '2025-01-02' }),
    );
  });
});
