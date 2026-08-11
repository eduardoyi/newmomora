import { assertEquals } from 'jsr:@std/assert@1';

import { galleryImportPreviewPrefix, isUuid } from './reset-gallery-import.ts';

// --- isUuid -----------------------------------------------------------

Deno.test('isUuid accepts a well-formed v1-5 uuid', () => {
  assertEquals(isUuid('123e4567-e89b-42d3-a456-426614174000'), true);
  assertEquals(isUuid('123E4567-E89B-42D3-A456-426614174000'), true);
});

Deno.test('isUuid rejects an email or malformed id', () => {
  assertEquals(isUuid('test@example.com'), false);
  assertEquals(isUuid('not-a-uuid'), false);
  assertEquals(isUuid('123e4567-e89b-42d3-a456-42661417400'), false);
  assertEquals(isUuid(''), false);
});

// --- galleryImportPreviewPrefix ----------------------------------------
// MUST stay byte-identical to record_gallery_import_preview_upload's
// `{actorId}/gallery-import/{runId}/previews/{assetToken}.jpg` key grammar
// in supabase/migrations/20260809130000_gallery_import_foundation.sql --
// this expected string is written out by hand to pin that shape
// independent of the implementation under test.

Deno.test('galleryImportPreviewPrefix builds the actor-scoped R2 prefix covering every run', () => {
  const userId = '123e4567-e89b-42d3-a456-426614174000';
  assertEquals(galleryImportPreviewPrefix(userId), `${userId}/gallery-import/`);
});

Deno.test('galleryImportPreviewPrefix is a strict prefix of the real per-asset preview key shape', () => {
  const userId = '123e4567-e89b-42d3-a456-426614174000';
  const runId = '11111111-1111-4111-8111-111111111111';
  const assetToken = '22222222-2222-4222-8222-222222222222';
  const previewKey = `${userId}/gallery-import/${runId}/previews/${assetToken}.jpg`;
  assertEquals(previewKey.startsWith(galleryImportPreviewPrefix(userId)), true);
});

Deno.test('galleryImportPreviewPrefix does not match a different user’s prefix', () => {
  const userId = '123e4567-e89b-42d3-a456-426614174000';
  const otherUserId = '999e4567-e89b-42d3-a456-426614174999';
  const runId = '11111111-1111-4111-8111-111111111111';
  const assetToken = '22222222-2222-4222-8222-222222222222';
  const otherPreviewKey = `${otherUserId}/gallery-import/${runId}/previews/${assetToken}.jpg`;
  assertEquals(otherPreviewKey.startsWith(galleryImportPreviewPrefix(userId)), false);
});
