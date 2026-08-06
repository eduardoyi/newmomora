import { assertEquals, assertThrows } from 'jsr:@std/assert@1';
import {
  deriveFreshIllustrationKey,
  deriveFreshPortraitVersionKey,
  extensionOf,
} from './backfill-portrait-reencode.ts';

const USER_ID = '11111111-1111-4111-8111-111111111111';
const MEMBER_ID = '22222222-2222-4222-8222-222222222222';
const MEMORY_ID = '33333333-3333-4333-8333-333333333333';
const VERSION_ID = '44444444-4444-4444-8444-444444444444';
const OLD_ATTEMPT_ID = '55555555-5555-4555-8555-555555555555';
const FRESH_ID = '66666666-6666-4666-8666-666666666666';

Deno.test('extensionOf reads the lowercased suffix after the last dot', () => {
  assertEquals(extensionOf(`${USER_ID}/memories/${MEMORY_ID}/illustrations/${FRESH_ID}.webp`), 'webp');
  assertEquals(extensionOf(`${USER_ID}/memories/${MEMORY_ID}/illustrations/${FRESH_ID}.JPG`), 'jpg');
  assertEquals(extensionOf('no-extension'), '');
});

Deno.test('deriveFreshPortraitVersionKey mints a NEW attempt id under the resolved extension, keeping the same version/member', () => {
  const oldKey = `${USER_ID}/family/${MEMBER_ID}/portraits/${VERSION_ID}/portrait/${OLD_ATTEMPT_ID}.webp`;

  assertEquals(
    deriveFreshPortraitVersionKey(oldKey, 'jpg', FRESH_ID),
    `${USER_ID}/family/${MEMBER_ID}/portraits/${VERSION_ID}/portrait/${FRESH_ID}.jpg`,
  );
  // A no-op re-encode decision (already webp) still mints a fresh id, since
  // the never-reuse-key invariant applies regardless of extension -- the
  // caller only reaches this path when a mismatch was found, but the
  // function itself is not extension-aware beyond formatting the key.
  assertEquals(
    deriveFreshPortraitVersionKey(oldKey, 'webp', FRESH_ID),
    `${USER_ID}/family/${MEMBER_ID}/portraits/${VERSION_ID}/portrait/${FRESH_ID}.webp`,
  );
});

Deno.test('deriveFreshPortraitVersionKey throws rather than guessing for a non-portrait-attempt key', () => {
  assertThrows(
    () => deriveFreshPortraitVersionKey(`${USER_ID}/family/${MEMBER_ID}/portrait.webp`, 'jpg', FRESH_ID),
    Error,
    'Cannot parse portrait attempt key',
  );
});

Deno.test('deriveFreshIllustrationKey mints a NEW generation id under the resolved extension, keeping the same memory', () => {
  const oldKey = `${USER_ID}/memories/${MEMORY_ID}/illustrations/${OLD_ATTEMPT_ID}.webp`;

  assertEquals(
    deriveFreshIllustrationKey(oldKey, 'jpg', FRESH_ID),
    `${USER_ID}/memories/${MEMORY_ID}/illustrations/${FRESH_ID}.jpg`,
  );
});

Deno.test('deriveFreshIllustrationKey throws rather than guessing for a non-illustration key', () => {
  assertThrows(
    () => deriveFreshIllustrationKey(`${USER_ID}/memories/${MEMORY_ID}/media.jpg`, 'jpg', FRESH_ID),
    Error,
    'Cannot parse memory illustration key',
  );
});
