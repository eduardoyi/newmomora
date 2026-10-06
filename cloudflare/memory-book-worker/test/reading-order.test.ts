import { describe, expect, it } from 'vitest';
import {
  buildReadingOrder,
  dissolveSmallThemedSpreads,
  dissolveThinBirthdaySpreads,
  enforceThemedSpreadSpacing,
  resolveSinglePlacement,
} from '../src/reading-order';

describe('resolveSinglePlacement', () => {
  it('keeps a multi-candidate memory in the spread with the fewest INITIAL members', () => {
    // spread "big" starts with 5 members, spread "small" with 2 -- memory
    // "shared" is a candidate for both; scarcity keeps it in "small".
    const candidates = [
      { memoryId: 'shared', spreadId: 'big' },
      { memoryId: 'shared', spreadId: 'small' },
      { memoryId: 'b1', spreadId: 'big' },
      { memoryId: 'b2', spreadId: 'big' },
      { memoryId: 'b3', spreadId: 'big' },
      { memoryId: 'b4', spreadId: 'big' },
      { memoryId: 's1', spreadId: 'small' },
    ];
    const { placementByMemory, reassignments } = resolveSinglePlacement(candidates);
    expect(placementByMemory.get('shared')).toBe('small');
    expect(reassignments).toEqual([{ memoryId: 'shared', droppedFrom: ['big'], keptIn: 'small' }]);
  });

  it('breaks a tie on spreadId ascending', () => {
    const candidates = [
      { memoryId: 'shared', spreadId: 'zzz' },
      { memoryId: 'shared', spreadId: 'aaa' },
    ];
    const { placementByMemory } = resolveSinglePlacement(candidates);
    expect(placementByMemory.get('shared')).toBe('aaa');
  });

  it('places a single-candidate memory directly, no reassignment recorded', () => {
    const { placementByMemory, reassignments } = resolveSinglePlacement([{ memoryId: 'a', spreadId: 'only' }]);
    expect(placementByMemory.get('a')).toBe('only');
    expect(reassignments).toEqual([]);
  });
});

describe('dissolveSmallThemedSpreads', () => {
  it('moves every member of an undersized spread back to its own default backbone segment', () => {
    const placement = new Map([
      ['a', 'topic:beach'],
      ['b', 'topic:beach'],
      ['c', 'backbone:2025-01'],
    ]);
    const defaultBackbone = new Map([
      ['a', 'backbone:2025-01'],
      ['b', 'backbone:2025-02'],
    ]);
    const result = dissolveSmallThemedSpreads(placement, new Set(['topic:beach']), defaultBackbone, 3);
    expect(result.dissolvedSpreadIds).toEqual(['topic:beach']);
    expect(result.placementByMemory.get('a')).toBe('backbone:2025-01');
    expect(result.placementByMemory.get('b')).toBe('backbone:2025-02');
    expect(result.movedToBackbone).toHaveLength(2);
  });

  it('leaves a spread at or above the minimum size untouched', () => {
    const placement = new Map([['a', 'topic:beach'], ['b', 'topic:beach'], ['c', 'topic:beach']]);
    const result = dissolveSmallThemedSpreads(placement, new Set(['topic:beach']), new Map(), 3);
    expect(result.dissolvedSpreadIds).toEqual([]);
  });
});

describe('dissolveThinBirthdaySpreads', () => {
  it('parses the age back out of the birthday-N spread id when dissolving', () => {
    const placement = new Map([['a', 'birthday-1'], ['b', 'birthday-1']]);
    const defaultBackbone = new Map([['a', 'backbone:2025-10'], ['b', 'backbone:2025-10']]);
    const result = dissolveThinBirthdaySpreads(placement, new Set(['birthday-1']), defaultBackbone, 3);
    expect(result.dissolvedAges).toEqual([1]);
    expect(result.placementByMemory.get('a')).toBe('backbone:2025-10');
  });
});

