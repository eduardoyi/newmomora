// Family relationships, app side (docs/features/family-relationships.md).
// Mirrors supabase/functions/_shared/family-relationships.ts and the check
// constraints in 20260928120000_family_relationships.sql -- the value lists
// are parity-tested (family-relationships.test.ts).
import { getAgePartsFromDob } from '@/utils/family-members';

export const RELATIONSHIPS = [
  'child',
  'parent',
  'grandparent',
  'great_grandparent',
  'aunt_uncle',
  'cousin',
  'family_friend',
  'caregiver',
  'pet',
  'other',
] as const;

export type Relationship = (typeof RELATIONSHIPS)[number];

export const SIDE_ROLES: readonly Relationship[] = ['grandparent', 'great_grandparent', 'aunt_uncle', 'cousin'];

export const FAMILY_SIDES = ['maternal', 'paternal', 'both'] as const;
export type FamilySide = (typeof FAMILY_SIDES)[number];

export const RELATIONSHIP_LABELS: Record<Relationship, string> = {
  child: 'Our child',
  parent: 'Parent',
  grandparent: 'Grandparent',
  great_grandparent: 'Great-grandparent',
  aunt_uncle: 'Aunt/Uncle',
  cousin: 'Cousin',
  family_friend: 'Family friend',
  caregiver: 'Caregiver',
  pet: 'Pet',
  other: 'Other',
};

export function isRelationship(value: unknown): value is Relationship {
  return typeof value === 'string' && (RELATIONSHIPS as readonly string[]).includes(value);
}

export function isSideRole(value: unknown): boolean {
  return typeof value === 'string' && (SIDE_ROLES as readonly string[]).includes(value);
}

export function relationshipLabel(value: string | null | undefined): string | null {
  return isRelationship(value) ? RELATIONSHIP_LABELS[value] : null;
}

export interface RelationshipMemberLike {
  id: string;
  name: string;
  relationship?: string | null;
  family_side?: string | null;
  side_member_id?: string | null;
  date_of_birth?: string | null;
}

function firstName(name: string): string {
  return name.trim().split(/\s+/)[0] || name;
}

/** "Eduardo's side" while the side member is still a parent; "Mom's side" /
 * "Dad's side" / "Both sides" for generic sides; null otherwise. */
export function sideLabel(member: RelationshipMemberLike, members: RelationshipMemberLike[]): string | null {
  if (!isSideRole(member.relationship)) return null;
  if (member.side_member_id) {
    const parent = members.find((m) => m.id === member.side_member_id);
    return parent && parent.relationship === 'parent' ? `${firstName(parent.name)}'s side` : null;
  }
  switch (member.family_side) {
    case 'maternal':
      return "Mom's side";
    case 'paternal':
      return "Dad's side";
    case 'both':
      return 'Both sides';
    default:
      return null;
  }
}

/** "Grandparent · Eduardo's side", "Our child", or null when unsorted. */
export function relationshipSubtitle(member: RelationshipMemberLike, members: RelationshipMemberLike[]): string | null {
  const label = relationshipLabel(member.relationship);
  if (!label) return null;
  const side = sideLabel(member, members);
  return side ? `${label} · ${side}` : label;
}

export interface SideChoice {
  key: string;
  label: string;
  familySide: FamilySide | null;
  sideMemberId: string | null;
}

/** "Whose side?" chips: each marked parent's name + Both when any parent is
 * marked, else Mom's / Dad's / Both. */
export function sideChoices(members: RelationshipMemberLike[], excludeMemberId?: string): SideChoice[] {
  const parents = members.filter((m) => m.relationship === 'parent' && m.id !== excludeMemberId);
  if (parents.length > 0) {
    return [
      ...parents.map((p) => ({
        key: `member:${p.id}`,
        label: `${firstName(p.name)}'s side`,
        familySide: null,
        sideMemberId: p.id,
      })),
      { key: 'both', label: 'Both', familySide: 'both' as const, sideMemberId: null },
    ];
  }
  return [
    { key: 'maternal', label: "Mom's side", familySide: 'maternal', sideMemberId: null },
    { key: 'paternal', label: "Dad's side", familySide: 'paternal', sideMemberId: null },
    { key: 'both', label: 'Both', familySide: 'both', sideMemberId: null },
  ];
}

export function sideKeyOf(member: { family_side?: string | null; side_member_id?: string | null }): string | null {
  if (member.side_member_id) return `member:${member.side_member_id}`;
  return member.family_side ?? null;
}

/** Can an account say "this is me" about this person? Same rule as the
 * set_my_family_member RPC: not a kid or pet, and not unsorted-and-under-13. */
export function isLinkableMember(member: RelationshipMemberLike, referenceDate = new Date()): boolean {
  if (member.relationship === 'child' || member.relationship === 'pet') return false;
  if (!member.relationship && member.date_of_birth) {
    const age = getAgePartsFromDob(member.date_of_birth, referenceDate);
    if (age && age.years < 13) return false;
  }
  return true;
}

/**
 * Own-child rule (mirrors `isOwnChild` in
 * supabase/functions/_shared/family-relationships.ts): an explicit role wins
 * -- 'child' is a child, any other role is not; an unsorted member falls back
 * to DOB < 13, so families that never sort anyone behave as before. Keepsakes
 * uses it to pick whose book shelves to show.
 */
export function isOwnChild(
  member: { relationship?: string | null; date_of_birth?: string | null },
  referenceDate = new Date(),
): boolean {
  if (member.relationship === 'child') return true;
  if (member.relationship) return false;
  if (!member.date_of_birth) return false;
  const age = getAgePartsFromDob(member.date_of_birth, referenceDate);
  return age !== null && age.years < 13;
}

export interface RelationshipGroup<T> {
  key: string;
  title: string;
  members: T[];
}

const GROUPS: { key: string; title: string; roles: (Relationship | null)[] }[] = [
  { key: 'kids', title: 'Our kids', roles: ['child'] },
  { key: 'parents', title: 'Parents', roles: ['parent'] },
  { key: 'grandparents', title: 'Grandparents', roles: ['grandparent'] },
  { key: 'great-grandparents', title: 'Great-grandparents', roles: ['great_grandparent'] },
  { key: 'aunts-uncles', title: 'Aunts & uncles', roles: ['aunt_uncle'] },
  { key: 'cousins', title: 'Cousins', roles: ['cousin'] },
  { key: 'friends', title: 'Friends & caregivers', roles: ['family_friend', 'caregiver'] },
  { key: 'pets', title: 'Pets', roles: ['pet'] },
  { key: 'other', title: 'Other', roles: ['other'] },
  { key: 'unsorted', title: 'Not sorted yet', roles: [null] },
];

/** Family tab sections, in a fixed order; empty groups are dropped and the
 * input order is kept inside each group. */
export function groupByRelationship<T extends { relationship?: string | null }>(members: T[]): RelationshipGroup<T>[] {
  return GROUPS.map((group) => ({
    key: group.key,
    title: group.title,
    members: members.filter((m) =>
      group.roles.includes(isRelationship(m.relationship) ? m.relationship : null),
    ),
  })).filter((group) => group.members.length > 0);
}
