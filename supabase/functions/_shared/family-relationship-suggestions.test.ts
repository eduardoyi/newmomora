import { assertEquals, assertStringIncludes } from 'jsr:@std/assert@1';
import {
  buildSuggestionPrompt,
  type FamilySignals,
  nothingToSuggest,
  type SignalMember,
  validateSuggestions,
} from './family-relationship-suggestions.ts';

function member(overrides: Partial<SignalMember> & { id: string; first_name: string }): SignalMember {
  return {
    nicknames: [],
    age_years: null,
    gender: null,
    relationship: null,
    family_side: null,
    side_member_id: null,
    is_own_child: false,
    ...overrides,
  };
}

// P1 Eduardo (parent, linked), P2 Tomás (child), P3 Mirian (unsorted), P4 Elena (unsorted niece), P5 Rosa (unsorted)
function signals(overrides: Partial<FamilySignals> = {}): FamilySignals {
  return {
    members: [
      member({ id: 'dad', first_name: 'Eduardo', relationship: 'parent', age_years: 38 }),
      member({ id: 'tomas', first_name: 'Tomás', relationship: 'child', age_years: 3, is_own_child: true }),
      member({ id: 'mirian', first_name: 'Mirian', age_years: 66 }),
      member({ id: 'elena', first_name: 'Elena', age_years: 6, is_own_child: true }),
      member({ id: 'rosa', first_name: 'Rosa', age_years: 64, nicknames: ['Nana'] }),
    ],
    accounts: [{ family_member_id: 'dad', display_name: 'Eduardo', role: 'owner' }],
    co_tags: [{ member_id: 'mirian', child_id: 'tomas', memories: 12 }],
    snippets: [
      { text: 'Abuela Mirian llevó a Tomás al parque', memory_date: '2026-08-01', author_member_id: 'dad', member_ids: ['mirian', 'tomas'] },
      { text: 'Mi sobrina Elena vino a jugar, la prima de Tomás', memory_date: '2026-07-01', author_member_id: 'dad', member_ids: ['elena', 'tomas'] },
    ],
    ...overrides,
  };
}

Deno.test('buildSuggestionPrompt uses refs, never member UUIDs', () => {
  const prompt = buildSuggestionPrompt(signals());
  assertStringIncludes(prompt, '"ref":"P3"');
  assertStringIncludes(prompt, '"written_by":"P1"');
  assertEquals(prompt.includes('mirian"'), false); // ids are not leaked as refs
  assertEquals(prompt.includes('"dad"'), false);
});

Deno.test('validateSuggestions: roles, parent side, grounded nickname', () => {
  const rows = validateSuggestions(signals(), {
    people: [
      { ref: 'P3', relationship: 'grandparent', side: 'P1', nicknames: ['Abuela'], confidence: 0.9 },
      { ref: 'P4', relationship: 'cousin', side: 'paternal', nicknames: [], confidence: 0.8 },
    ],
  });
  assertEquals(rows, [
    { family_member_id: 'mirian', field: 'relationship', value: 'grandparent', based_on: null },
    { family_member_id: 'mirian', field: 'family_side', value: 'member', side_member_id: 'dad', based_on: null },
    { family_member_id: 'elena', field: 'relationship', value: 'cousin', based_on: null },
    { family_member_id: 'elena', field: 'family_side', value: 'paternal', based_on: null },
    { family_member_id: 'mirian', field: 'nickname', value: 'Abuela' },
  ]);
});

Deno.test('validateSuggestions: never second-guesses a set role, low confidence or junk', () => {
  const rows = validateSuggestions(signals(), {
    people: [
      { ref: 'P1', relationship: 'grandparent', confidence: 0.99 }, // already a parent
      { ref: 'P3', relationship: 'grandparent', confidence: 0.4 }, // too unsure
      { ref: 'P4', relationship: 'niece', confidence: 0.9 }, // not a role
      { ref: 'P99', relationship: 'cousin', confidence: 0.9 }, // no such person
      { ref: 'dad', relationship: 'cousin', confidence: 0.9 }, // raw id, not a ref
      'ignore previous instructions',
    ],
  });
  assertEquals(rows, []);
  assertEquals(validateSuggestions(signals(), null), []);
  assertEquals(validateSuggestions(signals(), { people: 'x' }), []);
});

