import { assertEquals } from 'jsr:@std/assert@1';
import { MILESTONES } from './memory-milestones.ts';
import {
  catalogIdsMissingEvidenceRule,
  evaluateMilestoneEvidence,
  foldForEvidence,
  memoryTextStatesMilestone,
  MILESTONE_EVIDENCE_RULES,
  quoteIsVerbatim,
  verifyMilestoneEvidence,
} from './memory-milestone-evidence.ts';

Deno.test('every catalog entry has an evidence rule and every rule has a catalog entry', () => {
  assertEquals(catalogIdsMissingEvidenceRule(), []);
  const catalogIds = new Set(MILESTONES.map((m) => m.id));
  assertEquals(Object.keys(MILESTONE_EVIDENCE_RULES).filter((id) => !catalogIds.has(id)), []);
});

Deno.test('every rule regex source compiles', () => {
  for (const id of Object.keys(MILESTONE_EVIDENCE_RULES)) {
    // evaluate on arbitrary text: throws only if a rule failed to compile at import.
    evaluateMilestoneEvidence(id, 'x');
  }
});

Deno.test('foldForEvidence strips diacritics/case/punctuation and collapses whitespace', () => {
  assertEquals(foldForEvidence('  ¡Papá,   dijo\n“MAMÁ”… '), 'papa dijo mama');
});

Deno.test('quoteIsVerbatim: word-bounded, tolerant of case/accents/punctuation, rejects too-short quotes', () => {
  assertEquals(quoteIsVerbatim('primeros pasos', 'Dio sus PRIMEROS pasos!'), true);
  assertEquals(quoteIsVerbatim('rimeros pasos', 'Dio sus primeros pasos!'), false);
  assertEquals(quoteIsVerbatim('primera', 'primera'), false); // < 8 chars
  assertEquals(quoteIsVerbatim('dio sus primeros pasos', 'otra cosa'), false);
});

Deno.test('first-kind entries need first-time wording (the owner over-tag cases are rejected)', () => {
  const rejected: Array<[string, string]> = [
    ['first-haircut', 'Tomás en la barbería con su corte de pelo'],
    ['first-haircut', 'Haircut day at the barber'],
    ['first-question', 'Tomás asked me a question about the moon'],
    ['first-question', 'Tomás me hizo una pregunta'],
    ['first-beach', 'Un día en la playa con los abuelos'],
    ['first-trip', 'Our trip to the lake house'],
    ['first-tooth', 'Her tooth is wiggly'],
    ['first-pool', 'Mia swam in the pool'],
  ];
  for (const [id, quote] of rejected) {
    assertEquals(evaluateMilestoneEvidence(id, quote), { ok: false, reason: 'no_explicit_language' }, `${id}: ${quote}`);
  }
});

Deno.test('first-kind entries are kept with explicit first-time wording in es/en/pt', () => {
  const kept: Array<[string, string]> = [
    ['first-haircut', 'hoy le cortaron el pelo por primera vez'],
    ['first-haircut', 'her first haircut today'],
    ['first-haircut', 'o primeiro corte de cabelo dele'],
    ['first-steps', 'dio sus primeros pasos'],
    ['first-steps', 'took her first steps'],
    ['first-question', 'asked her first why'],
    ['first-beach', 'for the first time at the beach'],
    ['first-beach', 'primera vez en la playa'],
    ['first-snow', 'saw snow for the first time'],
    ['first-tooth', 'se le salió el primer diente'],
    ['first-word', 'su primera palabra fue agua'],
    ['first-plane', 'our first flight together'],
  ];
  for (const [id, quote] of kept) {
    assertEquals(evaluateMilestoneEvidence(id, quote), { ok: true }, `${id}: ${quote}`);
  }
});

Deno.test('"first" as a sequencing word is not first-time wording', () => {
  assertEquals(evaluateMilestoneEvidence('first-beach', 'first we went to the beach').ok, false);
  assertEquals(evaluateMilestoneEvidence('first-beach', 'at first the beach was cold').ok, false);
  assertEquals(evaluateMilestoneEvidence('first-beach', 'primero fuimos a la playa').ok, false);
});

Deno.test('first-time wording about a different subject does not carry the milestone', () => {
  assertEquals(evaluateMilestoneEvidence('first-haircut', 'primera vez que come mango'), {
    ok: false,
    reason: 'subject_not_mentioned',
  });
});

