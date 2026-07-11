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
