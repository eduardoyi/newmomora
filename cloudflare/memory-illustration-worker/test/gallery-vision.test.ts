import { describe, expect, it } from 'vitest';

import { GalleryVisionError, buildGalleryCurationPrompt, validateGalleryVisionOutput } from '../src/gallery-vision';
import type { GalleryClusterInput, GalleryVisionValidationFailure } from '../src/types';

function captureValidationFailure(value: unknown, cluster: GalleryClusterInput): GalleryVisionError {
  try {
    validateGalleryVisionOutput(value, cluster);
  } catch (error) {
    if (error instanceof GalleryVisionError) return error;
    throw error;
  }
  throw new Error('expected validateGalleryVisionOutput to throw');
}

const cluster: GalleryClusterInput = {
  clusterSignature: 'a'.repeat(64), clusterStartDate: '2026-07-01', clusterEndDate: '2026-07-03',
  assets: [
    { assetToken: '123e4567-e89b-42d3-a456-426614174001', previewKey: 'one', expectedByteLength: 1, expectedSha256: 'a'.repeat(64), expectedContentType: 'image/jpeg', previewWidth: 1, previewHeight: 1, captureDate: '2026-07-01', width: 4_032, height: 3_024, isFavorite: false },
    { assetToken: '123e4567-e89b-42d3-a456-426614174002', previewKey: 'two', expectedByteLength: 1, expectedSha256: 'b'.repeat(64), expectedContentType: 'image/jpeg', previewWidth: 1, previewHeight: 1, captureDate: '2026-07-02', width: 4_032, height: 3_024, isFavorite: false },
  ],
};

describe('gallery vision schema validation', () => {
  it('allows only complete, bounded groups based on supplied opaque tokens', () => {
    expect(validateGalleryVisionOutput({
      groups: [{ caption: 'A quiet afternoon together.', selected_asset_tokens: [cluster.assets[0].assetToken], memory_date: '2026-07-02', emotion: 'joy', confidence: 0.82 }],
      skip_reason: null,
    }, cluster)).toEqual(expect.objectContaining({ groups: [expect.objectContaining({ emotion: 'joy' })] }));
  });

  it('rejects groups that reuse a token, invent an asset, or date outside the event', () => {
    const invalid = {
      groups: [
        { caption: 'One.', selected_asset_tokens: [cluster.assets[0].assetToken], memory_date: '2026-07-02', emotion: null, confidence: 0.5 },
        { caption: 'Two.', selected_asset_tokens: [cluster.assets[0].assetToken], memory_date: '2026-07-02', emotion: null, confidence: 0.5 },
      ], skip_reason: null,
    };
    expect(() => validateGalleryVisionOutput(invalid, cluster)).toThrow(GalleryVisionError);
    expect(() => validateGalleryVisionOutput({
      groups: [{ caption: 'No.', selected_asset_tokens: ['invented'], memory_date: '2026-08-01', emotion: null, confidence: 0.5 }], skip_reason: null,
    }, cluster)).toThrow(GalleryVisionError);
  });

  it('rejects calendar-impossible dates even when their text falls inside the cluster range', () => {
    const broadCluster = { ...cluster, clusterStartDate: '2026-02-01', clusterEndDate: '2026-03-03' };
    expect(() => validateGalleryVisionOutput({
      groups: [{ caption: 'No.', selected_asset_tokens: [cluster.assets[0].assetToken], memory_date: '2026-02-31', emotion: null, confidence: 0.5 }],
      skip_reason: null,
    }, broadCluster)).toThrow(GalleryVisionError);
  });

  it('rejects unknown schema fields and non-taxonomy emotions', () => {
    const candidate = {
      caption: 'No.', selected_asset_tokens: [cluster.assets[0].assetToken], memory_date: '2026-07-02', emotion: 'excited', confidence: 0.5,
    };
    expect(() => validateGalleryVisionOutput({ groups: [candidate], skip_reason: null }, cluster)).toThrow(GalleryVisionError);
    expect(() => validateGalleryVisionOutput({ groups: [{ ...candidate, emotion: null, invented: true }], skip_reason: null }, cluster)).toThrow(GalleryVisionError);
    expect(() => validateGalleryVisionOutput({ groups: [{ ...candidate, emotion: null }], skip_reason: null, commentary: 'extra' }, cluster)).toThrow(GalleryVisionError);
  });

  it('turns an empty valid response into a closed no-candidate outcome', () => {
    expect(validateGalleryVisionOutput({ groups: [], skip_reason: null }, cluster)).toEqual({ groups: [], skipReason: 'no_candidate' });
  });
});

