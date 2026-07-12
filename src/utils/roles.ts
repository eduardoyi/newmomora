// Family-role gating helpers (docs/plans/family-sharing.md §2, §8). Roles are
// stored as free-form `text` in the DB (`family_memberships.role`), so these
// helpers treat unknown/undefined roles as the most restrictive case rather
// than assuming shape.

export type FamilyRole = 'owner' | 'manager' | 'viewer';

/** Owner and manager can create/edit/delete family content (memories, children, family settings). */
export function canEditFamilyContent(role: string | null | undefined): boolean {
  return role === 'owner' || role === 'manager';
}

export function isViewerRole(role: string | null | undefined): boolean {
  return role === 'viewer';
}

/** Only the owner may rename/delete the family or manage its lifecycle. */
export function isOwnerRole(role: string | null | undefined): boolean {
  return role === 'owner';
}

/** Human-readable label for a family_memberships role; unknown/null reads as "Former member" (a removed member whose content survives them). */
export function roleLabel(role: string | null | undefined): string {
  if (role === 'owner') return 'Owner';
  if (role === 'manager') return 'Manager';
  if (role === 'viewer') return 'Viewer';
  return 'Former member';
}

export interface ManageableMember {
  user_id: string;
  role: string | null;
  is_active_member: boolean;
}

/**
 * Whether the signed-in user (their own role + id) may promote, demote, or
 * remove `member` from the Settings member list. Mirrors the
 * `family_memberships` RLS (manager+ may act on any non-owner member, never
 * on the owner's own row or the actor's own row -- self-service goes through
 * the separate "Leave family" flow). See docs/features/family-sharing.md's
 * roles table for the authoritative permission matrix.
 */
export function canManageMember(
  actorRole: string | null | undefined,
  actorUserId: string | null | undefined,
  member: ManageableMember,
): boolean {
  return (
    canEditFamilyContent(actorRole) &&
    member.is_active_member &&
    member.role !== 'owner' &&
    member.user_id !== actorUserId
  );
}
