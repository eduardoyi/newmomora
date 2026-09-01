import { describe, expect, it } from 'vitest';
import { buildAssetsForMemory, buildBookManifest, selectMediaAsset } from '../src/manifest';
import type { DbMediaRow, GenerationContextResponse } from '../src/types';

describe('selectMediaAsset', () => {
  it('prefers preview_object_key and classifies video vs photo', () => {
    const photo: DbMediaRow = { id: '1', memory_id: 'm', object_key: 'raw.jpg', preview_object_key: 'preview.jpg', content_type: 'image/jpeg', position: 0, duration_ms: null, aspect_ratio: 1 };
    expect(selectMediaAsset(photo)).toEqual({ key: 'preview.jpg', kind: 'photo' });

    const video: DbMediaRow = { id: '2', memory_id: 'm', object_key: 'raw.mp4', preview_object_key: 'poster.webp', content_type: 'video/mp4', position: 0, duration_ms: 5000, aspect_ratio: 1.7 };
    expect(selectMediaAsset(video)).toEqual({ key: 'poster.webp', kind: 'video-poster' });
  });

  it('falls back to the raw key only for an eligible photo content type', () => {
    const jpeg: DbMediaRow = { id: '1', memory_id: 'm', object_key: 'raw.jpg', preview_object_key: null, content_type: 'image/jpeg', position: 0, duration_ms: null, aspect_ratio: null };
    expect(selectMediaAsset(jpeg)).toEqual({ key: 'raw.jpg', kind: 'photo' });

    const heic: DbMediaRow = { id: '2', memory_id: 'm', object_key: 'raw.heic', preview_object_key: null, content_type: 'image/heic', position: 0, duration_ms: null, aspect_ratio: null };
    expect(selectMediaAsset(heic)).toBeNull();
  });
});

describe('buildAssetsForMemory', () => {
  it('orders by position and honors the real DB aspect ratio', () => {
    const media: DbMediaRow[] = [
      { id: '2', memory_id: 'm', object_key: 'b.jpg', preview_object_key: 'b-preview.jpg', content_type: 'image/jpeg', position: 1, duration_ms: null, aspect_ratio: 2 },
      { id: '1', memory_id: 'm', object_key: 'a.jpg', preview_object_key: 'a-preview.jpg', content_type: 'image/jpeg', position: 0, duration_ms: null, aspect_ratio: 0.5 },
    ];
    const assets = buildAssetsForMemory(media);
    expect(assets.map((a) => a.file)).toEqual(['a-preview.jpg', 'b-preview.jpg']);
    expect(assets[0].aspectRatio).toBe(0.5);
    expect(assets[1].aspectRatio).toBe(2);
    // No downloaded bytes in V5a -- originalWidth/Height are never set.
    expect(assets[0].originalWidth).toBeUndefined();
  });
});

function baseContext(overrides: Partial<GenerationContextResponse> = {}): GenerationContextResponse {
  return {
    book: {
      id: 'book-1',
      familyId: 'family-1',
      childId: 'child-1',
      scopeKind: 'age_year',
      windowStart: '2024-10-23',
      windowEndExclusive: '2025-10-23',
      scopeLabel: 'Year One',
      pageBudget: 60,
    },
    child: { id: 'child-1', name: 'Enzo', dateOfBirth: '2024-10-23' },
    familyName: 'The Rivas Family',
    configuredLanguage: 'en',
    memories: [],
    media: [],
    tags: [],
    milestones: [],
    engagementCounts: {},
    familyMembers: [],
    portraitVersions: [],
    languageEvidenceCaptions: [],
    ...overrides,
  };
}

describe('buildBookManifest', () => {
  it('assembles a memory with assets, milestones, tagged members, and engagement', () => {
    const context = baseContext({
      memories: [
        { id: 'mem-1', content: 'First splash!', memory_date: '2025-01-01', memory_type: 'photo', emotion: 'joy', topics: ['pool-water'], topic_details: {}, illustration_key: null },
      ],
      media: [
        { id: 'a1', memory_id: 'mem-1', object_key: 'raw.jpg', preview_object_key: 'preview.jpg', content_type: 'image/jpeg', position: 0, duration_ms: null, aspect_ratio: 1.4 },
      ],
      tags: [{ memory_id: 'mem-1', family_member_id: 'child-1' }],
      milestones: [{ memory_id: 'mem-1', family_member_id: 'child-1', milestone_id: 'first-steps', detail: null, out_of_band: false }],
      engagementCounts: { 'mem-1': 2 },
      familyMembers: [{ id: 'child-1', name: 'Enzo', date_of_birth: '2024-10-23', nicknames: ['Enzito'] }],
    });

    const manifest = buildBookManifest({
      context,
      memoryIds: ['mem-1'],
      outlineRunId: 'run-1',
      language: 'en',
      shareTokensByMemoryId: new Map(),
    });

    const memory = manifest.memories['mem-1'];
    expect(memory).toBeDefined();
    expect(memory.text).toBe('First splash!');
    expect(memory.engagement).toBe(2);
    expect(memory.assets).toHaveLength(1);
    expect(memory.assets[0].file).toBe('preview.jpg');
    expect(memory.milestones).toEqual([{ id: 'first-steps', name: expect.any(String), detail: null }]);
    expect(memory.taggedMembers).toEqual([{ name: 'Enzo', isChild: true }]);
    expect(memory.shareToken).toBeNull();
    expect(manifest.child).toEqual({ id: 'child-1', name: 'Enzo' });
    expect(manifest.scope.kind).toBe('age-year');
    expect(manifest.outlineRun).toBe('run-1');
  });

  it('assigns a share token only to a QR-eligible memory (audio, or media with a video asset)', () => {
    const context = baseContext({
      memories: [
        { id: 'audio-1', content: null, memory_date: '2025-01-01', memory_type: 'audio', emotion: null, topics: [], topic_details: {}, illustration_key: null },
        { id: 'photo-1', content: null, memory_date: '2025-01-02', memory_type: 'photo', emotion: null, topics: [], topic_details: {}, illustration_key: null },
      ],
    });
    const manifest = buildBookManifest({
      context,
      memoryIds: ['audio-1', 'photo-1'],
      outlineRunId: 'run-1',
      language: 'en',
      shareTokensByMemoryId: new Map([['audio-1', 'tok-123'], ['photo-1', 'tok-456']]),
    });
    expect(manifest.memories['audio-1'].shareToken).toBe('tok-123');
    // photo-only memory is never QR-eligible, even if a token happens to be
    // in the map -- memoryNeedsShareToken gates it.
    expect(manifest.memories['photo-1'].shareToken).toBeNull();
  });

  it('falls back to the family as the "child" when the book has no child_id', () => {
    const context = baseContext({ child: null, book: { ...baseContext().book, childId: null, scopeKind: 'everything' } });
    const manifest = buildBookManifest({ context, memoryIds: [], outlineRunId: 'run-1', language: 'en', shareTokensByMemoryId: new Map() });
    expect(manifest.child).toEqual({ id: 'family-1', name: 'The Rivas Family' });
  });
});