describe('enforceThemedSpreadSpacing', () => {
  it('never lets two spreads share the same gap -- higher member count wins the contested gap', () => {
    const assignment = enforceThemedSpreadSpacing(
      [
        { id: 'small', memberCount: 3, anchorGap: 1 },
        { id: 'large', memberCount: 6, anchorGap: 1 },
      ],
      3,
    );
    expect(assignment.get('large')).toBe(1);
    expect(assignment.get('small')).not.toBe(1);
  });

  it('clamps an out-of-range anchor into the valid gap range', () => {
    const assignment = enforceThemedSpreadSpacing([{ id: 'a', memberCount: 4, anchorGap: 99 }], 2);
    expect(assignment.get('a')).toBe(2);
  });
});

describe('buildReadingOrder', () => {
  it('assembles the fixed structural pages, birthday-by-age, spacing, backbone, and firsts-at-the-end', () => {
    const sections = buildReadingOrder({
      childName: 'Tomás',
      finalBackboneSegments: [
        { id: '2025-01', label: 'January 2025', monthKeys: ['2025-01'], memoryIds: ['m1', 'm2'] },
        { id: '2025-02', label: 'February 2025', monthKeys: ['2025-02'], memoryIds: ['m3'] },
      ],
      firsts: { present: true, title: 'Big and small victories', memoryIds: ['m4'], warmNames: [] },
      birthdaySpreads: [{ ageTurned: 1, memoryIds: ['m5', 'm6', 'm7'] }],
      themedSpreads: [
        {
          candidateId: 'topic:beach',
          candidateKind: 'topic',
          title: 'A day at the beach',
          titleMode: 'descriptive',
          titleSourceMemoryId: null,
          memoryIds: ['m8', 'm9', 'm10'],
          insertAfterFinalSegmentIndex: 0,
          rationale: {},
          kicker: null,
        },
      ],
      backboneRationale: {},
      specialSegmentTitles: {},
    });

    const kinds = sections.map((s) => s.kind);
    expect(kinds).toEqual(['cover', 'title', 'through-the-years', 'birthday', 'backbone', 'themed', 'backbone', 'firsts', 'closing']);
    expect(sections[sections.length - 1].id).toBe('closing');
    expect(sections.find((s) => s.kind === 'firsts')?.memoryIds).toEqual(['m4']);
  });

  it('uses a special segment title as the title, keeping the plain label as a subtitle', () => {
    const sections = buildReadingOrder({
      childName: 'Tomás',
      finalBackboneSegments: [{ id: '2024-10', label: 'October 2024', monthKeys: ['2024-10'], memoryIds: ['m1'] }],
      firsts: null,
      birthdaySpreads: [],
      themedSpreads: [],
      backboneRationale: {},
      specialSegmentTitles: { '2024-10': 'Welcome to the world' },
    });
    const backbone = sections.find((s) => s.kind === 'backbone');
    expect(backbone?.title).toBe('Welcome to the world');
    expect(backbone?.subtitle).toBe('October 2024');
  });

  it('omits the firsts section entirely when not present', () => {
    const sections = buildReadingOrder({
      childName: 'Tomás',
      finalBackboneSegments: [],
      firsts: null,
      birthdaySpreads: [],
      themedSpreads: [],
      backboneRationale: {},
    });
    expect(sections.some((s) => s.kind === 'firsts')).toBe(false);
  });
});

