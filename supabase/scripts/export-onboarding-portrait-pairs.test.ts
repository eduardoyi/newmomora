import { assertEquals } from 'jsr:@std/assert@1';

import {
  assignSlugs,
  parseArgs,
  resolveTargetPixelSize,
  selectLatestReadyVersionPerMember,
  slugify,
  type PortraitVersionRow,
} from './export-onboarding-portrait-pairs.ts';

// --- slugify ----------------------------------------------------------

Deno.test('slugify lowercases and hyphenates', () => {
  assertEquals(slugify('Maya Kim-Ortiz'), 'maya-kim-ortiz');
  assertEquals(slugify(''), 'member');
});

Deno.test('slugify strips diacritics to readable ascii instead of dropping the letter', () => {
  assertEquals(slugify('Théo'), 'theo');
  assertEquals(slugify('Lucía'), 'lucia');
});

// --- parseArgs ----------------------------------------------------------

Deno.test('parseArgs applies defaults when no flags are given', () => {
  const options = parseArgs([]);
  assertEquals(options.email, undefined);
  assertEquals(options.list, false);
  assertEquals(options.download, false);
  assertEquals(options.displayWidth, 108);
  assertEquals(options.displayHeight, 128);
  assertEquals(options.scale, 2);
  assertEquals(options.quality, 74);
  assertEquals(options.memberNames, undefined);
});

Deno.test('parseArgs reads email, mode, and repeatable --member flags', () => {
  const options = parseArgs([
    '--email',
    'hello+demo@usemomora.com',
    '--download',
    '--member',
    'Maya',
    '--member',
    'Theo',
    '--scale',
    '3',
    '--quality',
    '80',
  ]);
  assertEquals(options.email, 'hello+demo@usemomora.com');
  assertEquals(options.download, true);
  assertEquals(options.memberNames, ['Maya', 'Theo']);
  assertEquals(options.scale, 3);
  assertEquals(options.quality, 80);
});

Deno.test('parseArgs falls back to the default for a non-numeric --scale/--quality', () => {
  const options = parseArgs(['--scale', 'nope', '--quality', 'nope']);
  assertEquals(options.scale, 2);
  assertEquals(options.quality, 74);
});

// --- resolveTargetPixelSize ----------------------------------------------

Deno.test('resolveTargetPixelSize multiplies display size by scale', () => {
  assertEquals(
    resolveTargetPixelSize({ displayWidth: 108, displayHeight: 128, scale: 2 }),
    { width: 216, height: 256 },
  );
});

Deno.test('resolveTargetPixelSize rounds and never returns zero', () => {
  assertEquals(
    resolveTargetPixelSize({ displayWidth: 1, displayHeight: 1, scale: 0.4 }),
    { width: 1, height: 1 },
  );
});

// --- selectLatestReadyVersionPerMember -----------------------------------

function version(overrides: Partial<PortraitVersionRow>): PortraitVersionRow {
  return {
    id: 'version-id',
    family_member_id: 'member-id',
    illustrated_profile_status: 'ready',
    profile_picture_key: 'raw/photo.jpg',
    illustrated_profile_key: 'illustrated/portrait.webp',
    reference_date: '2026-01-01',
    created_at: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

Deno.test('selectLatestReadyVersionPerMember excludes non-ready and incomplete rows', () => {
  const rows = [
    version({ id: 'v1', illustrated_profile_status: 'pending' }),
    version({ id: 'v2', illustrated_profile_key: null }),
    version({ id: 'v3', profile_picture_key: null }),
  ];
  assertEquals(selectLatestReadyVersionPerMember(rows), []);
});

Deno.test('selectLatestReadyVersionPerMember keeps one row per member, newest reference_date first', () => {
  const rows = [
    version({ id: 'old', family_member_id: 'lila', reference_date: '2025-01-01' }),
    version({ id: 'new', family_member_id: 'lila', reference_date: '2026-06-01' }),
    version({ id: 'only', family_member_id: 'miguel', reference_date: '2026-03-01' }),
  ];
  const result = selectLatestReadyVersionPerMember(rows);
  assertEquals(result.length, 2);
  assertEquals(result.find((row) => row.family_member_id === 'lila')?.id, 'new');
  assertEquals(result.find((row) => row.family_member_id === 'miguel')?.id, 'only');
});

Deno.test('selectLatestReadyVersionPerMember breaks reference_date ties with newest created_at', () => {
  const rows = [
    version({ id: 'earlier', family_member_id: 'lila', reference_date: '2026-01-01', created_at: '2026-01-01T00:00:00.000Z' }),
    version({ id: 'later', family_member_id: 'lila', reference_date: '2026-01-01', created_at: '2026-02-01T00:00:00.000Z' }),
  ];
  const result = selectLatestReadyVersionPerMember(rows);
  assertEquals(result.length, 1);
  assertEquals(result[0].id, 'later');
});

Deno.test('selectLatestReadyVersionPerMember treats a null reference_date as older than any dated version', () => {
  const rows = [
    version({ id: 'undated', family_member_id: 'lila', reference_date: null, created_at: '2026-06-01T00:00:00.000Z' }),
    version({ id: 'dated', family_member_id: 'lila', reference_date: '2026-01-01', created_at: '2026-01-01T00:00:00.000Z' }),
  ];
  const result = selectLatestReadyVersionPerMember(rows);
  assertEquals(result.length, 1);
  assertEquals(result[0].id, 'dated');
});

// --- assignSlugs ----------------------------------------------------------

Deno.test('assignSlugs slugifies each name', () => {
  assertEquals(assignSlugs(['Maya', 'Theo', 'Ari']), ['maya', 'theo', 'ari']);
});

Deno.test('assignSlugs de-dupes repeated slugs', () => {
  assertEquals(assignSlugs(['Maya', 'Maya', 'Maya']), ['maya', 'maya-2', 'maya-3']);
});
