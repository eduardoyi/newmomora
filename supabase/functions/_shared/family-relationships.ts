// Family relationships (docs/features/family-relationships.md): who each
// person is to the kids, and which side of the family they're on. Mirrors the
// check constraints in 20260928120000_family_relationships.sql; the app keeps
// the same list in src/utils/family-relationships.ts (parity-tested).
import { getAgeInYearsAtDate } from './age.ts';
import { classifyChildOrAdult } from './date-context.ts';

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

/** Roles that carry a family side ("Eduardo's side"). */
export const SIDE_ROLES = ['grandparent', 'great_grandparent', 'aunt_uncle', 'cousin'] as const;

export const FAMILY_SIDES = ['maternal', 'paternal', 'both'] as const;

export type FamilySide = (typeof FAMILY_SIDES)[number];

export function isRelationship(value: unknown): value is Relationship {
  return typeof value === 'string' && (RELATIONSHIPS as readonly string[]).includes(value);
}

export function isSideRole(value: unknown): boolean {
  return typeof value === 'string' && (SIDE_ROLES as readonly string[]).includes(value);
}

export function isFamilySide(value: unknown): value is FamilySide {
  return typeof value === 'string' && (FAMILY_SIDES as readonly string[]).includes(value);
}

export interface RelationshipMember {
  relationship?: string | null;
  dateOfBirth: string | null;
}

/**
 * Own-child rule, per member (plan §3): an explicit role wins -- 'child' is a
 * child, any other role is not; an unsorted member (null) falls back to the
 * DOB < 13 rule, so families that never sort anyone behave as before.
 */
export function isOwnChild(member: RelationshipMember, today: string): boolean {
  if (member.relationship === 'child') return true;
  if (member.relationship) return false;
  if (!member.dateOfBirth) return false;
  return classifyChildOrAdult(getAgeInYearsAtDate(member.dateOfBirth, today)) === 'child';
}

export interface SideLabelMember {
  id: string;
  name: string;
  relationship?: string | null;
  family_side?: string | null;
  side_member_id?: string | null;
}

/**
 * "Eduardo's side" when the side points at a member who is still a parent,
 * else "Mom's side" / "Dad's side" / "Both sides", else null.
 */
export function sideLabel(member: SideLabelMember, members: SideLabelMember[]): string | null {
  if (!isSideRole(member.relationship)) return null;
  if (member.side_member_id) {
    const parent = members.find((m) => m.id === member.side_member_id);
    if (!parent || parent.relationship !== 'parent') return null;
    const first = parent.name.trim().split(/\s+/)[0] || parent.name;
    return `${first}'s side`;
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
