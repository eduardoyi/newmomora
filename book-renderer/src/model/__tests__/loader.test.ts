import { afterEach, describe, expect, it } from 'vitest';
import redactedOutlineJson from './fixtures/redacted-outline.json';
import { parseOutline, parseManifest, resolveElementMemories, BookDataError, assetUrl, setAssetUrlProvider } from '../loader';
import { makeManifest, makeMemory } from './fixtures/build';

describe('parseOutline', () => {
  it('parses the real outline.json shape (redacted fixture)', () => {
    const outline = parseOutline(redactedOutlineJson);
    expect(outline.elements).toHaveLength(8);
    expect(outline.elements.map((e) => e.kind)).toEqual([
      'cover',
      'title',
      'through-the-years',
      'backbone',
      'themed',
      'themed',
      'firsts',
      'closing',
    ]);
  });

  it('preserves backbone subtitle and themed title-mode fields', () => {
    const outline = parseOutline(redactedOutlineJson);
    const backbone = outline.elements.find((e) => e.id === 'backbone:2024-01_2024-02')!;
    expect(backbone.subtitle).toBe('January-February 2024');

    const quoteSpread = outline.elements.find((e) => e.id === 'emotion:funny')!;
    expect(quoteSpread.titleMode).toBe('quote');
    expect(quoteSpread.titleSourceMemoryId).toBe('redacted-mem-3');
    expect(quoteSpread.spreadType).toBe('emotion');

    const descriptiveSpread = outline.elements.find((e) => e.id === 'topic:example')!;
    expect(descriptiveSpread.titleMode).toBe('descriptive');
    expect(descriptiveSpread.titleSourceMemoryId).toBeNull();
  });

  it('preserves the integrity block (reassignments, exclusions)', () => {
    const outline = parseOutline(redactedOutlineJson);
    expect(outline.integrity.reassignments).toHaveLength(1);
    expect(outline.integrity.excludedMemoryIds[0].reason).toBe('over_budget_backbone_not_selected');
  });

  it('rejects an outline missing elements[]', () => {
    expect(() => parseOutline({})).toThrow(BookDataError);
  });

  it('rejects an outline element missing memoryIds', () => {
    expect(() =>
      parseOutline({ elements: [{ id: 'x', kind: 'backbone' }] }),
    ).toThrow(BookDataError);
  });

  it('parses coverCandidates when present (owner review 2026-08-31, cover-safety fix)', () => {
    const outline = parseOutline({ elements: [], coverCandidates: ['mem-1', 'mem-2'] });
    expect(outline.coverCandidates).toEqual(['mem-1', 'mem-2']);
  });

  it('tolerates a missing coverCandidates -- old outlines predate the field', () => {
    const outline = parseOutline({ elements: [] });
    expect(outline.coverCandidates).toBeUndefined();
  });

  it('rejects a present-but-malformed coverCandidates', () => {
    expect(() => parseOutline({ elements: [], coverCandidates: 'not-an-array' })).toThrow(BookDataError);
  });
});

describe('parseManifest', () => {
  it('accepts a well-formed manifest', () => {
    const manifest = makeManifest({ 'mem-1': makeMemory() });
    expect(() => parseManifest(manifest)).not.toThrow();
  });

  it('rejects a manifest missing child identity', () => {
    expect(() => parseManifest({ memories: {}, portraits: [] })).toThrow(BookDataError);
  });

  it('rejects a manifest with a non-array portraits field', () => {
    expect(() =>
      parseManifest({ child: { id: 'c', name: 'C' }, memories: {}, portraits: 'nope' }),
    ).toThrow(BookDataError);
  });

  it('passes an asset\'s originalFile through untouched (memory-book-5c plan, Design Decision 1 -- data contract addition, no shape validation needed for an optional field)', () => {
    const manifest = makeManifest({
      'mem-1': makeMemory({ assets: [{ file: 'assets/preview.jpg', width: 1280, height: 960, aspectRatio: 1.33, kind: 'photo', durationMs: null, originalFile: 'assets/original.jpg' }] }),
    });
    const parsed = parseManifest(manifest);
    expect(parsed.memories['mem-1'].assets[0].originalFile).toBe('assets/original.jpg');
  });

  it('tolerates a manifest whose assets omit originalFile -- old manifests predate the field', () => {
    const manifest = makeManifest({ 'mem-1': makeMemory({ assets: [{ file: 'assets/preview.jpg', width: 1280, height: 960, aspectRatio: 1.33, kind: 'photo', durationMs: null }] }) });
    const parsed = parseManifest(manifest);
    expect(parsed.memories['mem-1'].assets[0].originalFile).toBeUndefined();
  });
});

describe('resolveElementMemories', () => {
  it('skips memory ids the manifest export dropped', () => {
    const manifest = makeManifest({ 'mem-1': makeMemory({ text: 'hi' }) });
    const resolved = resolveElementMemories(manifest, {
      id: 'x',
      kind: 'backbone',
      title: 'x',
      memoryIds: ['mem-1', 'missing-mem'],
      rationale: {},
    });
    expect(resolved).toHaveLength(1);
    expect(resolved[0].id).toBe('mem-1');
  });
});

describe('assetUrl', () => {
  it('resolves a contract-shaped manifest file value (already prefixed with assets/) to a URL with exactly one assets/ segment', () => {
    // manifest.memories[].assets[].file and manifest.portraits[].file both
    // already include the `assets/` prefix per the data-export contract —
    // assetUrl must NOT add a second one (that 404s as /slug/assets/assets/x.jpg).
    const url = assetUrl('sample', 'assets/photo.jpg');
    expect(url).toBe('/sample/assets/photo.jpg');
    expect(url.match(/assets\//g)).toHaveLength(1);
  });

  it('does not assume a bare filename needs assets/ inserted', () => {
    // If a caller ever passes a bare filename (no prefix), assetUrl must not
    // silently "fix" it — that would mask a real contract violation upstream.
    expect(assetUrl('sample', 'photo.jpg')).toBe('/sample/photo.jpg');
  });
});

describe('assetUrl provider (Design Decision 8, memory-book-5b plan)', () => {
  afterEach(() => {
    // Module-level state — always leave it at the default for every other
    // test in this process (print/preview entries never call the setter,
    // so leaking a custom provider would be a silent cross-test bug).
    setAssetUrlProvider(null);
  });

  it('defaults to the static behavior when no provider has been set', () => {
    expect(assetUrl('sample', 'assets/photo.jpg')).toBe('/sample/assets/photo.jpg');
  });

  it('routes through a custom provider once one is set', () => {
    setAssetUrlProvider((bookSlug, file) => `https://cdn.example.com/${bookSlug}/${file}?sig=abc`);
    expect(assetUrl('sample', 'assets/photo.jpg')).toBe('https://cdn.example.com/sample/assets/photo.jpg?sig=abc');
  });

  it('restores the static default when the provider is cleared with null', () => {
    setAssetUrlProvider((bookSlug, file) => `custom/${bookSlug}/${file}`);
    setAssetUrlProvider(null);
    expect(assetUrl('sample', 'assets/photo.jpg')).toBe('/sample/assets/photo.jpg');
  });
});
