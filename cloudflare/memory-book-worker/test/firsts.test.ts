import { describe, expect, it } from 'vitest';
import {
  FIRSTS_MAX_MEMORIES_MULTI_YEAR,
  gateFirstsMilestones,
  hasExplicitFirstLanguage,
  scoreFirstsMemory,
  selectMultiYearFirsts,
  type FirstsMemoryInput,
  type FirstsMilestoneInput,
} from '../src/firsts';

function ms(milestoneId: string, extra: Partial<FirstsMilestoneInput> = {}): FirstsMilestoneInput {
  return { milestoneId, outOfBand: false, ...extra };
}

function mem(id: string, date: string, milestones: FirstsMilestoneInput[], extra: Partial<FirstsMemoryInput> = {}): FirstsMemoryInput {
  return { id, date, photoCount: 0, videoCount: 0, engagementCount: 0, milestones, ...extra };
}

describe('scoreFirstsMemory', () => {
  it('+2 per confirmed milestone, +1 per in-band milestone, +2 once for photo/video', () => {
    expect(scoreFirstsMemory(mem('a', '2024-01-01', [ms('first-steps')]))).toBe(1);
    expect(scoreFirstsMemory(mem('a', '2024-01-01', [ms('first-steps', { status: 'confirmed' })]))).toBe(3);
    expect(scoreFirstsMemory(mem('a', '2024-01-01', [ms('first-steps', { outOfBand: true })]))).toBe(0);
    expect(scoreFirstsMemory(mem('a', '2024-01-01', [ms('first-steps', { outOfBand: true, status: 'confirmed' })]))).toBe(2);
    expect(scoreFirstsMemory(mem('a', '2024-01-01', [ms('x'), ms('y')], { videoCount: 1, photoCount: 3 }))).toBe(4);
  });

  it('missing / null status is a candidate (no confirmation bonus)', () => {
    const noStatus = mem('a', '2024-01-01', [ms('x')]);
    const nullStatus = mem('b', '2024-01-01', [ms('x', { status: null })]);
    const candidate = mem('c', '2024-01-01', [ms('x', { status: 'candidate' })]);
    expect(scoreFirstsMemory(noStatus)).toBe(1);
    expect(scoreFirstsMemory(nullStatus)).toBe(1);
    expect(scoreFirstsMemory(candidate)).toBe(1);
  });

  it('ignores birthday milestones', () => {
    expect(scoreFirstsMemory(mem('a', '2024-01-01', [ms('birthday', { status: 'confirmed' })]))).toBe(0);
  });
});

