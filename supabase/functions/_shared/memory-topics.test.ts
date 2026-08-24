import { assertEquals } from 'jsr:@std/assert@1';
import {
  DATE_GATED_TOPIC_IDS,
  getTopicById,
  NEGATIVE_EXAMPLES,
  TOPIC_IDS,
  TOPICS,
  TOPICS_REQUIRING_DETAIL,
  TOPICS_VERSION,
} from './memory-topics.ts';

// Ported verbatim from supabase/scripts/eval-memory-book-tagging.ts's
// TOPIC_ROW_PATTERN/parseTopicVocabulary -- matches only the vocabulary
// tables' rows (backtick-wrapped id, optional v2 "added" marker), which is
// what lets this skip header rows, separator rows, and the doc's other
// table ("Concepts owned by other axes", whose first column is bold text
// like `**Emotion**`, not a topic id).
const TOPIC_ROW_PATTERN = /^\|\s*`([a-z0-9-]+)`\s*✦?\s*\|\s*([^|]+?)\s*\|\s*([^|]+?)\s*\|/;

function parseTopicIdsFromDoc(markdown: string): string[] {
  const ids: string[] = [];
  for (const rawLine of markdown.split('\n')) {
    const line = rawLine.trim();
    if (!line.startsWith('|')) continue;
    const match = TOPIC_ROW_PATTERN.exec(line);
    if (!match) continue;
    ids.push(match[1].trim());
  }
  return ids;
}

async function loadDocIds(): Promise<string[]> {
  const url = new URL('../../../docs/plans/topic-vocabulary.md', import.meta.url);
  const markdown = await Deno.readTextFile(url);
  return parseTopicIdsFromDoc(markdown);
}

Deno.test('TOPICS has no duplicate ids', () => {
  const ids = TOPICS.map((topic) => topic.id);
  assertEquals(ids.length, new Set(ids).size);
});

Deno.test('TOPICS matches docs/plans/topic-vocabulary.md exactly (count + ids)', async () => {
  const docIds = await loadDocIds();

  assertEquals(docIds.length, 61);
  assertEquals(TOPICS.length, docIds.length);
  assertEquals(new Set(TOPICS.map((t) => t.id)), new Set(docIds));
});

Deno.test('TOPIC_IDS mirrors TOPICS', () => {
  assertEquals(TOPIC_IDS, new Set(TOPICS.map((t) => t.id)));
});

Deno.test('TOPICS_REQUIRING_DETAIL matches the doc-specified four detail topics', () => {
  assertEquals(
    TOPICS_REQUIRING_DETAIL,
    new Set(['other-holiday', 'national-holiday', 'ceremony', 'mothers-fathers-day']),
  );
});

Deno.test('DATE_GATED_TOPIC_IDS excludes birthday and the three never-gated detail topics', () => {
  assertEquals(DATE_GATED_TOPIC_IDS.has('birthday'), false);
  assertEquals(DATE_GATED_TOPIC_IDS.has('other-holiday'), false);
  assertEquals(DATE_GATED_TOPIC_IDS.has('national-holiday'), false);
  assertEquals(DATE_GATED_TOPIC_IDS.has('ceremony'), false);
  // mothers-fathers-day requires detail AND is gated (computed, not table-driven).
  assertEquals(DATE_GATED_TOPIC_IDS.has('mothers-fathers-day'), true);
  assertEquals(DATE_GATED_TOPIC_IDS.has('christmas'), true);
  assertEquals(DATE_GATED_TOPIC_IDS.has('easter'), true);
});

Deno.test('every movable-holiday topic has a 2022-2027 date table', () => {
  for (const id of ['easter', 'eid', 'diwali', 'hanukkah', 'lunar-new-year']) {
    const topic = getTopicById(id);
    if (!topic || topic.dateGate.type !== 'movable') {
      throw new Error(`expected ${id} to have a movable date gate`);
    }
    for (const year of [2022, 2023, 2024, 2025, 2026, 2027]) {
      assertEquals(typeof topic.dateGate.datesByYear[year], 'string', `${id} missing ${year}`);
    }
  }
});

Deno.test('getTopicById returns undefined for an unknown id', () => {
  assertEquals(getTopicById('not-a-real-topic'), undefined);
});

Deno.test('TOPICS_VERSION is a stable positive integer', () => {
  assertEquals(Number.isInteger(TOPICS_VERSION), true);
  assertEquals(TOPICS_VERSION >= 1, true);
});

Deno.test('NEGATIVE_EXAMPLES is non-empty and has no duplicates', () => {
  assertEquals(NEGATIVE_EXAMPLES.length > 0, true);
  assertEquals(NEGATIVE_EXAMPLES.length, new Set(NEGATIVE_EXAMPLES).size);
});
