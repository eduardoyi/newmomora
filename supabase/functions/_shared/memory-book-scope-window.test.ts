import { assertEquals, assertRejects } from 'jsr:@std/assert@1';
import {
  addDaysToDateOnly,
  EMPTY_WINDOW_SENTINEL,
  resolveEverythingWindow,
  SCOPE_WINDOW_MAX_PAGES,
  SCOPE_WINDOW_PAGE_SIZE,
  ScopeWindowError,
} from './memory-book-scope-window.ts';

import { createFakeClient, type FakeMemory } from './memory-book-scope-window.test-support.ts';

const FAMILY_ID = 'family-1';
const CHILD_ID = 'child-1';
const OTHER_ID = 'sibling-1';

function memory(id: string, date: string, tags: string[] = [], familyId = FAMILY_ID): FakeMemory {
  return { id, family_id: familyId, memory_date: date, tags };
}

Deno.test('addDaysToDateOnly handles month/year rollover and 4-digit padding', () => {
  assertEquals(addDaysToDateOnly('2026-02-28', 1), '2026-03-01');
  assertEquals(addDaysToDateOnly('2025-12-31', 1), '2026-01-01');
  assertEquals(addDaysToDateOnly('2024-02-28', 1), '2024-02-29');
});

Deno.test('first memory tagged only to another member is skipped; the next untagged memory opens the window', async () => {
  const client = createFakeClient([
    memory('a', '2024-01-05', [OTHER_ID]),
    memory('b', '2024-02-10'),
    memory('c', '2024-06-01', [CHILD_ID]),
  ]);
  const window = await resolveEverythingWindow(client, { familyId: FAMILY_ID, childId: CHILD_ID, childDateOfBirth: null });
  assertEquals(window, { start: '2024-02-10', endExclusive: '2024-06-02' });
});

Deno.test('an untagged first memory is eligible', async () => {
  const client = createFakeClient([memory('a', '2024-01-05'), memory('b', '2024-02-10', [OTHER_ID])]);
  const window = await resolveEverythingWindow(client, { familyId: FAMILY_ID, childId: CHILD_ID, childDateOfBirth: null });
  assertEquals(window.start, '2024-01-05');
});

Deno.test('a memory tagged to the child (alongside others) is eligible', async () => {
  const client = createFakeClient([
    memory('a', '2024-01-05', [OTHER_ID]),
    memory('b', '2024-03-01', [OTHER_ID, CHILD_ID]),
  ]);
  const window = await resolveEverythingWindow(client, { familyId: FAMILY_ID, childId: CHILD_ID, childDateOfBirth: null });
  assertEquals(window, { start: '2024-03-01', endExclusive: '2024-03-02' });
});

Deno.test('a DOB later than the earliest memory floors the window start; the DOB filter reaches the query as gte', async () => {
  const log = { scanSelects: [] as string[], ranges: [] as Array<[number, number]>, gtes: [] as unknown[] };
  const client = createFakeClient(
    [memory('a', '2023-11-01'), memory('b', '2024-01-20'), memory('c', '2024-05-05')],
    { log },
  );
  const window = await resolveEverythingWindow(client, { familyId: FAMILY_ID, childId: CHILD_ID, childDateOfBirth: '2024-01-01' });
  assertEquals(window, { start: '2024-01-20', endExclusive: '2024-05-06' });
  assertEquals(log.gtes, ['2024-01-01']);
  assertEquals(log.scanSelects, ['id, memory_date, memory_family_members(family_member_id)']);
});

Deno.test('a DOB earlier than the first memory does not move the window start before the first eligible memory', async () => {
  const client = createFakeClient([memory('a', '2024-03-03'), memory('b', '2024-04-04')]);
  const window = await resolveEverythingWindow(client, { familyId: FAMILY_ID, childId: CHILD_ID, childDateOfBirth: '2020-01-01' });
  assertEquals(window.start, '2024-03-03');
});

Deno.test('no DOB: no date floor is applied and the first eligible memory wins', async () => {
  const log = { scanSelects: [] as string[], ranges: [] as Array<[number, number]>, gtes: [] as unknown[] };
  const client = createFakeClient([memory('a', '2019-01-01'), memory('b', '2024-04-04')], { log });
  const window = await resolveEverythingWindow(client, { familyId: FAMILY_ID, childId: CHILD_ID, childDateOfBirth: null });
  assertEquals(window.start, '2019-01-01');
  assertEquals(log.gtes, []);
});

Deno.test('childId null (family-wide book): the first memory is eligible regardless of tags', async () => {
  const client = createFakeClient([memory('a', '2024-01-05', [OTHER_ID]), memory('b', '2024-02-10')]);
  const window = await resolveEverythingWindow(client, { familyId: FAMILY_ID, childId: null, childDateOfBirth: null });
  assertEquals(window, { start: '2024-01-05', endExclusive: '2024-02-11' });
});