describe('selectMultiYearFirsts', () => {
  it('caps at 6 (the multi-year constant) and returns chronological ids', () => {
    expect(FIRSTS_MAX_MEMORIES_MULTI_YEAR).toBe(6);
    // 12 memories, 23 milestone rows over 17 distinct ids (some repeated later).
    const memories: FirstsMemoryInput[] = [
      mem('m01', '2023-02-01', [ms('rolling-over'), ms('smiling')], { photoCount: 1 }),
      mem('m02', '2023-03-10', [ms('first-laugh')]),
      mem('m03', '2023-04-02', [ms('sitting-up', { status: 'confirmed' }), ms('first-solid-food')], { videoCount: 1 }),
      mem('m04', '2023-06-15', [ms('crawling', { outOfBand: true })]),
      mem('m05', '2023-08-01', [ms('first-tooth'), ms('first-words', { status: 'confirmed' }), ms('waving')], { photoCount: 2, engagementCount: 3 }),
      mem('m06', '2023-09-09', [ms('pulling-to-stand')]),
      mem('m07', '2023-11-20', [ms('first-steps', { status: 'confirmed' }), ms('clapping')], { photoCount: 1 }),
      mem('m08', '2024-01-05', [ms('first-steps')]), // repeat: not the earliest holder
      mem('m09', '2024-03-03', [ms('first-haircut'), ms('first-swim')], { photoCount: 1 }),
      mem('m10', '2024-06-06', [ms('potty-trained', { status: 'confirmed' }), ms('first-bike'), ms('first-day-of-school')], { videoCount: 1, engagementCount: 5 }),
      mem('m11', '2025-02-02', [ms('rolling-over'), ms('first-laugh')]), // all repeats
      mem('m12', '2025-09-09', [ms('first-bike'), ms('first-swim'), ms('waving')]), // all repeats
    ];
    expect(memories.reduce((n, m) => n + m.milestones.length, 0)).toBe(23);

    const selected = selectMultiYearFirsts(memories);
    expect(selected.length).toBeLessThanOrEqual(6);
    expect(selected.length).toBe(6);

    // Chronological.
    const dateById = new Map(memories.map((m) => [m.id, m.date]));
    const dates = selected.map((id) => dateById.get(id)!);
    expect(dates).toEqual([...dates].sort());

    // Every selected memory is the earliest holder of at least one distinct milestone;
    // pure repeaters (m08, m11, m12) are never selected.
    const earliest = new Map<string, string>();
    for (const m of [...memories].sort((a, b) => a.date.localeCompare(b.date))) {
      for (const milestone of m.milestones) if (!earliest.has(milestone.milestoneId)) earliest.set(milestone.milestoneId, m.id);
    }
    const firstHolders = new Set(earliest.values());
    for (const id of selected) expect(firstHolders.has(id)).toBe(true);
    expect(selected).not.toContain('m08');
    expect(selected).not.toContain('m11');
    expect(selected).not.toContain('m12');
    expect(new Set(selected).size).toBe(selected.length);
  });

  it('keeps the highest-scoring memories (confirmed + media beat bare candidates)', () => {
    const memories = [
      mem('low1', '2023-01-01', [ms('a', { outOfBand: true })]),
      mem('low2', '2023-02-01', [ms('b', { outOfBand: true })]),
      mem('top1', '2023-03-01', [ms('c', { status: 'confirmed' })], { photoCount: 1 }), // 3 + 2 = 5
      mem('top2', '2023-04-01', [ms('d', { status: 'confirmed' })], { videoCount: 1 }), // 5
      mem('mid', '2023-05-01', [ms('e')]), // 1
    ];
    expect(selectMultiYearFirsts(memories, 2)).toEqual(['top1', 'top2']);
  });

  it('ties break on engagement desc, then date asc, then id', () => {
    const memories = [
      mem('a', '2023-03-01', [ms('x')], { engagementCount: 1 }),
      mem('b', '2023-01-01', [ms('y')], { engagementCount: 5 }),
      mem('c', '2023-02-01', [ms('z')], { engagementCount: 5 }),
      mem('d', '2023-02-01', [ms('w')], { engagementCount: 5 }),
    ];
    // All score 1; engagement 5 x3 beat 1; among those, date asc then id asc -> b, c (d cut).
    expect(selectMultiYearFirsts(memories, 2)).toEqual(['b', 'c']);
  });

  it('missing status is treated as a candidate (selection still works with no status field anywhere)', () => {
    const memories = [mem('a', '2023-01-01', [ms('x')]), mem('b', '2023-02-01', [ms('y')])];
    expect(selectMultiYearFirsts(memories)).toEqual(['a', 'b']);
  });

  it('excludes birthday milestones; a birthday-only memory is never a first', () => {
    const memories = [
      mem('bday', '2023-10-17', [ms('birthday', { status: 'confirmed' })], { photoCount: 2 }),
      mem('steps', '2023-11-01', [ms('first-steps'), ms('birthday')]),
    ];
    expect(selectMultiYearFirsts(memories)).toEqual(['steps']);
  });

  it('the earliest memory per milestone wins even when a later memory scores higher', () => {
    const memories = [
      mem('early', '2023-01-01', [ms('first-steps', { outOfBand: true })]),
      mem('later', '2024-01-01', [ms('first-steps', { status: 'confirmed' })], { photoCount: 1 }),
    ];
    expect(selectMultiYearFirsts(memories)).toEqual(['early']);
  });

  it('same-date earliest holders break on id', () => {
    const memories = [
      mem('b', '2023-01-01', [ms('first-steps')]),
      mem('a', '2023-01-01', [ms('first-steps')]),
    ];
    expect(selectMultiYearFirsts(memories)).toEqual(['a']);
  });

  it('no milestones, an empty list or a zero cap -> []', () => {
    expect(selectMultiYearFirsts([])).toEqual([]);
    expect(selectMultiYearFirsts([mem('a', '2023-01-01', [])])).toEqual([]);
    expect(selectMultiYearFirsts([mem('a', '2023-01-01', [ms('x')])], 0)).toEqual([]);
  });

  it('is deterministic regardless of input order', () => {
    const memories = [
      mem('a', '2023-03-01', [ms('x')], { engagementCount: 2 }),
      mem('b', '2023-01-01', [ms('y')], { engagementCount: 2 }),
      mem('c', '2023-02-01', [ms('z')], { engagementCount: 2 }),
    ];
    expect(selectMultiYearFirsts(memories, 2)).toEqual(selectMultiYearFirsts([...memories].reverse(), 2));
  });

  it('does not mutate its input', () => {
    const memories = [mem('b', '2023-02-01', [ms('x')]), mem('a', '2023-01-01', [ms('y')])];
    selectMultiYearFirsts(memories);
    expect(memories.map((m) => m.id)).toEqual(['b', 'a']);
  });
});

