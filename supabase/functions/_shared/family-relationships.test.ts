import { assertEquals } from 'jsr:@std/assert@1';
import { isFamilySide, isOwnChild, isRelationship, isSideRole, sideLabel } from './family-relationships.ts';

const TODAY = '2026-09-28';

Deno.test('isOwnChild: explicit child wins regardless of DOB', () => {
  assertEquals(isOwnChild({ relationship: 'child', dateOfBirth: null }, TODAY), true);
  assertEquals(isOwnChild({ relationship: 'child', dateOfBirth: '1990-01-01' }, TODAY), true);
});

Deno.test('isOwnChild: any other explicit role is not a child', () => {
  assertEquals(isOwnChild({ relationship: 'cousin', dateOfBirth: '2021-03-01' }, TODAY), false);
  assertEquals(isOwnChild({ relationship: 'pet', dateOfBirth: '2024-01-01' }, TODAY), false);
});

Deno.test('isOwnChild: unsorted falls back to the DOB < 13 rule', () => {
  assertEquals(isOwnChild({ relationship: null, dateOfBirth: '2022-10-17' }, TODAY), true);
  assertEquals(isOwnChild({ dateOfBirth: '2013-09-28' }, TODAY), false); // turns 13 today
  assertEquals(isOwnChild({ dateOfBirth: '2013-09-29' }, TODAY), true);
  assertEquals(isOwnChild({ relationship: null, dateOfBirth: null }, TODAY), false);
});

Deno.test('type guards', () => {
  assertEquals(isRelationship('great_grandparent'), true);
  assertEquals(isRelationship('sibling'), false);
  assertEquals(isRelationship(null), false);
  assertEquals(isSideRole('aunt_uncle'), true);
  assertEquals(isSideRole('parent'), false);
  assertEquals(isFamilySide('both'), true);
  assertEquals(isFamilySide('member'), false);
});

Deno.test('sideLabel: parent name, generic sides, and stale parents', () => {
  const dad = { id: 'p1', name: 'Eduardo Yi', relationship: 'parent' };
  const exParent = { id: 'p2', name: 'Sam', relationship: 'other' };
  const members = [dad, exParent];
  assertEquals(sideLabel({ id: 'g', name: 'Mirian', relationship: 'grandparent', side_member_id: 'p1' }, members), "Eduardo's side");
  assertEquals(sideLabel({ id: 'g', name: 'Mirian', relationship: 'grandparent', side_member_id: 'p2' }, members), null);
  assertEquals(sideLabel({ id: 'g', name: 'Mirian', relationship: 'grandparent', side_member_id: 'gone' }, members), null);
  assertEquals(sideLabel({ id: 'a', name: 'Ana', relationship: 'aunt_uncle', family_side: 'maternal' }, members), "Mom's side");
  assertEquals(sideLabel({ id: 'a', name: 'Ana', relationship: 'cousin', family_side: 'paternal' }, members), "Dad's side");
  assertEquals(sideLabel({ id: 'a', name: 'Ana', relationship: 'cousin', family_side: 'both' }, members), 'Both sides');
  // Not a side role: no label even if a stale side is present.
  assertEquals(sideLabel({ id: 'f', name: 'Jo', relationship: 'family_friend', family_side: 'both' }, members), null);
  assertEquals(sideLabel({ id: 'u', name: 'Kim', relationship: 'grandparent' }, members), null);
});
