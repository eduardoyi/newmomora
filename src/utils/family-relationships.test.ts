import { readFileSync } from 'fs';
import { join } from 'path';

import {
  FAMILY_SIDES,
  groupByRelationship,
  isInviteTargetEligible,
  isLinkableMember,
  isOnboardingKid,
  isOwnChild,
  RELATIONSHIP_LABELS,
  RELATIONSHIPS,
  relationshipSubtitle,
  sideChoices,
  sideKeyOf,
  sideLabel,
  SIDE_ROLES,
} from './family-relationships';

describe('family relationships parity', () => {
  const shared = readFileSync(
    join(__dirname, '../../supabase/functions/_shared/family-relationships.ts'),
    'utf8',
  );
  const migration = readFileSync(
    join(__dirname, '../../supabase/migrations/20260928120000_family_relationships.sql'),
    'utf8',
  );

  function quotedList(source: string, anchor: string): string[] {
    const start = source.indexOf(anchor);
    const end = source.indexOf(']', start);
    return [...source.slice(start, end).matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
  }

  it('matches the Edge shared lists', () => {
    expect(quotedList(shared, 'export const RELATIONSHIPS')).toEqual([...RELATIONSHIPS]);
    expect(quotedList(shared, 'export const SIDE_ROLES')).toEqual([...SIDE_ROLES]);
    expect(quotedList(shared, 'export const FAMILY_SIDES')).toEqual([...FAMILY_SIDES]);
  });

  it('matches the database check constraint', () => {
    const start = migration.indexOf('family_members_relationship_check');
    const end = migration.indexOf(')),', start);
    const values = [...migration.slice(start, end).matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
    expect(values).toEqual([...RELATIONSHIPS]);
  });

  it('labels every role', () => {
    expect(Object.keys(RELATIONSHIP_LABELS).sort()).toEqual([...RELATIONSHIPS].sort());
  });
});

const dad = { id: 'dad', name: 'Eduardo Yi', relationship: 'parent' };
const mom = { id: 'mom', name: 'Adriana', relationship: 'parent' };

describe('sideLabel / relationshipSubtitle', () => {
  it('uses the parent name while they are still a parent', () => {
    const grandma = { id: 'g', name: 'Mirian', relationship: 'grandparent', side_member_id: 'dad' };
    expect(sideLabel(grandma, [dad, grandma])).toBe("Eduardo's side");
    expect(relationshipSubtitle(grandma, [dad, grandma])).toBe("Grandparent · Eduardo's side");
    expect(relationshipSubtitle(grandma, [{ ...dad, relationship: 'other' }, grandma])).toBe('Grandparent');
  });

  it('falls back to generic sides and hides sides on non-side roles', () => {
    expect(sideLabel({ id: 'a', name: 'Ana', relationship: 'aunt_uncle', family_side: 'maternal' }, [])).toBe("Mom's side");
    expect(sideLabel({ id: 'a', name: 'Ana', relationship: 'cousin', family_side: 'both' }, [])).toBe('Both sides');
    expect(sideLabel({ id: 'f', name: 'Jo', relationship: 'caregiver', family_side: 'both' }, [])).toBeNull();
    expect(relationshipSubtitle({ id: 'k', name: 'Tomás', relationship: 'child' }, [])).toBe('Our child');
    expect(relationshipSubtitle({ id: 'u', name: 'Unsorted', relationship: null }, [])).toBeNull();
  });
});

describe('sideChoices', () => {
  it('offers parents by name plus Both when parents are marked', () => {
    expect(sideChoices([dad, mom, { id: 'g', name: 'Mirian', relationship: 'grandparent' }]).map((c) => c.label)).toEqual([
      "Eduardo's side",
      "Adriana's side",
      'Both',
    ]);
    const choice = sideChoices([dad])[0];
    expect(choice).toEqual({ key: 'member:dad', label: "Eduardo's side", familySide: null, sideMemberId: 'dad' });
  });

  it("offers Mom's / Dad's / Both otherwise", () => {
    expect(sideChoices([]).map((c) => c.key)).toEqual(['maternal', 'paternal', 'both']);
  });

  it('never offers a person as their own side', () => {
    expect(sideChoices([dad], 'dad').map((c) => c.key)).toEqual(['maternal', 'paternal', 'both']);
  });

  it('round-trips the side key', () => {
    expect(sideKeyOf({ side_member_id: 'dad' })).toBe('member:dad');
    expect(sideKeyOf({ family_side: 'paternal' })).toBe('paternal');
    expect(sideKeyOf({})).toBeNull();
  });
});

describe('isLinkableMember', () => {
  const ref = new Date('2026-09-28T12:00:00');
  it('excludes kids, pets and unsorted under-13s', () => {
    expect(isLinkableMember({ id: '1', name: 'Tomás', relationship: 'child' }, ref)).toBe(false);
    expect(isLinkableMember({ id: '2', name: 'Rex', relationship: 'pet' }, ref)).toBe(false);
    expect(isLinkableMember({ id: '3', name: 'Lucía', date_of_birth: '2024-11-14' }, ref)).toBe(false);
  });

  it('allows adults, unsorted adults and unknown ages', () => {
    expect(isLinkableMember({ id: '4', name: 'Eduardo', relationship: 'parent' }, ref)).toBe(true);
    expect(isLinkableMember({ id: '5', name: 'Mirian', date_of_birth: '1960-01-01' }, ref)).toBe(true);
    expect(isLinkableMember({ id: '6', name: 'Someone', date_of_birth: null }, ref)).toBe(true);
  });
});

describe('groupByRelationship', () => {
  it('orders groups, keeps input order inside and drops empty groups', () => {
    const members = [
      { id: 'u1', relationship: null },
      { id: 'g1', relationship: 'grandparent' },
      { id: 'k1', relationship: 'child' },
      { id: 'f1', relationship: 'caregiver' },
      { id: 'k2', relationship: 'child' },
      { id: 'f2', relationship: 'family_friend' },
    ];
    const groups = groupByRelationship(members);
    expect(groups.map((g) => g.title)).toEqual(['Our kids', 'Grandparents', 'Friends & caregivers', 'Not sorted yet']);
    expect(groups[0].members.map((m) => m.id)).toEqual(['k1', 'k2']);
    expect(groups[2].members.map((m) => m.id)).toEqual(['f1', 'f2']);
  });
});

describe('isOwnChild (app mirror of the Edge rule)', () => {
  const today = new Date(2026, 8, 29);
  it('lets an explicit role win over age', () => {
    expect(isOwnChild({ relationship: 'child', date_of_birth: '1990-01-01' }, today)).toBe(true);
    expect(isOwnChild({ relationship: 'cousin', date_of_birth: '2022-01-01' }, today)).toBe(false);
    expect(isOwnChild({ relationship: 'child', date_of_birth: null }, today)).toBe(true);
  });

  it('falls back to under-13 for unsorted members', () => {
    expect(isOwnChild({ relationship: null, date_of_birth: '2022-01-01' }, today)).toBe(true);
    expect(isOwnChild({ relationship: null, date_of_birth: '2010-01-01' }, today)).toBe(false);
    expect(isOwnChild({ relationship: null, date_of_birth: null }, today)).toBe(false);
  });
});

describe('isInviteTargetEligible (invite picker, person detail, Approvals)', () => {
  const ref = new Date(2026, 8, 30);
  const grandma = { id: 'g1', name: 'Ana', relationship: 'grandparent' };

  it('accepts a linkable, unclaimed, visible person', () => {
    expect(isInviteTargetEligible(grandma, [], false, ref)).toBe(true);
    expect(isInviteTargetEligible(grandma, [{ familyMemberId: 'other' }, { familyMemberId: null }], false, ref)).toBe(true);
  });

  it('rejects children and pets', () => {
    expect(isInviteTargetEligible({ id: 'k', name: 'Tomás', relationship: 'child' }, [], false, ref)).toBe(false);
    expect(isInviteTargetEligible({ id: 'p', name: 'Rex', relationship: 'pet' }, [], false, ref)).toBe(false);
  });

  it('rejects an unsorted person under 13', () => {
    expect(isInviteTargetEligible({ id: 'u', name: 'Kid', relationship: null, date_of_birth: '2022-01-01' }, [], false, ref)).toBe(false);
  });

  it('rejects a person already linked to any account, including the caller\'s own', () => {
    expect(isInviteTargetEligible(grandma, [{ familyMemberId: 'g1' }], false, ref)).toBe(false);
  });

  it('rejects a content-safety hidden profile', () => {
    expect(isInviteTargetEligible(grandma, [], true, ref)).toBe(false);
  });
});

describe('isOnboardingKid (onboarding copy + portrait sibling chain)', () => {
  const now = new Date('2026-10-02T12:00:00Z');

  it('counts an explicit child, and a name-only kid with no role or birthday', () => {
    expect(isOnboardingKid({ relationship: 'child', date_of_birth: null }, now)).toBe(true);
    expect(isOnboardingKid({ relationship: null, date_of_birth: null }, now)).toBe(true);
    expect(isOnboardingKid({ relationship: null, date_of_birth: '2023-04-01' }, now)).toBe(true);
  });

  it("never counts the owner's parent person or any other role, or an unsorted adult", () => {
    expect(isOnboardingKid({ relationship: 'parent', date_of_birth: null }, now)).toBe(false);
    expect(isOnboardingKid({ relationship: 'grandparent', date_of_birth: null }, now)).toBe(false);
    expect(isOnboardingKid({ relationship: null, date_of_birth: '1988-04-01' }, now)).toBe(false);
  });
});