describe('hasExplicitFirstLanguage (Phase 2e: explicit-text-only firsts)', () => {
  it.each([
    'Hoy fue su primer corte de pelo',
    'Su primera palabra fue mamá',
    'Los primeros pasos!',
    'Las primeras gotas de lluvia',
    'Lo probó por primera vez',
    'Fue la primera vez que se rió',
    'Ayer, el primer día de escuela',
    'Her first haircut today',
    'It was the first time he walked',
    'He tried it for the first time',
    'Foi o primeiro banho de mar',
    'Ela deu a primeira risada',
    'Provou pela primeira vez',
    'PRIMER CUMPLEAÑOS',
    'PRIMÉR dia',
    'First!',
    'the-first-step',
  ])('matches %j', (text) => {
    expect(hasExplicitFirstLanguage(text)).toBe(true);
  });

  it.each([
    '',
    'Fuimos a cortarnos el pelo',
    'Se subió a la bici sin pedales',
    'Firstborn of the family tree',
    'Firsts and seconds',
    'reprimer imprimer',
    'comprimera',
    'primavera en el parque',
    'Primo Luis vino a verlo',
    'primero fue el helado, luego el parque',
  ])('does not match %j', (text) => {
    expect(hasExplicitFirstLanguage(text)).toBe(false);
  });

  it('null / undefined are not explicit', () => {
    expect(hasExplicitFirstLanguage(null)).toBe(false);
    expect(hasExplicitFirstLanguage(undefined)).toBe(false);
  });
});

describe('gateFirstsMilestones', () => {
  const rows = [
    { milestoneId: 'first-haircut', status: 'candidate' },
    { milestoneId: 'first-steps', status: 'confirmed' },
    { milestoneId: 'first-word' },
  ];
  it('without first-time language only parent-confirmed rows pass', () => {
    expect(gateFirstsMilestones(rows, 'Fuimos a la peluquería').map((m) => m.milestoneId)).toEqual(['first-steps']);
  });
  it('with explicit first-time language in the memory text, every row passes', () => {
    expect(gateFirstsMilestones(rows, 'Su primer corte de pelo').map((m) => m.milestoneId)).toEqual(['first-haircut', 'first-steps', 'first-word']);
  });
  it('no inference from milestone ids: candidate rows with no text never pass', () => {
    expect(gateFirstsMilestones(rows.filter((r) => r.status !== 'confirmed'), null)).toEqual([]);
    expect(gateFirstsMilestones([], 'primer')).toEqual([]);
  });
});
