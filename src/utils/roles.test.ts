import { canEditFamilyContent, isOwnerRole, isViewerRole } from '@/utils/roles';

describe('canEditFamilyContent', () => {
  it('allows owner and manager', () => {
    expect(canEditFamilyContent('owner')).toBe(true);
    expect(canEditFamilyContent('manager')).toBe(true);
  });

  it('disallows viewer, unknown, null, and undefined', () => {
    expect(canEditFamilyContent('viewer')).toBe(false);
    expect(canEditFamilyContent('something-else')).toBe(false);
    expect(canEditFamilyContent(null)).toBe(false);
    expect(canEditFamilyContent(undefined)).toBe(false);
  });
});

describe('isViewerRole', () => {
  it('is true only for viewer', () => {
    expect(isViewerRole('viewer')).toBe(true);
    expect(isViewerRole('manager')).toBe(false);
    expect(isViewerRole('owner')).toBe(false);
    expect(isViewerRole(null)).toBe(false);
    expect(isViewerRole(undefined)).toBe(false);
  });
});

describe('isOwnerRole', () => {
  it('is true only for owner', () => {
    expect(isOwnerRole('owner')).toBe(true);
    expect(isOwnerRole('manager')).toBe(false);
    expect(isOwnerRole('viewer')).toBe(false);
    expect(isOwnerRole(null)).toBe(false);
    expect(isOwnerRole(undefined)).toBe(false);
  });
});