describe('buildReadingOrder — chapters (Everything)', () => {
  const chapters = [
    { ageYear: 1, startMonth: '2022-10', endMonth: '2023-10' },
    { ageYear: 2, startMonth: '2023-11', endMonth: '2024-10' },
    { ageYear: 3, startMonth: '2024-11', endMonth: '2025-10' },
  ];
  const segments = [
    { id: '2023-01_2023-03', label: 'January–March 2023', monthKeys: ['2023-01', '2023-02', '2023-03'], memoryIds: ['a'], chapterIndex: 0 },
    { id: '2023-04_2023-06', label: 'April–June 2023', monthKeys: ['2023-04', '2023-06'], memoryIds: ['b'], chapterIndex: 0 },
    { id: '2024-01', label: 'January 2024', monthKeys: ['2024-01'], memoryIds: ['c'], chapterIndex: 1 },
    { id: '2025-02', label: 'February 2025', monthKeys: ['2025-02'], memoryIds: ['d'], chapterIndex: 2 },
  ];
  const themed = (id: string, gap: number) => ({
    candidateId: id,
    candidateKind: 'topic' as const,
    title: id,
    titleMode: 'descriptive' as const,
    titleSourceMemoryId: null,
    memoryIds: ['t1', 't2', 't3'],
    insertAfterFinalSegmentIndex: gap,
    rationale: {},
    kicker: null,
  });
  const base = {
    childName: 'Tomás',
    finalBackboneSegments: segments,
    firsts: null,
    birthdaySpreads: [],
    backboneRationale: {},
  };

  it('emits chapter openers before each chapter\'s first segment, chapter 1 before the gap -1 themed spread, later ones after the previous gap\'s spread', () => {
    const sections = buildReadingOrder({
      ...base,
      chapters,
      themedSpreads: [themed('topic:beach', -1), themed('topic:friends', 1), themed('topic:travel', 3)],
    });
    expect(sections.map((s) => s.id)).toEqual([
      'cover', 'title', 'through-the-years',
      'chapter:1', 'topic:beach',
      'backbone:2023-01_2023-03', 'backbone:2023-04_2023-06', 'topic:friends',
      'chapter:2', 'backbone:2024-01',
      'chapter:3', 'backbone:2025-02', 'topic:travel',
      'closing',
    ]);
  });

  it('chapter element shape: id, kind, English fallback title, month-range subtitle from the actual content, empty memoryIds, chapter meta', () => {
    const sections = buildReadingOrder({ ...base, chapters, themedSpreads: [] });
    const chapterSections = sections.filter((s) => s.kind === 'chapter');
    expect(chapterSections).toEqual([
      { id: 'chapter:1', kind: 'chapter', title: 'Year One', subtitle: 'January–June 2023', memoryIds: [], rationale: {}, chapter: { ageYear: 1, startMonth: '2022-10', endMonth: '2023-10' } },
      { id: 'chapter:2', kind: 'chapter', title: 'Year Two', subtitle: 'January 2024', memoryIds: [], rationale: {}, chapter: { ageYear: 2, startMonth: '2023-11', endMonth: '2024-10' } },
      { id: 'chapter:3', kind: 'chapter', title: 'Year Three', subtitle: 'February 2025', memoryIds: [], rationale: {}, chapter: { ageYear: 3, startMonth: '2024-11', endMonth: '2025-10' } },
    ]);
  });

  it('uses "Year N" past ten', () => {
    const sections = buildReadingOrder({
      ...base,
      finalBackboneSegments: [{ ...segments[0], chapterIndex: 0 }],
      chapters: [{ ageYear: 11, startMonth: '2033-01', endMonth: '2033-12' }],
      themedSpreads: [],
    });
    expect(sections.find((s) => s.kind === 'chapter')?.title).toBe('Year 11');
  });

  it('emits no chapter sections without `chapters` (even when segments carry chapterIndex)', () => {
    const sections = buildReadingOrder({ ...base, themedSpreads: [themed('topic:beach', 0)] });
    expect(sections.some((s) => s.kind === 'chapter')).toBe(false);
  });

  it('multiYear swaps the default Firsts title (an AI title still wins)', () => {
    const firsts = (title: string | null) => ({ present: true, title, memoryIds: ['f1'], warmNames: [] });
    const get = (input: Parameters<typeof buildReadingOrder>[0]) => buildReadingOrder(input).find((s) => s.kind === 'firsts')?.title;
    expect(get({ ...base, themedSpreads: [], firsts: firsts(null) })).toBe('Big and small victories this year');
    expect(get({ ...base, themedSpreads: [], firsts: firsts(null), multiYear: true })).toBe('Big and small victories');
    expect(get({ ...base, themedSpreads: [], firsts: firsts('Mis primeras veces'), multiYear: true })).toBe('Mis primeras veces');
  });
});