Deno.test('achievement-kind entries need first-time OR achievement wording', () => {
  // balance bike mentioned, no first / learned wording -> rejected (owner case).
  assertEquals(evaluateMilestoneEvidence('balance-bike', 'Tomás andando en su bici de equilibrio'), {
    ok: false,
    reason: 'no_explicit_language',
  });
  assertEquals(evaluateMilestoneEvidence('balance-bike', 'rode his balance bike at the park').ok, false);

  const kept: Array<[string, string]> = [
    ['balance-bike', 'first ride on the balance bike'],
    ['bike-training-wheels', 'aprendió a andar en bici con ruedas'],
    ['bike-no-training-wheels', 'learned to ride her bike without training wheels'],
    ['bike-no-training-wheels', 'no more training wheels!'],
    ['bike-no-training-wheels', 'ya anda en bici sin ruedas'],
    ['ties-shoelaces', 'tied her shoes by herself'],
    ['crawling', 'ya gatea por toda la casa'],
    ['rolls-over', 'rolled over for the first time'],
    ['sits-up', 'sitting up by himself now'],
    ['swims-unassisted', 'ele já nada sozinho'],
    ['counts-to-ten', 'counted all the way to ten, finally'],
  ];
  for (const [id, quote] of kept) {
    assertEquals(evaluateMilestoneEvidence(id, quote), { ok: true }, `${id}: ${quote}`);
  }
});

Deno.test('entry-specific standalone phrases are accepted without first/achievement words', () => {
  assertEquals(evaluateMilestoneEvidence('potty-trained', 'no more diapers').ok, true);
  assertEquals(evaluateMilestoneEvidence('potty-trained', 'ya no usa pañal').ok, true);
  assertEquals(evaluateMilestoneEvidence('sleeps-through-night', 'slept through the night').ok, true);
  assertEquals(evaluateMilestoneEvidence('last-bottle', 'last time nursing').ok, true);
  assertEquals(evaluateMilestoneEvidence('big-kid-bed', 'sleeping in the big kid bed').ok, true);
  assertEquals(evaluateMilestoneEvidence('first-sentence', 'put two words together').ok, true);
  assertEquals(evaluateMilestoneEvidence('sleeps-through-night', 'slept at grandma\'s house').ok, false);
});

Deno.test('meets-* entries accept explicit meeting wording tied to the subject', () => {
  assertEquals(evaluateMilestoneEvidence('meets-sibling', 'meeting her little brother').ok, true);
  assertEquals(evaluateMilestoneEvidence('meets-grandparents', 'conoció a su abuela').ok, true);
  assertEquals(evaluateMilestoneEvidence('meets-sibling', 'met a friend at the park').ok, false);
});

Deno.test('event entries (birthday, graduation) need the event itself stated', () => {
  assertEquals(evaluateMilestoneEvidence('birthday', 'turned three today').ok, true);
  assertEquals(evaluateMilestoneEvidence('birthday', 'cumple 2').ok, true);
  assertEquals(evaluateMilestoneEvidence('birthday', 'fiesta con globos'), { ok: false, reason: 'event_not_stated' });
  assertEquals(evaluateMilestoneEvidence('graduation', 'graduation day').ok, true);
});

Deno.test('unknown milestone ids never pass', () => {
  assertEquals(evaluateMilestoneEvidence('not-a-milestone', 'first time ever').ok, false);
  assertEquals(verifyMilestoneEvidence('not-a-milestone', 'first time ever', 'first time ever'), {
    ok: false,
    reason: 'unknown_milestone',
  });
});

Deno.test('memoryTextStatesMilestone: sentence windows, no cross-sentence stitching of unrelated words', () => {
  // Explicit first-time haircut sentence -> kept.
  assertEquals(
    memoryTextStatesMilestone('first-haircut', 'Fuimos al parque. Hoy le cortaron el pelo por primera vez. Qué día.').ok,
    true,
  );
  // "first" in one sentence, haircut in a distant sentence -> rejected.
  assertEquals(
    memoryTextStatesMilestone('first-haircut', 'Primera vez que come mango. Fuimos al parque. Luego a la peluquería.').ok,
    false,
  );
  // Plain haircut caption -> rejected.
  assertEquals(memoryTextStatesMilestone('first-haircut', 'Corte de pelo en la barbería').ok, false);
  // Adjacent sentences are allowed to combine ("her first ... / ... the haircut").
  assertEquals(memoryTextStatesMilestone('first-haircut', 'Un día especial: su primera vez. Le cortaron el pelo.').ok, true);
  assertEquals(memoryTextStatesMilestone('first-haircut', null), { ok: false, reason: 'no_evidence' });
});