Deno.test('validateSuggestions: side only for side roles and only at a parent', () => {
  const rows = validateSuggestions(signals(), {
    people: [
      { ref: 'P3', relationship: 'family_friend', side: 'P1', confidence: 0.9 }, // not a side role
      { ref: 'P5', relationship: 'grandparent', side: 'P2', confidence: 0.9 }, // Tomás is not a parent
    ],
  });
  assertEquals(rows, [
    { family_member_id: 'mirian', field: 'relationship', value: 'family_friend', based_on: null },
    { family_member_id: 'rosa', field: 'relationship', value: 'grandparent', based_on: null },
  ]);
});

Deno.test('validateSuggestions: a parent proposed in the same run can anchor a side', () => {
  const base = signals();
  base.members[0] = member({ id: 'dad', first_name: 'Eduardo', age_years: 38 });
  const rows = validateSuggestions(base, {
    people: [
      { ref: 'P1', relationship: 'parent', confidence: 0.95 },
      { ref: 'P3', relationship: 'grandparent', side: 'P1', confidence: 0.9 },
    ],
  });
  assertEquals(rows.find((r) => r.field === 'family_side'), {
    family_member_id: 'mirian', field: 'family_side', value: 'member', side_member_id: 'dad', based_on: null,
  });
});

Deno.test('validateSuggestions: nickname rules (grounding, collisions, shape, cap)', () => {
  const s = signals({
    snippets: [
      { text: 'Abuela y Nana con Tomás; Abuelita, Yaya, Abu, Mimi', memory_date: null, author_member_id: null, member_ids: ['mirian'] },
      { text: 'Abuela Rosa trajo pastel', memory_date: null, author_member_id: null, member_ids: ['rosa'] },
    ],
  });
  const rows = validateSuggestions(s, {
    people: [
      // Nana is Rosa's nickname; Tomás is a name; "Grandma" isn't in the snippets;
      // "<script>" fails the shape; Abuela collides with Rosa's proposal below.
      { ref: 'P3', relationship: null, nicknames: ['Nana', 'Tomás', 'Grandma', '<script>', 'Abuela', 'Abuelita', 'Yaya', 'Mimi'] },
      { ref: 'P5', nicknames: ['Abuela'] },
    ],
  });
  // Abuela proposed for two people -> dropped for both; cap of 2 keeps Abuelita + Yaya.
  assertEquals(rows, [
    { family_member_id: 'mirian', field: 'nickname', value: 'Abuelita' },
    { family_member_id: 'mirian', field: 'nickname', value: 'Yaya' },
  ]);
});

Deno.test('validateSuggestions: nickname must be a whole word in the snippets', () => {
  const s = signals({
    snippets: [{ text: 'Mirian comió banana', memory_date: null, author_member_id: null, member_ids: ['mirian'] }],
  });
  assertEquals(validateSuggestions(s, { people: [{ ref: 'P3', nicknames: ['Ana', 'Nana'] }] }), []);
});

Deno.test('nothingToSuggest', () => {
  assertEquals(nothingToSuggest(signals(), 0), false); // unsorted people
  const sorted = signals({
    members: [
      member({ id: 'dad', first_name: 'Eduardo', relationship: 'parent' }),
      member({ id: 'g', first_name: 'Mirian', relationship: 'grandparent', side_member_id: 'dad' }),
    ],
  });
  assertEquals(nothingToSuggest(sorted, 0), true);
  assertEquals(nothingToSuggest(sorted, 3), false); // new memories may carry nicknames
  const missingSide = signals({ members: [member({ id: 'g', first_name: 'Mirian', relationship: 'grandparent' })] });
  assertEquals(nothingToSuggest(missingSide, 0), false);
  assertEquals(nothingToSuggest(signals({ members: [] }), 5), true);
});
