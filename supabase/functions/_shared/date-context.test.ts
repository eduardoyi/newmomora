import { assertEquals, assertExists } from 'jsr:@std/assert@1';
import {
  ageInMonthsAtDate,
  buildMemoryContext,
  classifyChildOrAdult,
  computeBirthdayMatch,
  daysToBirthday,
  formatMemoryContextForPrompt,
  gateTopicsByDate,
  isDateWithinGate,
  nearbyHolidays,
  nthWeekdayOfMonth,
  toJulianDayNumber,
} from './date-context.ts';
import { getTopicById } from './memory-topics.ts';

// --- toJulianDayNumber / nthWeekdayOfMonth --------------------------------

Deno.test('toJulianDayNumber is monotonic across a month/year boundary', () => {
  const dec31 = toJulianDayNumber('2025-12-31');
  const jan1 = toJulianDayNumber('2026-01-01');
  assertEquals(jan1 - dec31, 1);
});

Deno.test('nthWeekdayOfMonth computes the 4th Thursday of November 2025', () => {
  // Verified against a real calendar: 2025-11-27 is Thanksgiving (US).
  assertEquals(nthWeekdayOfMonth(2025, 11, 4, 4), '2025-11-27');
});

// --- daysToBirthday --------------------------------------------------------

Deno.test('daysToBirthday returns 0 on the birthday itself', () => {
  assertEquals(daysToBirthday('2022-06-15', '2026-06-15'), 0);
});

Deno.test('daysToBirthday returns a positive count when the birthday is upcoming', () => {
  assertEquals(daysToBirthday('2022-06-15', '2026-06-10'), 5);
});

Deno.test('daysToBirthday returns a negative count when the birthday just passed', () => {
  assertEquals(daysToBirthday('2022-06-15', '2026-06-20'), -5);
});

Deno.test('daysToBirthday picks the nearer of last year vs next year across a year boundary', () => {
  assertEquals(daysToBirthday('2020-01-02', '2025-12-30'), 3);
});

Deno.test('daysToBirthday clamps a Feb 29 birthday to Feb 28 in non-leap years', () => {
  assertEquals(daysToBirthday('2020-02-29', '2023-02-28'), 0);
});

// --- ageInMonthsAtDate / classifyChildOrAdult ------------------------------

Deno.test('ageInMonthsAtDate computes whole months elapsed', () => {
  assertEquals(ageInMonthsAtDate('2025-01-15', '2025-07-15'), 6);
  assertEquals(ageInMonthsAtDate('2025-01-15', '2025-07-10'), 5);
});

Deno.test('ageInMonthsAtDate returns null when referenceDate precedes dateOfBirth', () => {
  assertEquals(ageInMonthsAtDate('2025-06-01', '2025-01-01'), null);
});

Deno.test('classifyChildOrAdult classifies by the <13 threshold and unknown DOB', () => {
  assertEquals(classifyChildOrAdult(0), 'child');
  assertEquals(classifyChildOrAdult(12), 'child');
  assertEquals(classifyChildOrAdult(13), 'adult');
  assertEquals(classifyChildOrAdult(null), 'unknown');
});

// --- computeBirthdayMatch ----------------------------------------------------

Deno.test('computeBirthdayMatch matches a tagged member within the default 7-day window, with a signed offset', () => {
  const result = computeBirthdayMatch(
    [{ id: 'a', name: 'Enzo', dateOfBirth: '2022-06-15' }],
    '2026-06-18',
  );
  assertEquals(result.birthdayMatch, { memberId: 'a', memberName: 'Enzo', ageTurned: 4, daysOffset: 3 });
  assertEquals(result.birthMatch, null);
});

Deno.test('computeBirthdayMatch reports a negative daysOffset when the memory precedes the anniversary', () => {
  const result = computeBirthdayMatch(
    [{ id: 'a', name: 'Enzo', dateOfBirth: '2022-06-15' }],
    '2026-06-12',
  );
  assertEquals(result.birthdayMatch, { memberId: 'a', memberName: 'Enzo', ageTurned: 4, daysOffset: -3 });
});

Deno.test('computeBirthdayMatch returns nulls outside the window', () => {
  const result = computeBirthdayMatch(
    [{ id: 'a', name: 'Enzo', dateOfBirth: '2022-06-15' }],
    '2026-06-30',
  );
  assertEquals(result.birthdayMatch, null);
  assertEquals(result.birthMatch, null);
});