Deno.test('same-date memories break ties by id; only the family\'s own memories count', async () => {
  const client = createFakeClient([
    memory('z', '2024-01-05', [OTHER_ID]),
    memory('a', '2024-01-05'),
    memory('foreign', '2020-01-01', [], 'other-family'),
  ]);
  const window = await resolveEverythingWindow(client, { familyId: FAMILY_ID, childId: CHILD_ID, childDateOfBirth: null });
  assertEquals(window.start, '2024-01-05');
});

Deno.test('a family with no memories collapses to the empty-window sentinel', async () => {
  const window = await resolveEverythingWindow(createFakeClient([]), { familyId: FAMILY_ID, childId: CHILD_ID, childDateOfBirth: null });
  assertEquals(window, { start: EMPTY_WINDOW_SENTINEL, endExclusive: EMPTY_WINDOW_SENTINEL });
});

Deno.test('no eligible memory (all tagged to others, or all before DOB) collapses to the sentinel', async () => {
  const allOthers = createFakeClient([memory('a', '2024-01-05', [OTHER_ID]), memory('b', '2024-02-05', [OTHER_ID])]);
  assertEquals(
    await resolveEverythingWindow(allOthers, { familyId: FAMILY_ID, childId: CHILD_ID, childDateOfBirth: null }),
    { start: EMPTY_WINDOW_SENTINEL, endExclusive: EMPTY_WINDOW_SENTINEL },
  );
  const beforeDob = createFakeClient([memory('a', '2020-01-05'), memory('b', '2020-02-05')]);
  assertEquals(
    await resolveEverythingWindow(beforeDob, { familyId: FAMILY_ID, childId: CHILD_ID, childDateOfBirth: '2024-01-01' }),
    { start: EMPTY_WINDOW_SENTINEL, endExclusive: EMPTY_WINDOW_SENTINEL },
  );
});

Deno.test('an error on the tag-embed scan throws ScopeWindowError, never the sentinel', async () => {
  await assertRejects(
    () =>
      resolveEverythingWindow(
        createFakeClient([memory('a', '2024-01-05')], { scanError: () => true }),
        { familyId: FAMILY_ID, childId: CHILD_ID, childDateOfBirth: null },
      ),
    ScopeWindowError,
  );
});

Deno.test('an error on the latest-memory lookup throws ScopeWindowError', async () => {
  await assertRejects(
    () =>
      resolveEverythingWindow(
        createFakeClient([memory('a', '2024-01-05')], { latestError: true }),
        { familyId: FAMILY_ID, childId: CHILD_ID, childDateOfBirth: null },
      ),
    ScopeWindowError,
  );
});

Deno.test('ineligible rows spanning more than one page are scanned until the first eligible memory', async () => {
  const log = { scanSelects: [] as string[], ranges: [] as Array<[number, number]>, gtes: [] as unknown[] };
  const ineligible = Array.from({ length: SCOPE_WINDOW_PAGE_SIZE + 50 }, (_, i) =>
    memory(`m-${String(i).padStart(4, '0')}`, '2024-01-01', [OTHER_ID]));
  const client = createFakeClient([...ineligible, memory('z-eligible', '2024-02-02')], { log });
  const window = await resolveEverythingWindow(client, { familyId: FAMILY_ID, childId: CHILD_ID, childDateOfBirth: null });
  assertEquals(window, { start: '2024-02-02', endExclusive: '2024-02-03' });
  assertEquals(log.ranges, [[0, SCOPE_WINDOW_PAGE_SIZE - 1], [SCOPE_WINDOW_PAGE_SIZE, 2 * SCOPE_WINDOW_PAGE_SIZE - 1]]);
});

Deno.test('an error on a later scan page still throws ScopeWindowError', async () => {
  const ineligible = Array.from({ length: SCOPE_WINDOW_PAGE_SIZE + 50 }, (_, i) =>
    memory(`m-${String(i).padStart(4, '0')}`, '2024-01-01', [OTHER_ID]));
  await assertRejects(
    () =>
      resolveEverythingWindow(
        createFakeClient([...ineligible, memory('z-eligible', '2024-02-02')], { scanError: (page) => page === 1 }),
        { familyId: FAMILY_ID, childId: CHILD_ID, childDateOfBirth: null },
      ),
    ScopeWindowError,
  );
});

Deno.test('the scan is capped: no eligible memory within the page cap throws ScopeWindowError', async () => {
  // Every page is full of ineligible rows, so the scan never exhausts.
  const total = SCOPE_WINDOW_PAGE_SIZE * SCOPE_WINDOW_MAX_PAGES + 10;
  const rows = Array.from({ length: total }, (_, i) => memory(`m-${String(i).padStart(6, '0')}`, '2024-01-01', [OTHER_ID]));
  const log = { scanSelects: [] as string[], ranges: [] as Array<[number, number]>, gtes: [] as unknown[] };
  await assertRejects(
    () =>
      resolveEverythingWindow(createFakeClient(rows, { log }), { familyId: FAMILY_ID, childId: CHILD_ID, childDateOfBirth: null }),
    ScopeWindowError,
  );
  assertEquals(log.ranges.length, SCOPE_WINDOW_MAX_PAGES);
});
