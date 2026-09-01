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
      childName: 'Enzo',
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
      childName: 'Enzo',
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
      childName: 'Enzo',
      finalBackboneSegments: [],
      firsts: null,
      birthdaySpreads: [],
      themedSpreads: [],
      backboneRationale: {},
    });
    expect(sections.some((s) => s.kind === 'firsts')).toBe(false);
  });
});
