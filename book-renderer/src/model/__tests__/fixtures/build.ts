import type { BookManifest, BookOutline, ManifestAsset, ManifestMemory, OutlineElement } from '../../types';

let assetCounter = 0;

export function makeAsset(overrides: Partial<ManifestAsset> = {}): ManifestAsset {
  assetCounter += 1;
  return {
    // Contract: manifest `file` values already include the `assets/` prefix
    // (see loader.ts assetUrl) — fixtures mirror that so tests catch a
    // regression to the double-prefixed-URL bug.
    file: `assets/asset-${assetCounter}.jpg`,
    width: 2400,
    height: 1600,
    aspectRatio: 1.5,
    kind: 'photo',
    durationMs: null,
    ...overrides,
  };
}

export function makeMemory(overrides: Partial<ManifestMemory> = {}): ManifestMemory {
  return {
    date: '2024-06-01',
    type: 'photo',
    text: null,
    emotion: null,
    topics: [],
    milestones: [],
    engagement: 0,
    taggedMembers: [],
    assets: [],
    illustration: null,
    ...overrides,
  };
}

export function makeManifest(
  memories: Record<string, ManifestMemory>,
  overrides: Partial<BookManifest> = {},
): BookManifest {
  return {
    child: { id: 'child-1', name: 'Test Child' },
    scope: { kind: 'age-year', label: 'Year One', start: '2024-01-01', end: '2024-12-31' },
    generatedAt: '2026-01-01T00:00:00.000Z',
    outlineRun: 'test-run',
    memories,
    portraits: [],
    ...overrides,
  };
}

export function makeElement(overrides: Partial<OutlineElement> & Pick<OutlineElement, 'id' | 'kind'>): OutlineElement {
  return {
    title: overrides.id,
    memoryIds: [],
    rationale: {},
    ...overrides,
  };
}

export function makeOutline(elements: OutlineElement[], overrides: Partial<BookOutline> = {}): BookOutline {
  return {
    runId: 'test-run',
    child: { id: 'child-1', name: 'Test Child' },
    scope: { type: 'age-year', ageYear: 1 },
    window: { start: '2024-01-01', endExclusive: '2025-01-01', label: 'Year One' },
    pageEstimate: 10,
    pageBudget: 20,
    counts: {},
    elements,
    editorialNote: 'Test editorial note.',
    integrity: {
      violations: [],
      reassignments: [],
      dissolvedSpreadIds: [],
      dissolvedBirthdayAges: [],
      movedToBackbone: [],
      droppedElements: [],
      excludedMemoryIds: [],
    },
    ...overrides,
  };
}
