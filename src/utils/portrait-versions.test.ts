import {
  extractPortraitReferenceDateIso,
  isPortraitGenerationStalled,
  PORTRAIT_GENERATION_STALE_MS,
  resolveMemberPortraitFields,
  resolvePortraitVersion,
  validatePortraitReferenceDate,
  type FamilyMemberPortraitVersion,
} from '@/utils/portrait-versions';

function version(
  id: string,
  referenceDate: string | null,
  overrides: Partial<FamilyMemberPortraitVersion> = {},
): FamilyMemberPortraitVersion {
  return {
    id,
    family_id: 'family-1',
    family_member_id: 'member-1',
    user_id: 'user-1',
    reference_date: referenceDate,
    date_source: referenceDate ? 'manual' : 'legacy_unknown',
    profile_picture_key: `user-1/family/member-1/portraits/${id}/photo.jpg`,
    illustrated_profile_key: `user-1/family/member-1/portraits/${id}/portrait/attempt.webp`,
    illustrated_profile_status: 'ready',
    generation_token: null,
    generation_started_at: null,
    generation_output_key: null,
    deletion_token: null,
    deletion_started_at: null,
    created_at: `2026-01-0${id.length}T00:00:00Z`,
    updated_at: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

describe('portrait generation recovery', () => {
  const nowMs = Date.parse('2026-07-15T22:30:00Z');
  const staleStartedAt = new Date(nowMs - PORTRAIT_GENERATION_STALE_MS - 1).toISOString();

  it('treats an abandoned claim as stalled once the server reclaim window passes', () => {
    expect(isPortraitGenerationStalled(version('claimed', '2026-01-01', {
      generation_token: 'attempt-1',
      generation_started_at: staleStartedAt,
    }), nowMs)).toBe(true);
  });

  it('treats a pending version that never acquired a claim as stalled', () => {
    expect(isPortraitGenerationStalled(version('pending', '2026-01-01', {
      illustrated_profile_key: null,
      illustrated_profile_status: 'pending',
      updated_at: staleStartedAt,
    }), nowMs)).toBe(true);
  });

  it('keeps fresh work and completed unclaimed portraits out of recovery', () => {
    expect(isPortraitGenerationStalled(version('fresh', '2026-01-01', {
      generation_token: 'attempt-2',
      generation_started_at: new Date(nowMs - 60_000).toISOString(),
    }), nowMs)).toBe(false);
    expect(isPortraitGenerationStalled(version('ready', '2026-01-01'), nowMs)).toBe(false);
  });
});

describe('portrait version resolver', () => {
  it('selects the latest usable portrait on or before the memory date', () => {
    expect(
      resolvePortraitVersion(
        [version('jan', '2026-01-01'), version('jun', '2026-06-01')],
        '2026-05-30',
      )?.id,
    ).toBe('jan');
  });

  it('selects the earliest dated portrait after the target before legacy unknown', () => {
    expect(
      resolvePortraitVersion(
        [version('legacy', null), version('jun', '2026-06-01'), version('mar', '2026-03-01')],
        '2025-12-01',
      )?.id,
    ).toBe('mar');
  });

  it('uses legacy unknown only when no usable dated portrait exists', () => {
    expect(resolvePortraitVersion([version('legacy', null)], '2020-01-01')?.id).toBe('legacy');
  });

  it('excludes failed, pending, and deleting portraits', () => {
    expect(
      resolvePortraitVersion(
        [
          version('failed', '2026-05-01', { illustrated_profile_status: 'failed' }),
          version('pending', '2026-04-01', {
            illustrated_profile_key: null,
            illustrated_profile_status: 'pending',
          }),
          version('deleting', '2026-03-01', { deletion_token: 'delete-1' }),
          version('ready', '2026-01-01'),
        ],
        '2026-06-01',
      )?.id,
    ).toBe('ready');
  });

  it('uses newest creation then id as deterministic same-day tie breakers', () => {
    const older = version('z', '2026-01-01', { created_at: '2026-02-01T00:00:00Z' });
    const newerA = version('a', '2026-01-01', { created_at: '2026-03-01T00:00:00Z' });
    const newerB = version('b', '2026-01-01', { created_at: '2026-03-01T00:00:00Z' });
    expect(resolvePortraitVersion([older, newerA, newerB], '2026-01-01')?.id).toBe('b');
  });

  it('keeps ready artwork usable while regeneration has an active token', () => {
    expect(
      resolvePortraitVersion(
        [version('ready', '2026-01-01', { generation_token: 'attempt-2' })],
        '2026-02-01',
      )?.id,
    ).toBe('ready');
  });

  it('uses the immutable image key as avatar cache identity across date-only edits', () => {
    const before = version('ready', '2026-01-01', {
      updated_at: '2026-01-01T00:00:00Z',
    });
    const after = { ...before, reference_date: '2026-02-01', updated_at: '2026-03-01T00:00:00Z' };

    expect(resolveMemberPortraitFields([before], '2026-04-01', 'member-time').avatarUpdatedAt)
      .toBe(before.illustrated_profile_key);
    expect(resolveMemberPortraitFields([after], '2026-04-01', 'member-time').avatarUpdatedAt)
      .toBe(before.illustrated_profile_key);
  });
});

describe('portrait reference dates', () => {
  it('trusts original then digitized EXIF and rejects DateTime-only metadata', () => {
    expect(
      extractPortraitReferenceDateIso(
        {
          DateTimeOriginal: 'bad',
          DateTimeDigitized: '2024:02:29 10:11:12',
          DateTime: '2020:01:01 00:00:00',
        },
        '2026-01-01',
      ),
    ).toBe('2024-02-29');
    expect(
      extractPortraitReferenceDateIso({ DateTime: '2020:01:01 00:00:00' }, '2026-01-01'),
    ).toBeNull();
  });

  it('strictly rejects invalid and future EXIF dates with no +1 day tolerance', () => {
    expect(
      extractPortraitReferenceDateIso({ DateTimeOriginal: '2026:01:02 00:00:00' }, '2026-01-01'),
    ).toBeNull();
    expect(
      extractPortraitReferenceDateIso({ DateTimeOriginal: '2025:02:29 00:00:00' }, '2026-01-01'),
    ).toBeNull();
  });

  it('validates the date against local today and date of birth', () => {
    expect(
      validatePortraitReferenceDate('2020-01-01', {
        dateOfBirth: '2021-01-01',
        todayIso: '2026-01-01',
      }),
    ).toMatch(/before date of birth/);
    expect(
      validatePortraitReferenceDate('2026-01-02', {
        dateOfBirth: '2021-01-01',
        todayIso: '2026-01-01',
      }),
    ).toMatch(/future/);
    expect(
      validatePortraitReferenceDate('2024-02-29', {
        dateOfBirth: '2021-01-01',
        todayIso: '2026-01-01',
      }),
    ).toBeNull();
  });
});