Deno.test('computeBirthdayMatch ignores members with no date_of_birth', () => {
  const result = computeBirthdayMatch([{ id: 'a', name: 'Grandma', dateOfBirth: null }], '2026-06-15');
  assertEquals(result.birthdayMatch, null);
  assertEquals(result.birthMatch, null);
});

Deno.test('computeBirthdayMatch picks the closer of two matching members, tie-breaking on id', () => {
  const result = computeBirthdayMatch(
    [
      { id: 'b', name: 'Mara', dateOfBirth: '2024-06-12' }, // 3 days away
      { id: 'a', name: 'Enzo', dateOfBirth: '2022-06-15' }, // 0 days away
    ],
    '2026-06-15',
  );
  assertEquals(result.birthdayMatch, { memberId: 'a', memberName: 'Enzo', ageTurned: 4, daysOffset: 0 });
});

Deno.test('computeBirthdayMatch reports the birth itself (ageTurned 0) as birthMatch, not birthdayMatch', () => {
  const result = computeBirthdayMatch(
    [{ id: 'a', name: 'Mara', dateOfBirth: '2026-06-15' }],
    '2026-06-18',
  );
  assertEquals(result.birthdayMatch, null);
  assertEquals(result.birthMatch, { memberId: 'a', memberName: 'Mara', daysFromBirth: 3 });
});

Deno.test('computeBirthdayMatch tracks birthdayMatch and birthMatch independently for different members', () => {
  const result = computeBirthdayMatch(
    [
      { id: 'a', name: 'Enzo', dateOfBirth: '2022-06-15' }, // turns 4 -- a real birthday
      { id: 'b', name: 'Mara', dateOfBirth: '2026-06-16' }, // born the day before -- a birth, not a birthday
    ],
    '2026-06-15',
  );
  assertEquals(result.birthdayMatch, { memberId: 'a', memberName: 'Enzo', ageTurned: 4, daysOffset: 0 });
  assertEquals(result.birthMatch, { memberId: 'b', memberName: 'Mara', daysFromBirth: -1 });
});

// --- nearbyHolidays ----------------------------------------------------------

Deno.test('nearbyHolidays finds Christmas within the default 10-day window', () => {
  const holidays = nearbyHolidays('2025-12-20');
  assertEquals(holidays.map((h) => h.name).includes('Christmas'), true);
});

Deno.test('nearbyHolidays finds nothing far from any fixed holiday or Thanksgiving', () => {
  assertEquals(nearbyHolidays('2026-08-15'), []);
});

Deno.test("nearbyHolidays wraps across the year boundary (New Year near New Year's Eve)", () => {
  const holidays = nearbyHolidays('2026-01-03');
  assertEquals(holidays.map((h) => h.name).includes("New Year's Day"), true);
});

Deno.test('nearbyHolidays computes the 4th-Thursday-of-November rule for Thanksgiving (US)', () => {
  const holidays = nearbyHolidays('2025-11-27');
  const thanksgiving = holidays.find((h) => h.name === 'Thanksgiving (US)');
  assertExists(thanksgiving);
  assertEquals(thanksgiving!.date, '2025-11-27');
  assertEquals(thanksgiving!.daysAway, 0);
});

// --- isDateWithinGate / gateTopicsByDate -------------------------------------

Deno.test('isDateWithinGate: {type:"none"} is always true', () => {
  assertEquals(isDateWithinGate({ type: 'none' }, '2026-03-14'), true);
});

Deno.test('isDateWithinGate: fixed window matches Christmas in mid-December', () => {
  const gate = getTopicById('christmas')!.dateGate;
  assertEquals(isDateWithinGate(gate, '2025-12-20'), true);
  assertEquals(isDateWithinGate(gate, '2025-07-04'), false);
});

Deno.test('isDateWithinGate: fixed window wraps the year boundary for christmas (Dec 15 -> Jan 6)', () => {
  const gate = getTopicById('christmas')!.dateGate;
  assertEquals(isDateWithinGate(gate, '2026-01-02'), true);
  assertEquals(isDateWithinGate(gate, '2026-01-10'), false);
});