// Regression coverage for the 17% invalid_provider_output rate seen in
// production: each of these is a schema-conformant response OpenAI's
// strict json_schema mode cannot itself reject (cross-field or semantic
// rules the JSON Schema subset can't express), so the validator's closed
// validationFailureCode is what a one-shot corrective retry keys off of.
describe('gallery vision closed validation-failure diagnostics', () => {
  const validGroup = {
    caption: 'With the Lego Spiderman!', selected_asset_tokens: [cluster.assets[0].assetToken],
    memory_date: cluster.assets[0].captureDate, emotion: 'joy', confidence: 0.8,
  };

  it('flags a memory_date outside the cluster range as date_out_of_range and retryable', () => {
    const error = captureValidationFailure({
      groups: [{ ...validGroup, memory_date: '2026-09-01' }], skip_reason: null,
    }, cluster);
    expect(error.validationFailureCode).toBe('date_out_of_range' satisfies GalleryVisionValidationFailure);
    expect(error.retryable).toBe(true);
    expect(error.ambiguous).toBe(false);
  });

  it('flags an emotion outside the closed taxonomy as invalid_emotion', () => {
    const error = captureValidationFailure({
      groups: [{ ...validGroup, emotion: 'excited' }], skip_reason: null,
    }, cluster);
    expect(error.validationFailureCode).toBe('invalid_emotion' satisfies GalleryVisionValidationFailure);
  });

  it('flags a non-empty groups array paired with a skip_reason as skip_reason_with_groups', () => {
    const error = captureValidationFailure({
      groups: [validGroup], skip_reason: 'low_confidence',
    }, cluster);
    expect(error.validationFailureCode).toBe('skip_reason_with_groups' satisfies GalleryVisionValidationFailure);
  });

  it('flags a caption containing a newline (or other control character) as invalid_caption', () => {
    const error = captureValidationFailure({
      groups: [{ ...validGroup, caption: 'With the Lego Spiderman!\nA great afternoon.' }], skip_reason: null,
    }, cluster);
    expect(error.validationFailureCode).toBe('invalid_caption' satisfies GalleryVisionValidationFailure);
  });

  it('flags an unrecognized skip_reason value as invalid_skip_reason', () => {
    const error = captureValidationFailure({ groups: [], skip_reason: 'model_made_this_up' }, cluster);
    expect(error.validationFailureCode).toBe('invalid_skip_reason' satisfies GalleryVisionValidationFailure);
  });

  it('flags a non-object top-level response as malformed_envelope', () => {
    const error = captureValidationFailure('not an object', cluster);
    expect(error.validationFailureCode).toBe('malformed_envelope' satisfies GalleryVisionValidationFailure);
  });

  it('marks every validation failure retryable and non-ambiguous, so a corrective retry may use a fresh reserved attempt', () => {
    const cases: unknown[] = [
      { groups: [{ ...validGroup, memory_date: '2026-09-01' }], skip_reason: null },
      { groups: [{ ...validGroup, emotion: 'excited' }], skip_reason: null },
      { groups: [validGroup], skip_reason: 'low_confidence' },
      { groups: [], skip_reason: 'model_made_this_up' },
    ];
    for (const value of cases) {
      const error = captureValidationFailure(value, cluster);
      expect(error.code).toBe('VISION_MALFORMED_RESPONSE');
      expect(error.retryable).toBe(true);
      expect(error.ambiguous).toBe(false);
    }
  });
});

