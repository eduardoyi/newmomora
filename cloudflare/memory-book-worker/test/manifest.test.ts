import { describe, expect, it } from 'vitest';
import { buildManifestAsset } from '../../../supabase/functions/_shared/memory-book-manifest.ts';
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
    // No dimensions map passed -- originalWidth/Height stay unset, same as
    // a real eval-CLI measurement failure (never fabricated).
    expect(assets[0].originalWidth).toBeUndefined();
  });

  it('sets originalWidth/originalHeight from the dimensions map, keyed by memory_media.id', () => {
    const media: DbMediaRow[] = [
      { id: 'media-1', memory_id: 'm', object_key: 'a.jpg', preview_object_key: 'a-preview.jpg', content_type: 'image/jpeg', position: 0, duration_ms: null, aspect_ratio: 1.33 },
    ];
    const assets = buildAssetsForMemory(media, { 'media-1': { width: 4032, height: 3024 } });
    expect(assets[0].originalWidth).toBe(4032);
    expect(assets[0].originalHeight).toBe(3024);
  });

  it('never sets originalWidth/originalHeight on a video-poster asset, even if the map has an entry for its id', () => {
    // Defensive: a real caller (dimensions.ts's own content-type filter,
    // plus workflow.ts only building jobs for selectMediaAsset(...).kind
    // === 'photo') should never produce this, but buildAssetsForMemory
    // itself must not trust the map blindly -- a video-poster's
    // `object_key` is the ORIGINAL VIDEO file, never a measurable image.
    const media: DbMediaRow[] = [
      { id: 'media-1', memory_id: 'm', object_key: 'raw.mp4', preview_object_key: 'poster.webp', content_type: 'video/mp4', position: 0, duration_ms: 4000, aspect_ratio: 1.78 },
    ];
    const assets = buildAssetsForMemory(media, { 'media-1': { width: 1920, height: 1080 } });
    expect(assets[0].kind).toBe('video-poster');
    expect(assets[0].originalWidth).toBeUndefined();
    expect(assets[0].originalHeight).toBeUndefined();
  });

  it('manifest parity: a measured photo asset matches buildManifestAsset\'s own preview-mode shape exactly', () => {
    // Locks in that this worker's manifest asset entries are semantically
    // identical to a PREVIEW-mode eval export on the originalWidth/
    // originalHeight field -- not a re-derived or approximated value, the
    // SAME buildManifestAsset call the eval CLI itself makes, with the SAME
    // params (see eval-memory-book-assets.ts's own buildManifestAsset call
    // in its media-job loop).
    const row: DbMediaRow = { id: 'media-1', memory_id: 'm', object_key: 'a.jpg', preview_object_key: 'a-preview.jpg', content_type: 'image/jpeg', position: 0, duration_ms: null, aspect_ratio: 1.33 };
    const measured = { width: 4032, height: 3024 };

    const [fromWorker] = buildAssetsForMemory([row], { 'media-1': measured });
    const expected = buildManifestAsset({
      file: 'a-preview.jpg',
      width: 1280,
      height: Math.round(1280 / 1.33),
      kind: 'photo',
      durationMs: null,
      dbAspectRatio: 1.33,
      originalDimensions: measured,
    });

    expect(fromWorker).toEqual(expected);
    expect(fromWorker.originalWidth).toBe(4032);
    expect(fromWorker.originalHeight).toBe(3024);
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

  it('assigns a share token to a media memory carrying a video-poster asset (share-token audit)', () => {
    // Closes the audit gap: a "keep the sound"/video memory (memory_type
    // 'media' with a video-poster asset -- the canary's 29 video-poster
    // assets) must get its QR scan-mark token wired all the way through,
    // same as an audio memory. workflow.ts's own shareTokenCandidateIds
    // filter (memory_type === 'media') is what actually requests this
    // token from the bridge; this test locks in the manifest-assembly half
    // of that path -- memoryNeedsShareToken correctly reads it back off the
    // assets buildAssetsForMemory produced, not off a separate content-type
    // check that could drift out of sync.
    const context = baseContext({
      memories: [
        { id: 'media-1', content: null, memory_date: '2025-01-01', memory_type: 'media', emotion: null, topics: [], topic_details: {}, illustration_key: null },
      ],
      media: [
        { id: 'mm-1', memory_id: 'media-1', object_key: 'clip.mp4', preview_object_key: 'poster.webp', content_type: 'video/mp4', position: 0, duration_ms: 8000, aspect_ratio: 1.78 },
      ],
    });
    const manifest = buildBookManifest({
      context,
      memoryIds: ['media-1'],
      outlineRunId: 'run-1',
      language: 'en',
      shareTokensByMemoryId: new Map([['media-1', 'tok-video']]),
    });
    expect(manifest.memories['media-1'].assets).toEqual([expect.objectContaining({ kind: 'video-poster' })]);
    expect(manifest.memories['media-1'].shareToken).toBe('tok-video');
  });

  it('falls back to the family as the "child" when the book has no child_id', () => {
    const context = baseContext({ child: null, book: { ...baseContext().book, childId: null, scopeKind: 'everything' } });
    const manifest = buildBookManifest({ context, memoryIds: [], outlineRunId: 'run-1', language: 'en', shareTokensByMemoryId: new Map() });
    expect(manifest.child).toEqual({ id: 'family-1', name: 'The Rivas Family' });
  });
});
