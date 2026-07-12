import { canEditFamilyContent, canManageMember, isOwnerRole, isViewerRole, roleLabel } from '@/utils/roles';

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

describe('roleLabel', () => {
  it('labels each known role', () => {
    expect(roleLabel('owner')).toBe('Owner');
    expect(roleLabel('manager')).toBe('Manager');
    expect(roleLabel('viewer')).toBe('Viewer');
  });

  it('labels unknown/null/undefined as a former member', () => {
    expect(roleLabel(null)).toBe('Former member');
    expect(roleLabel(undefined)).toBe('Former member');
    expect(roleLabel('something-else')).toBe('Former member');
  });
});

describe('canManageMember', () => {
  const viewerMember = { user_id: 'user-2', role: 'viewer', is_active_member: true };
  const managerMember = { user_id: 'user-3', role: 'manager', is_active_member: true };
  const ownerMember = { user_id: 'user-owner', role: 'owner', is_active_member: true };
  const formerMember = { user_id: 'user-4', role: null, is_active_member: false };

  it('lets an owner manage a non-owner, non-self member', () => {
    expect(canManageMember('owner', 'user-1', viewerMember)).toBe(true);
    expect(canManageMember('owner', 'user-1', managerMember)).toBe(true);
  });

  it('lets a manager manage a non-owner, non-self member', () => {
    expect(canManageMember('manager', 'user-1', viewerMember)).toBe(true);
    expect(canManageMember('manager', 'user-1', managerMember)).toBe(true);
  });

  it('never allows acting on the owner row', () => {
    expect(canManageMember('owner', 'user-1', ownerMember)).toBe(false);
    expect(canManageMember('manager', 'user-1', ownerMember)).toBe(false);
  });

  it('never allows acting on your own row', () => {
    expect(canManageMember('owner', 'user-2', viewerMember)).toBe(false);
    expect(canManageMember('manager', 'user-3', managerMember)).toBe(false);
  });

  it('never allows a viewer to manage anyone', () => {
    expect(canManageMember('viewer', 'user-1', viewerMember)).toBe(false);
    expect(canManageMember('viewer', 'user-1', managerMember)).toBe(false);
  });

  it('never allows acting on an already-former member', () => {
    expect(canManageMember('owner', 'user-1', formerMember)).toBe(false);
  });
});
