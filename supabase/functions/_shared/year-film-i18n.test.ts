import { assertEquals } from 'jsr:@std/assert@1';
import { MILESTONES } from './memory-milestones.ts';
import { TOPICS } from './memory-topics.ts';
import {
  detectJournalLanguage,
  MILESTONE_NAMES_ES,
  milestoneLabel,
  resolveFilmLanguage,
  TOPIC_TITLES_ES,
  topicTitle,
} from './year-film-i18n.ts';

Deno.test('every topic and milestone in the catalogs has a Spanish label', () => {
  assertEquals(TOPICS.filter((t) => !TOPIC_TITLES_ES[t.id]).map((t) => t.id), []);
  assertEquals(MILESTONES.filter((m) => !MILESTONE_NAMES_ES[m.id]).map((m) => m.id), []);
});

Deno.test('labels resolve per language; English drops catalog notes', () => {
  assertEquals(topicTitle('park-playground', 'es'), 'Días de parque');
  assertEquals(topicTitle('park-playground', 'en'), 'Park days');
  assertEquals(milestoneLabel('birthday', 'en'), 'Birthday');
  assertEquals(milestoneLabel('first-steps', 'es'), 'Primeros pasos');
  assertEquals(topicTitle('not-a-topic', 'es'), null);
});

Deno.test('detectJournalLanguage votes per memory and needs enough text', () => {
  const es = [
    'Hoy Tomás cumplió tres años y la pasó muy bien con su hermana',
    'Lucía y Tomás comieron pasta en la feria de comida',
    'Tomás le dijo a mami que el mundo es un lugar mágico',
    'Fuimos al parque con los abuelos por la tarde',
    'Lucía estaba muy feliz con su bici nueva',
  ];
  assertEquals(detectJournalLanguage(es), 'es');
  assertEquals(detectJournalLanguage([...es, 'We went to the park and she was so happy']), 'es');
  assertEquals(detectJournalLanguage(['hola', null, 'ok']), null);
});

Deno.test('resolveFilmLanguage: model, then detected, then setting, then English (the book\'s rule)', () => {
  assertEquals(resolveFilmLanguage('es', 'en', 'en'), 'es');
  assertEquals(resolveFilmLanguage(null, 'es', 'en'), 'es');
  assertEquals(resolveFilmLanguage(null, null, 'es-VE'), 'es');
  assertEquals(resolveFilmLanguage('fr', null, null), 'en');
});