describe('gallery curation prompt', () => {
  it('does not presuppose the cluster is an event and states that most hold nothing worth keeping', () => {
    const built = buildGalleryCurationPrompt(cluster, 'en-US', null);
    expect(built).not.toContain('Curate this one photo event');
    expect(built).toContain('Many clusters hold nothing worth keeping');
  });

  it('instructs curation for meaningful people photos and variety across the arc', () => {
    const built = buildGalleryCurationPrompt(cluster, 'en-US', null);
    expect(built).toContain('Prefer meaningful photos with people, especially children');
    expect(built).toContain('variety across its arc');
  });

  it('excludes screenshots, screens/TVs, documents, whiteboards, receipts, and food-only shots', () => {
    const built = buildGalleryCurationPrompt(cluster, 'en-US', null);
    expect(built).toContain('Exclude screenshots, photos of screens or TVs, documents, whiteboards, and receipts');
    expect(built).toContain('Exclude food-only photos with no people unless they are clearly part of a family moment');
  });

  it('keeps the never-invent-facts and identity rules', () => {
    const built = buildGalleryCurationPrompt(cluster, 'en-US', null);
    expect(built).toContain('Never invent names, relationships, ages, places, occasions, or identity');
    expect(built).toContain('Do not identify people');
  });

  it('tells the model silence beats a bad card for mundane/utilitarian clusters', () => {
    const built = buildGalleryCurationPrompt(cluster, 'en-US', null);
    expect(built).toContain('Silence beats a bad card');
    expect(built).toContain('mundane or utilitarian');
    expect(built).toContain('skip_reason "no_candidate"');
  });

  it('adds a stricter singleton rule only for single-photo clusters', () => {
    const singleAssetCluster: GalleryClusterInput = { ...cluster, assets: [cluster.assets[0]] };
    expect(buildGalleryCurationPrompt(singleAssetCluster, 'en-US', null))
      .toContain('single photo. Stage it only if it clearly stands alone as a family moment');
    expect(buildGalleryCurationPrompt(cluster, 'en-US', null))
      .not.toContain('single photo. Stage it only if it clearly stands alone');
  });

  it('directs the caption register toward what a parent would jot under the photo', () => {
    const built = buildGalleryCurationPrompt(cluster, 'en-US', null);
    expect(built).toContain('what a parent would jot under the photo');
    expect(built).toContain('name the distinctive thing');
    expect(built).toContain('Fragments are welcome');
  });

  it('binds the caption to the selected photos, together, never unselected ones', () => {
    // Device-observed: a superhero-playground selection captioned "playing in
    // the ball pit" (a photo in the cluster the model did NOT select), and a
    // three-photo selection captioned after only one of them.
    const built = buildGalleryCurationPrompt(cluster, 'en-US', null);
    expect(built).toContain('describe the photos you SELECTED');
    expect(built).toContain('caption what they share');
    expect(built).toContain('Never mention something visible only in photos you did not select');
  });

  it('instructs normal sentence capitalization for the caption', () => {
    const built = buildGalleryCurationPrompt(cluster, 'en-US', null);
    expect(built).toContain('Start it with a capital letter');
  });

  it('bans photo-description narration and abstract sentimental filler by instruction', () => {
    const built = buildGalleryCurationPrompt(cluster, 'en-US', null);
    expect(built).toContain('Never describe the photo as a photo');
    expect(built).toContain('poses for the camera');
    expect(built).toContain('smiles at the camera');
    expect(built).toContain('can be seen');
    expect(built).toContain('Never use abstract sentimental filler');
    expect(built).toContain('quality time');
    expect(built).toContain('precious moments');
    expect(built).toContain('their own adventure');
    expect(built).toContain('generic scene-summary');
  });

  it('gives positive few-shot caption examples in English, capitalized, with an instruction to write in the caption locale', () => {
    const built = buildGalleryCurationPrompt(cluster, 'en-US', null);
    expect(built).toContain('Positive examples of the target register, in English');
    expect(built).toContain('write the real caption in the caption locale');
    expect(built).toContain('With the Lego Spiderman!');
    expect(built).toContain('Smiles and giggles at the furniture store');
    expect(built).toContain('First time on the big slide');
  });

  it('defaults to one group per cluster and only splits on distinct events', () => {
    const built = buildGalleryCurationPrompt(cluster, 'en-US', null);
    expect(built).toContain('Default to ONE group per cluster');
    expect(built).toContain('different scene AND a clear time break');
    expect(built).toContain('never split one continuous moment into multiple groups');
    expect(built).toContain('near-duplicate or same-scene photos belong in one group or are left unselected');
  });

  // Regression coverage for the 17% invalid_provider_output rate seen in
  // production: the prompt now states every schema-adjacent rule the
  // strict json_schema mode cannot itself enforce (a cross-field or
  // semantic constraint, not a type/enum one).
  it('states memory_date must be copied verbatim from a listed capture_date and gives the explicit cluster date range', () => {
    const built = buildGalleryCurationPrompt(cluster, 'en-US', null);
    expect(built).toContain('Set memory_date to exactly one of the capture_date values shown below');
    expect(built).toContain('copy it verbatim as YYYY-MM-DD');
    expect(built).toContain(`Every capture_date falls between ${cluster.clusterStartDate} and ${cluster.clusterEndDate}`);
    expect(built).toContain('never invent a date outside that range');
  });

  it('enumerates the closed emotion set explicitly in the prompt', () => {
    const built = buildGalleryCurationPrompt(cluster, 'en-US', null);
    expect(built).toContain('emotion must be null or exactly one of: joy, funny, tender, calm, wonder, mischief, pride, bittersweet, worry, weary, sad');
  });

  it('states the exact skip_reason/groups cross-field semantics', () => {
    const built = buildGalleryCurationPrompt(cluster, 'en-US', null);
    expect(built).toContain('skip_reason must be null whenever you return any group');
    expect(built).toContain('Set skip_reason only when groups is empty');
  });

  it('forbids line breaks and other control characters in the caption', () => {
    const built = buildGalleryCurationPrompt(cluster, 'en-US', null);
    expect(built).toContain('Write it as a single line: no line breaks, tabs, or other control characters');
  });
});
