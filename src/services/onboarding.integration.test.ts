import { commitOnboarding, notificationSettingsForChoice } from '@/services/onboarding';
import { createFamily, deleteFamily, fetchMyFamilyMemberships } from '@/services/family';
import { createFamilyMember, fetchFamilyMembers } from '@/services/family-members';
import { createMemory } from '@/services/memories';
import { fetchUserProfile, updateUserProfile } from '@/services/user-profile';
import { patchOnboardingDraft, createEmptyOnboardingDraft, type OnboardingDraft } from '@/utils/onboarding-progress';
import { supabase } from '@/lib/supabase';

jest.mock('@/lib/supabase', () => ({
  supabase: { auth: { getUser: jest.fn() } },
}));

jest.mock('@/services/family', () => ({
  createFamily: jest.fn(),
  deleteFamily: jest.fn(),
  fetchMyFamilyMemberships: jest.fn(),
  friendlyFamilyLimitError: jest.fn((message: string) => message),
}));

jest.mock('@/services/family-members', () => ({
  createFamilyMember: jest.fn(),
  fetchFamilyMembers: jest.fn(),
}));

jest.mock('@/services/memories', () => ({
  createMemory: jest.fn(),
}));

jest.mock('@/services/user-profile', () => ({
  fetchUserProfile: jest.fn(),
  updateUserProfile: jest.fn(),
}));

// onboarding-progress.ts imports AsyncStorage at module scope even though
// this suite only needs its pure createEmptyOnboardingDraft helper and
// types -- mocked the same way other suites stub the native module out
// (e.g. new-memory.integration.test.tsx).
jest.mock('@react-native-async-storage/async-storage', () =>
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- jest.mock factories cannot use ESM imports
  require('@react-native-async-storage/async-storage/jest/async-storage-mock'),
);

jest.mock('@/utils/onboarding-progress', () => {
  const actual = jest.requireActual('@/utils/onboarding-progress');
  return {
    ...actual,
    patchOnboardingDraft: jest.fn().mockResolvedValue(undefined),
  };
});

const mockedSupabase = supabase as jest.Mocked<typeof supabase>;
const mockedCreateFamily = createFamily as jest.MockedFunction<typeof createFamily>;
const mockedDeleteFamily = deleteFamily as jest.MockedFunction<typeof deleteFamily>;
const mockedFetchMyFamilyMemberships = fetchMyFamilyMemberships as jest.MockedFunction<typeof fetchMyFamilyMemberships>;
const mockedCreateFamilyMember = createFamilyMember as jest.MockedFunction<typeof createFamilyMember>;
const mockedFetchFamilyMembers = fetchFamilyMembers as jest.MockedFunction<typeof fetchFamilyMembers>;
const mockedCreateMemory = createMemory as jest.MockedFunction<typeof createMemory>;
const mockedFetchUserProfile = fetchUserProfile as jest.MockedFunction<typeof fetchUserProfile>;
const mockedUpdateUserProfile = updateUserProfile as jest.MockedFunction<typeof updateUserProfile>;
const mockedPatchOnboardingDraft = patchOnboardingDraft as jest.MockedFunction<typeof patchOnboardingDraft>;

function buildDraft(overrides: Partial<OnboardingDraft> = {}): OnboardingDraft {
  return {
    ...createEmptyOnboardingDraft('code'),
    kidNames: ['Lila', 'Miguel'],
    familyName: "Lila & Miguel's Family",
    capture: {
      text: 'She lined up her stuffed animals to watch for the garbage truck.',
      taggedKidIndexes: [0],
    },
    notificationChoice: 'eve',
    ...overrides,
  };
}

