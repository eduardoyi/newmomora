import {
  formatAgeCompactFromDob,
  formatAgeFromDob,
  getMemberAvatarImageKey,
  getProfilePortraitPhotoKey,
  isPortraitInProgress,
  validateDateOfBirth,
  validateFamilyMemberName,
} from '@/utils/family-members';

describe('validateFamilyMemberName', () => {
  it('requires a non-empty name', () => {
    expect(validateFamilyMemberName('   ')).toBe('Name is required');
  });

  it('accepts trimmed names', () => {
    expect(validateFamilyMemberName('Maya')).toBeNull();
  });
});

describe('validateDateOfBirth', () => {
  it('requires YYYY-MM-DD format', () => {
    expect(validateDateOfBirth('05/24/2020')).toBe('Use YYYY-MM-DD format');
  });

  it('rejects future dates', () => {
    expect(validateDateOfBirth('2099-01-01')).toBe('Date of birth cannot be in the future');
  });

  it('accepts valid past dates', () => {
    expect(validateDateOfBirth('2020-05-24')).toBeNull();
  });
});

describe('formatAgeFromDob', () => {
  it('formats years and months under the years-only threshold', () => {
    expect(formatAgeFromDob('2020-01-15', new Date('2023-03-10T12:00:00'))).toBe(
      '3 years, 1 month',
    );
  });

  it('shows years only at or above the years-only threshold', () => {
    expect(formatAgeFromDob('1989-06-24', new Date('2026-05-27T12:00:00'))).toBe('36 years');
    expect(formatAgeFromDob('2020-06-01', new Date('2025-06-15T12:00:00'))).toBe('5 years');
  });

  it('handles infants under one year', () => {
    expect(formatAgeFromDob('2024-11-01', new Date('2025-02-01T12:00:00'))).toBe('3 months');
  });
});

describe('formatAgeCompactFromDob', () => {
  it('formats compact years and months under the years-only threshold', () => {
    expect(formatAgeCompactFromDob('2020-01-15', new Date('2023-03-10T12:00:00'))).toBe('3y 1m');
  });

  it('shows compact years only at or above the years-only threshold', () => {
    expect(formatAgeCompactFromDob('1989-06-24', new Date('2026-05-27T12:00:00'))).toBe('36y');
    expect(formatAgeCompactFromDob('2020-06-01', new Date('2025-06-15T12:00:00'))).toBe('5y');
  });
});

describe('getMemberAvatarImageKey', () => {
  it('prefers illustrated portrait over profile photo when ready', () => {
    expect(
      getMemberAvatarImageKey({
        illustrated_profile_key: 'user/family/mara/portrait.webp',
        illustrated_profile_status: 'ready',
        profile_picture_key: 'user/family/mara/photo.jpg',
      }),
    ).toBe('user/family/mara/portrait.webp');
  });

  it('uses profile photo while portrait is generating', () => {
    expect(
      getMemberAvatarImageKey({
        illustrated_profile_key: 'user/family/mara/portrait.webp',
        illustrated_profile_status: 'generating',
        profile_picture_key: 'user/family/mara/photo.jpg',
      }),
    ).toBe('user/family/mara/photo.jpg');
  });

  it('falls back to profile photo when portrait is missing', () => {
    expect(
      getMemberAvatarImageKey({
        illustrated_profile_key: null,
        illustrated_profile_status: 'ready',
        profile_picture_key: 'user/family/enzo/photo.jpg',
      }),
    ).toBe('user/family/enzo/photo.jpg');
  });

  it('returns null when no image keys exist', () => {
    expect(
      getMemberAvatarImageKey({
        illustrated_profile_key: null,
        illustrated_profile_status: 'ready',
        profile_picture_key: null,
      }),
    ).toBeNull();
  });
});

describe('portrait generation helpers', () => {
  it('detects in-progress portrait statuses', () => {
    expect(isPortraitInProgress('pending')).toBe(true);
    expect(isPortraitInProgress('generating')).toBe(true);
    expect(isPortraitInProgress('ready')).toBe(false);
  });

  it('uses profile photo as source while portrait is generating', () => {
    expect(
      getProfilePortraitPhotoKey({
        illustrated_profile_key: 'user/family/mara/portrait.webp',
        illustrated_profile_status: 'generating',
        profile_picture_key: 'user/family/mara/photo.jpg',
      }),
    ).toBe('user/family/mara/photo.jpg');
  });

  it('uses illustrated portrait when ready', () => {
    expect(
      getProfilePortraitPhotoKey({
        illustrated_profile_key: 'user/family/mara/portrait.webp',
        illustrated_profile_status: 'ready',
        profile_picture_key: 'user/family/mara/photo.jpg',
      }),
    ).toBe('user/family/mara/portrait.webp');
  });
});
