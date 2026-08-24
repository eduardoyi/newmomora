import { assertEquals, assertThrows } from 'jsr:@std/assert@1';
import {
  getMilestoneById,
  MILESTONE_IDS,
  MILESTONES,
  milestonesInBand,
  parseAgeBandMonths,
} from './memory-milestones.ts';

// Ported verbatim from supabase/scripts/eval-memory-book-tagging.ts's
// CATALOG_ROW_PATTERN/parseMilestoneCatalog.
const CATALOG_ROW_PATTERN = /^\|\s*([^|]+?)\s*\|\s*([^|]+?)\s*\|\s*([^|]+?)\s*\|/;

function parseCatalogIdsFromDoc(markdown: string): string[] {
  const ids: string[] = [];
  for (const rawLine of markdown.split('\n')) {
    const line = rawLine.trim();
    if (!line.startsWith('|')) continue;
    const match = CATALOG_ROW_PATTERN.exec(line);
    if (!match) continue;
    const id = match[1].trim();
    if (!id || id.toLowerCase() === 'id' || /^-+$/.test(id)) continue;
    ids.push(id);
  }
  return ids;
}

async function loadDocIds(): Promise<string[]> {
  const url = new URL('../../../docs/plans/milestone-catalog.md', import.meta.url);
  const markdown = await Deno.readTextFile(url);
  return parseCatalogIdsFromDoc(markdown);
}

Deno.test('MILESTONES has no duplicate ids', () => {
  const ids = MILESTONES.map((entry) => entry.id);
  assertEquals(ids.length, new Set(ids).size);
});

Deno.test('MILESTONES matches docs/plans/milestone-catalog.md exactly (count + ids)', async () => {
  const docIds = await loadDocIds();

  // The doc's own "Notes for implementation" prose says 78 -- that line is
  // stale; the doc's actual tables (parsed here, same as the eval script)
  // contain 77. This file matches the tables.
  assertEquals(docIds.length, 77);
  assertEquals(MILESTONES.length, docIds.length);
  assertEquals(new Set(MILESTONES.map((m) => m.id)), new Set(docIds));
});

Deno.test('MILESTONE_IDS mirrors MILESTONES', () => {
  assertEquals(MILESTONE_IDS, new Set(MILESTONES.map((m) => m.id)));
});

Deno.test('getMilestoneById returns undefined for an unknown id', () => {
  assertEquals(getMilestoneById('not-a-real-milestone'), undefined);
});

// --- parseAgeBandMonths ---------------------------------------------------

Deno.test('parseAgeBandMonths: "any" is null/null', () => {
  assertEquals(parseAgeBandMonths('any'), { min: null, max: null });
});

Deno.test('parseAgeBandMonths: both sides bare months', () => {
  assertEquals(parseAgeBandMonths('0–4m'), { min: 0, max: 4 });
});

Deno.test('parseAgeBandMonths: min inherits the max side unit (months)', () => {
  assertEquals(parseAgeBandMonths('2–8m'), { min: 2, max: 8 });
});

Deno.test('parseAgeBandMonths: min inherits the max side unit (years)', () => {
  assertEquals(parseAgeBandMonths('2–6y'), { min: 24, max: 72 });
});

Deno.test('parseAgeBandMonths: explicit mixed units on both sides', () => {
  assertEquals(parseAgeBandMonths('10m–3y'), { min: 10, max: 36 });
});

Deno.test('parseAgeBandMonths: decimal years round to whole months', () => {
  assertEquals(parseAgeBandMonths('2.5–7y'), { min: 30, max: 84 });
  assertEquals(parseAgeBandMonths('4.5–8.5y'), { min: 54, max: 102 });
});

Deno.test('parseAgeBandMonths: known catalog entries', () => {
  assertEquals(parseAgeBandMonths('8–19m'), { min: 8, max: 19 });
  assertEquals(parseAgeBandMonths('16m–3.5y'), { min: 16, max: 42 });
});

Deno.test('parseAgeBandMonths: throws on an unparsable band', () => {
  assertThrows(() => parseAgeBandMonths('not a band'));
});

Deno.test('every MILESTONES entry has a band consistent with parseAgeBandMonths', () => {
  for (const entry of MILESTONES) {
    assertEquals(entry.ageBandMonths, parseAgeBandMonths(entry.band));
  }
});

// --- milestonesInBand ------------------------------------------------------

Deno.test('milestonesInBand: null age returns only any-band entries', () => {
  const result = milestonesInBand(null);
  assertEquals(result.every((m) => m.ageBandMonths.min === null), true);
  assertEquals(result.some((m) => m.id === 'birthday'), true);
  assertEquals(result.some((m) => m.id === 'first-steps'), false);
});

Deno.test('milestonesInBand: 12-month-old includes first-steps, excludes loses-first-tooth', () => {
  const result = milestonesInBand(12).map((m) => m.id);
  assertEquals(result.includes('first-steps'), true);
  assertEquals(result.includes('loses-first-tooth'), false);
  // any-band entries are always included regardless of age.
  assertEquals(result.includes('birthday'), true);
});

Deno.test('milestonesInBand: age exactly on a boundary is included (inclusive)', () => {
  const at8 = milestonesInBand(8).map((m) => m.id);
  const at19 = milestonesInBand(19).map((m) => m.id);
  assertEquals(at8.includes('first-steps'), true);
  assertEquals(at19.includes('first-steps'), true);
  assertEquals(milestonesInBand(7).includes(getMilestoneById('first-steps')!), false);
  assertEquals(milestonesInBand(20).includes(getMilestoneById('first-steps')!), false);
});