describe('commitOnboarding', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockedSupabase.auth.getUser.mockResolvedValue({
      data: { user: { id: 'user-1' } },
      error: null,
    } as never);
    mockedUpdateUserProfile.mockResolvedValue({ data: null, error: null });
    // No existing family by default -- most tests exercise the brand-new-
    // owner path; the returning-owner tests override this.
    mockedFetchMyFamilyMemberships.mockResolvedValue({ data: [], error: null });
  });

  it('creates the family, one member per kid name in order, and the tagged first memory', async () => {
    mockedCreateFamily.mockResolvedValue({
      data: { id: 'family-1', name: "Lila & Miguel's Family" } as never,
      error: null,
    });
    mockedCreateFamilyMember
      .mockResolvedValueOnce({ data: { id: 'member-lila' } as never, error: null })
      .mockResolvedValueOnce({ data: { id: 'member-miguel' } as never, error: null });
    mockedCreateMemory.mockResolvedValue({ data: { id: 'memory-1' } as never, error: null });

    const result = await commitOnboarding(buildDraft());

    expect(result.error).toBeNull();
    expect(result.data).toEqual({
      familyId: 'family-1',
      memoryId: 'memory-1',
      isNewFamily: true,
      pendingMediaUpload: null,
    });

    expect(mockedCreateFamily).toHaveBeenCalledWith("Lila & Miguel's Family");
    expect(mockedCreateFamilyMember).toHaveBeenNthCalledWith(1, {
      userId: 'user-1',
      familyId: 'family-1',
      name: 'Lila',
      dateOfBirth: null,
    });
    expect(mockedCreateFamilyMember).toHaveBeenNthCalledWith(2, {
      userId: 'user-1',
      familyId: 'family-1',
      name: 'Miguel',
      dateOfBirth: null,
    });
    expect(mockedCreateMemory).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'user-1',
        familyId: 'family-1',
        content: 'She lined up her stuffed animals to watch for the garbage truck.',
        taggedMemberIds: ['member-lila'],
        memoryType: 'text_only',
      }),
    );
    // Family + kids + memory committed before notification prefs apply.
    expect(mockedPatchOnboardingDraft).toHaveBeenCalledWith({ committedFamilyId: 'family-1' });
    expect(mockedUpdateUserProfile).toHaveBeenCalledWith({
      enableDailyReminder: true,
      notificationTime: '20:00',
    });
  });

  it('falls back to tagging the first kid when no chip is selected', async () => {
    mockedCreateFamily.mockResolvedValue({ data: { id: 'family-1' } as never, error: null });
    mockedCreateFamilyMember.mockResolvedValueOnce({ data: { id: 'member-lila' } as never, error: null });
    mockedCreateMemory.mockResolvedValue({ data: { id: 'memory-1' } as never, error: null });

    await commitOnboarding(
      buildDraft({ kidNames: ['Lila'], capture: { text: 'Said a new word.', taggedKidIndexes: [] } }),
    );

    expect(mockedCreateMemory).toHaveBeenCalledWith(
      expect.objectContaining({ taggedMemberIds: ['member-lila'] }),
    );
  });

  it('builds a pendingMediaUpload payload for the media path instead of calling createMemory or enqueueing anything itself', async () => {
    mockedCreateFamily.mockResolvedValue({ data: { id: 'family-1' } as never, error: null });
    mockedCreateFamilyMember.mockResolvedValueOnce({ data: { id: 'member-lila' } as never, error: null });

    const result = await commitOnboarding(
      buildDraft({
        kidNames: ['Lila'],
        capture: {
          text: 'Garbage truck fan club.',
          mediaUri: 'file:///photo.jpg',
          mediaContentType: 'image/jpeg',
          taggedKidIndexes: [0],
        },
      }),
    );

    // commitOnboarding no longer calls the pending-upload queue itself (see
    // CommitOnboardingResult.pendingMediaUpload's doc comment) -- it hands
    // the caller (code.tsx) everything needed to enqueue it later, once
    // FamilyProvider's membership cache actually knows about the family.
    expect(mockedCreateMemory).not.toHaveBeenCalled();
    expect(result.error).toBeNull();
    expect(result.data?.familyId).toBe('family-1');
    expect(result.data?.isNewFamily).toBe(true);
    expect(typeof result.data?.memoryId).toBe('string');
    expect(result.data?.pendingMediaUpload).toEqual({
      memoryId: result.data?.memoryId,
      content: 'Garbage truck fan club.',
      memoryDate: expect.any(String),
      taggedMemberIds: ['member-lila'],
      mediaAssets: [{ fileUri: 'file:///photo.jpg', contentType: 'image/jpeg' }],
    });
  });

  // Regression test for the media-sizing bug: a draft's captured aspect
  // ratio/duration (populated by app/(onboarding)/capture.tsx from
  // MediaAttachment, the same source new-memory.tsx reads) must reach the
  // enqueue payload untouched -- its absence is what let onboarding photos
  // ship pillarboxed at DEFAULT_MEDIA_ASPECT_RATIO instead of sized to the
  // photo (see OnboardingDraftCapture's doc comment).
  it('carries the captured aspect ratio and duration through to the pendingMediaUpload mediaAssets payload', async () => {
    mockedCreateFamily.mockResolvedValue({ data: { id: 'family-1' } as never, error: null });
    mockedCreateFamilyMember.mockResolvedValueOnce({ data: { id: 'member-lila' } as never, error: null });

    const result = await commitOnboarding(
      buildDraft({
        kidNames: ['Lila'],
        capture: {
          text: 'Garbage truck fan club.',
          mediaUri: 'file:///video.mov',
          mediaContentType: 'video/quicktime',
          mediaAspectRatio: 0.5625,
          mediaDurationMs: 4200,
          taggedKidIndexes: [0],
        },
      }),
    );

    expect(result.error).toBeNull();
    expect(result.data?.pendingMediaUpload?.mediaAssets).toEqual([
      {
        fileUri: 'file:///video.mov',
        contentType: 'video/quicktime',
        aspectRatio: 0.5625,
        durationMs: 4200,
      },
    ]);
  });

  it('leaves aspectRatio/durationMs undefined on the payload when the draft never captured them (pre-fix on-disk draft)', async () => {
    mockedCreateFamily.mockResolvedValue({ data: { id: 'family-1' } as never, error: null });
    mockedCreateFamilyMember.mockResolvedValueOnce({ data: { id: 'member-lila' } as never, error: null });

    const result = await commitOnboarding(
      buildDraft({
        kidNames: ['Lila'],
        capture: {
          text: 'Garbage truck fan club.',
          mediaUri: 'file:///photo.jpg',
          mediaContentType: 'image/jpeg',
          taggedKidIndexes: [0],
        },
      }),
    );

    expect(result.data?.pendingMediaUpload?.mediaAssets[0]?.aspectRatio).toBeUndefined();
    expect(result.data?.pendingMediaUpload?.mediaAssets[0]?.durationMs).toBeUndefined();
  });

  it('rolls back the newly created family and returns a retryable error when a kid profile fails to create', async () => {
    mockedCreateFamily.mockResolvedValue({ data: { id: 'family-1' } as never, error: null });
    mockedCreateFamilyMember
      .mockResolvedValueOnce({ data: { id: 'member-lila' } as never, error: null })
      .mockResolvedValueOnce({ data: null, error: { message: 'Could not create Miguel' } });
    mockedDeleteFamily.mockResolvedValue({ data: null, error: null });

    const result = await commitOnboarding(buildDraft());

    expect(result.data).toBeNull();
    expect(result.error?.message).toBe('Could not create Miguel');
    expect(mockedDeleteFamily).toHaveBeenCalledWith('family-1');
    expect(mockedCreateMemory).not.toHaveBeenCalled();
    // Never marked committed -- a retry must go through step 2 again, not
    // skip to step 5 against a rolled-back family.
    expect(mockedPatchOnboardingDraft).not.toHaveBeenCalled();
  });

  it('does not create anything twice once committedFamilyId is already set (idempotent re-commit)', async () => {
    const result = await commitOnboarding(buildDraft({ committedFamilyId: 'family-1' }));

    expect(mockedFetchMyFamilyMemberships).not.toHaveBeenCalled();
    expect(mockedCreateFamily).not.toHaveBeenCalled();
    expect(mockedCreateFamilyMember).not.toHaveBeenCalled();
    expect(mockedCreateMemory).not.toHaveBeenCalled();
    expect(mockedPatchOnboardingDraft).not.toHaveBeenCalled();
    expect(result.error).toBeNull();
    expect(result.data).toEqual({
      familyId: 'family-1',
      memoryId: null,
      isNewFamily: false,
      pendingMediaUpload: null,
    });
    // Notification prefs still apply -- harmless and cheap to redo.
    expect(mockedUpdateUserProfile).toHaveBeenCalledWith({
      enableDailyReminder: true,
      notificationTime: '20:00',
    });
  });

  it('requires a signed-in user and creates nothing without one', async () => {
    mockedSupabase.auth.getUser.mockResolvedValue({
      data: { user: null },
      error: null,
    } as never);

    const result = await commitOnboarding(buildDraft());

    expect(result.data).toBeNull();
    expect(result.error).not.toBeNull();
    expect(mockedCreateFamily).not.toHaveBeenCalled();
  });

  // Bug fix: fetchMyFamilyMemberships/fetchUserProfile both return
  // `{ data, error }`, and a transient network failure surfaces as
  // `data: null` -- indistinguishable from a genuine "no rows" result
  // unless `error` is checked. Silently reading that as "no existing
  // family" would make commitOnboarding create a *second* family for a
  // real returning owner (docs/features/onboarding.md decision 18), which
  // is worse than the error it replaces because nothing would surface it
  // happening. Both lookup failures must abort instead of guessing.
  describe('cannot tell whether an existing family exists (lookup failure, must never guess "none")', () => {
    it('aborts with a retryable error, and creates nothing, when the membership lookup itself fails', async () => {
      mockedFetchMyFamilyMemberships.mockResolvedValue({
        data: null,
        error: { message: 'Network request failed' },
      } as never);

      const result = await commitOnboarding(buildDraft());

      expect(result.data).toBeNull();
      expect(result.error?.message).toBe('Could not check your existing family. Please try again.');
      // No existingFamilyId either -- we genuinely don't know one exists,
      // so the caller must not route this like a confirmed returning owner.
      expect(result.existingFamilyId).toBeUndefined();

      expect(mockedCreateFamily).not.toHaveBeenCalled();
      expect(mockedCreateFamilyMember).not.toHaveBeenCalled();
      expect(mockedCreateMemory).not.toHaveBeenCalled();
      expect(mockedPatchOnboardingDraft).not.toHaveBeenCalled();
    });

    it('aborts with a retryable error, and creates nothing, when membership rows exist but the profile lookup (picking which is active) fails', async () => {
      mockedFetchMyFamilyMemberships.mockResolvedValue({
        data: [
          {
            id: 'membership-1',
            family_id: 'family-existing',
            role: 'owner',
            family: { id: 'family-existing', name: 'The Riveras', illustration_style: 'default', deleted_at: null },
          },
        ],
        error: null,
      } as never);
      mockedFetchUserProfile.mockResolvedValue({
        data: null,
        error: { message: 'Network request failed' },
      });

      const result = await commitOnboarding(buildDraft());

      expect(result.data).toBeNull();
      expect(result.error?.message).toBe('Could not check your existing family. Please try again.');
      expect(result.existingFamilyId).toBeUndefined();

      // Not just "no second family" -- no write of any kind, since we
      // don't actually know an existing family was confirmed.
      expect(mockedCreateFamily).not.toHaveBeenCalled();
      expect(mockedCreateFamilyMember).not.toHaveBeenCalled();
      expect(mockedCreateMemory).not.toHaveBeenCalled();
      expect(mockedPatchOnboardingDraft).not.toHaveBeenCalled();
    });
  });

  describe('returning owner who already has a family (docs/features/onboarding.md decision 18)', () => {
    it('saves the captured memory into the existing family instead of creating a second one', async () => {
      mockedFetchMyFamilyMemberships.mockResolvedValue({
        data: [
          {
            id: 'membership-1',
            family_id: 'family-existing',
            role: 'owner',
            family: { id: 'family-existing', name: 'The Riveras', illustration_style: 'default', deleted_at: null },
          },
        ],
        error: null,
      } as never);
      mockedFetchUserProfile.mockResolvedValue({
        data: { active_family_id: 'family-existing' } as never,
        error: null,
      });
      mockedFetchFamilyMembers.mockResolvedValue({
        data: [{ id: 'member-real-lila', name: 'Lila' } as never],
        error: null,
      });
      mockedCreateMemory.mockResolvedValue({ data: { id: 'memory-existing-1' } as never, error: null });

      const result = await commitOnboarding(buildDraft());

      expect(result.error).toBeNull();
      expect(result.data).toEqual({
        familyId: 'family-existing',
        memoryId: 'memory-existing-1',
        isNewFamily: false,
        pendingMediaUpload: null,
      });
      expect(mockedCreateFamily).not.toHaveBeenCalled();
      expect(mockedCreateFamilyMember).not.toHaveBeenCalled();
      expect(mockedCreateMemory).toHaveBeenCalledWith(
        expect.objectContaining({
          familyId: 'family-existing',
          taggedMemberIds: ['member-real-lila'],
        }),
      );
      expect(mockedPatchOnboardingDraft).toHaveBeenCalledWith({ committedFamilyId: 'family-existing' });
    });

    it('leaves the memory untagged when no typed kid name matches the existing roster', async () => {
      mockedFetchMyFamilyMemberships.mockResolvedValue({
        data: [
          {
            id: 'membership-1',
            family_id: 'family-existing',
            role: 'owner',
            family: { id: 'family-existing', name: 'The Riveras', illustration_style: 'default', deleted_at: null },
          },
        ],
        error: null,
      } as never);
      mockedFetchUserProfile.mockResolvedValue({ data: { active_family_id: null } as never, error: null });
      mockedFetchFamilyMembers.mockResolvedValue({
        data: [{ id: 'member-real-someone-else', name: 'Noa' } as never],
        error: null,
      });
      mockedCreateMemory.mockResolvedValue({ data: { id: 'memory-existing-2' } as never, error: null });

      await commitOnboarding(buildDraft());

      expect(mockedCreateMemory).toHaveBeenCalledWith(expect.objectContaining({ taggedMemberIds: [] }));
    });

    // Bug fix (docs/features/onboarding.md decision 18): a failure in this
    // branch happens *after* commitOnboarding has already confirmed the
    // signed-in user owns this real family -- the caller (code.tsx) must be
    // told that, so it can route the user into their journal instead of a
    // dead-end "must be signed in" error + retry loop. This is a regression
    // test at the service layer for the fix; see
    // onboarding.code.integration.test.tsx for the screen-level assertion
    // that code.tsx actually acts on it.
    it('returns existingFamilyId when saving the memory into the existing family fails, so the caller never treats this like a brand-new owner', async () => {
      mockedFetchMyFamilyMemberships.mockResolvedValue({
        data: [
          {
            id: 'membership-1',
            family_id: 'family-existing',
            role: 'owner',
            family: { id: 'family-existing', name: 'The Riveras', illustration_style: 'default', deleted_at: null },
          },
        ],
        error: null,
      } as never);
      mockedFetchUserProfile.mockResolvedValue({
        data: { active_family_id: 'family-existing' } as never,
        error: null,
      });
      mockedFetchFamilyMembers.mockResolvedValue({
        data: [{ id: 'member-real-lila', name: 'Lila' } as never],
        error: null,
      });
      mockedCreateMemory.mockResolvedValue({
        data: null,
        error: { message: 'Network request failed' },
      });

      const result = await commitOnboarding(buildDraft());

      expect(result.data).toBeNull();
      expect(result.error?.message).toBe('Network request failed');
      expect(result.existingFamilyId).toBe('family-existing');
      // Never marked committed -- a retry (or the caller's graceful
      // fallback) must not skip re-attempting the memory.
      expect(mockedPatchOnboardingDraft).not.toHaveBeenCalled();
    });

    it('never resolves a soft-deleted family as "existing"', async () => {
      mockedFetchMyFamilyMemberships.mockResolvedValue({
        data: [
          {
            id: 'membership-1',
            family_id: 'family-deleted',
            role: 'owner',
            family: { id: 'family-deleted', name: 'Old', illustration_style: 'default', deleted_at: '2026-01-01' },
          },
        ],
        error: null,
      } as never);
      mockedCreateFamily.mockResolvedValue({ data: { id: 'family-new' } as never, error: null });
      mockedCreateFamilyMember
        .mockResolvedValueOnce({ data: { id: 'member-lila' } as never, error: null })
        .mockResolvedValueOnce({ data: { id: 'member-miguel' } as never, error: null });
      mockedCreateMemory.mockResolvedValue({ data: { id: 'memory-1' } as never, error: null });

      const result = await commitOnboarding(buildDraft());

      expect(mockedCreateFamily).toHaveBeenCalled();
      expect(result.data?.isNewFamily).toBe(true);
      expect(result.data?.familyId).toBe('family-new');
    });
  });
});

describe('notificationSettingsForChoice', () => {
  it('maps each choice to its reminder time, and no choice / none to reminders off', () => {
    expect(notificationSettingsForChoice('eve')).toEqual({ enableDailyReminder: true, notificationTime: '20:00' });
    expect(notificationSettingsForChoice('late')).toEqual({ enableDailyReminder: true, notificationTime: '22:00' });
    expect(notificationSettingsForChoice('morn')).toEqual({ enableDailyReminder: true, notificationTime: '08:00' });
    expect(notificationSettingsForChoice('none')).toEqual({ enableDailyReminder: false, notificationTime: null });
    expect(notificationSettingsForChoice(null)).toEqual({ enableDailyReminder: false, notificationTime: null });
  });
});