Deno.test('isDateWithinGate: thanksgiving matches the computed 4th Thursday of November +/- 7 days', () => {
  const gate = getTopicById('thanksgiving')!.dateGate;
  assertEquals(isDateWithinGate(gate, '2025-11-27'), true);
  assertEquals(isDateWithinGate(gate, '2025-11-20'), true);
  assertEquals(isDateWithinGate(gate, '2025-10-01'), false);
});

Deno.test("isDateWithinGate: mothers-fathers-day matches either Mother's or Father's Day", () => {
  const gate = getTopicById('mothers-fathers-day')!.dateGate;
  // 2026: Mother's Day = 2nd Sunday of May = 2026-05-10; Father's Day = 3rd
  // Sunday of June = 2026-06-21.
  assertEquals(isDateWithinGate(gate, '2026-05-10'), true);
  assertEquals(isDateWithinGate(gate, '2026-06-21'), true);
  assertEquals(isDateWithinGate(gate, '2026-03-01'), false);
});

Deno.test('isDateWithinGate: movable holiday matches its tabled date within 10 days', () => {
  const gate = getTopicById('easter')!.dateGate;
  assertEquals(isDateWithinGate(gate, '2025-04-20'), true); // Easter 2025 exactly
  assertEquals(isDateWithinGate(gate, '2025-01-01'), false);
});

Deno.test('isDateWithinGate: movable holiday fails closed outside the 2022-2027 table', () => {
  const gate = getTopicById('easter')!.dateGate;
  assertEquals(isDateWithinGate(gate, '2030-04-21'), false);
});

Deno.test('gateTopicsByDate: keeps non-date-gated and in-window topics, removes out-of-window ones', () => {
  const result = gateTopicsByDate(
    [{ id: 'beach' }, { id: 'christmas' }, { id: 'halloween' }],
    '2025-12-20',
  );
  assertEquals(result.topics.map((t) => t.id).sort(), ['beach', 'christmas']);
  assertEquals(result.dateGated, ['halloween']);
});

Deno.test('gateTopicsByDate: never gates other-holiday/national-holiday/ceremony', () => {
  const result = gateTopicsByDate(
    [{ id: 'other-holiday' }, { id: 'national-holiday' }, { id: 'ceremony' }],
    '2025-07-04',
  );
  assertEquals(result.topics.length, 3);
  assertEquals(result.dateGated, []);
});

Deno.test('gateTopicsByDate: an unknown topic id is treated as ungated (passes through)', () => {
  const result = gateTopicsByDate([{ id: 'not-a-real-topic' }], '2025-07-04');
  assertEquals(result.topics.length, 1);
  assertEquals(result.dateGated, []);
});

// --- buildMemoryContext / formatMemoryContextForPrompt -----------------------

Deno.test('buildMemoryContext computes age/personType/daysToBirthday per tagged member', () => {
  const context = buildMemoryContext('2026-06-18', [
    { id: 'a', name: 'Enzo Garcia', dateOfBirth: '2022-06-15' },
    { id: 'b', name: 'Grandma', dateOfBirth: null },
  ]);

  assertEquals(context.memoryDate, '2026-06-18');
  assertEquals(context.members[0].firstName, 'Enzo');
  assertEquals(context.members[0].ageYears, 4);
  assertEquals(context.members[0].personType, 'child');
  assertEquals(context.members[0].daysToBirthday, -3);
  assertEquals(context.members[1].ageYears, null);
  assertEquals(context.members[1].personType, 'unknown');
});

Deno.test('formatMemoryContextForPrompt renders a readable block with no tagged people or holidays', () => {
  const context = buildMemoryContext('2026-08-15', []);
  const text = formatMemoryContextForPrompt(context);
  assertEquals(text.includes('Entry date: 2026-08-15'), true);
  assertEquals(text.includes('Tagged people: none'), true);
  assertEquals(text.includes('Nearby holidays: none'), true);
});

Deno.test('formatMemoryContextForPrompt includes a birthday-proximity line for a tagged child', () => {
  const context = buildMemoryContext('2026-06-12', [
    { id: 'a', name: 'Enzo', dateOfBirth: '2022-06-15' },
  ]);
  const text = formatMemoryContextForPrompt(context);
  assertEquals(text.includes('birthday in 3d'), true);
});
