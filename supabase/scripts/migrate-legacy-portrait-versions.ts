/**
 * Recover and migrate legacy family-member photos/portraits into immutable
 * portrait-version records. The default mode is a read-only audit.
 *
 * Dry run:
 * deno run --no-lock --node-modules-dir=auto --allow-all --env-file=.env.local --env-file=supabase/.env.local \
 *   supabase/scripts/migrate-legacy-portrait-versions.ts
 *
 * Apply after reviewing the report:
 * deno run --no-lock --node-modules-dir=auto --allow-all --env-file=.env.local --env-file=supabase/.env.local \
 *   supabase/scripts/migrate-legacy-portrait-versions.ts --apply
 */
import { createClient } from 'npm:@supabase/supabase-js@2';
import { parse as parseExif } from 'npm:exifr@7.1.3';

import {
  getObjectBytes,
  putObjectBytes,
} from '../functions/_shared/r2.ts';

interface LegacyMemberRow {
  id: string;
  family_id: string;
  user_id: string | null;
  date_of_birth: string | null;
  profile_picture_key: string | null;
  illustrated_profile_key: string | null;
}

interface ProfileRow {
  id: string;
  timezone: string | null;
}

interface ExifResult {
  DateTimeOriginal?: Date | string;
  DateTimeDigitized?: Date | string;
}

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const EXIF_DATE_PATTERN = /^(\d{4})[:\-](\d{2})[:\-](\d{2})/;
const PAGE_SIZE = 250;

function requireEnv(name: string): string {
  const value = Deno.env.get(name);
  if (!value) throw new Error(`Missing ${name}`);
  return value;
}

function bytesToUuid(bytes: Uint8Array): string {
  const value = bytes.slice(0, 16);
  value[6] = (value[6] & 0x0f) | 0x50;
  value[8] = (value[8] & 0x3f) | 0x80;
  const hex = [...value].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

async function deterministicUuid(scope: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(scope));
  return bytesToUuid(new Uint8Array(digest));
}

function formatDateParts(year: number, month: number, day: number): string | null {
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() + 1 !== month ||
    date.getUTCDate() !== day
  ) {
    return null;
  }
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function normalizeExifDate(value: Date | string | undefined): string | null {
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return formatDateParts(value.getFullYear(), value.getMonth() + 1, value.getDate());
  }
  if (typeof value !== 'string') return null;
  const match = EXIF_DATE_PATTERN.exec(value.replace(/\0+/g, '').trim());
  return match
    ? formatDateParts(Number(match[1]), Number(match[2]), Number(match[3]))
    : null;
}

function todayInTimezone(timezone: string): string {
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).formatToParts(new Date());
    const value = Object.fromEntries(parts.map((part) => [part.type, part.value]));
    return `${value.year}-${value.month}-${value.day}`;
  } catch {
    return new Date().toISOString().slice(0, 10);
  }
}

async function recoverReferenceDate(
  bytes: Uint8Array,
  dateOfBirth: string | null,
  today: string,
): Promise<string | null> {
  let exif: ExifResult | undefined;
  try {
    exif = await parseExif(bytes, {
      pick: ['DateTimeOriginal', 'DateTimeDigitized'],
    }) as ExifResult | undefined;
  } catch {
    return null;
  }

  for (const rawValue of [exif?.DateTimeOriginal, exif?.DateTimeDigitized]) {
    const value = normalizeExifDate(rawValue);
    if (!value || value > today || (dateOfBirth && value < dateOfBirth)) continue;
    return value;
  }
  return null;
}

async function normalizePhotoToJpeg(bytes: Uint8Array): Promise<Uint8Array> {
  const { Image } = await import('https://deno.land/x/imagescript@1.3.0/mod.ts');
  const image = await Image.decode(bytes);
  return await image.encodeJPEG(88);
}

function keyOwner(objectKey: string): string | null {
  const owner = objectKey.split('/', 1)[0];
  return UUID_PATTERN.test(owner) ? owner : null;
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  return left.every((value, index) => value === right[index]);
}

const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? requireEnv('EXPO_PUBLIC_SUPABASE_URL');
const serviceRoleKey = requireEnv('SUPABASE_SERVICE_ROLE_KEY');
const shouldApply = Deno.args.includes('--apply');
const admin = createClient(supabaseUrl, serviceRoleKey, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const members: LegacyMemberRow[] = [];
for (let offset = 0; ; offset += PAGE_SIZE) {
  const { data, error } = await admin
    .from('family_members')
    .select(
      'id, family_id, user_id, date_of_birth, profile_picture_key, illustrated_profile_key',
    )
    .not('profile_picture_key', 'is', null)
    .order('created_at', { ascending: true })
    .order('id', { ascending: true })
    .range(offset, offset + PAGE_SIZE - 1);
  if (error) throw new Error(`Could not load legacy family members: ${error.message}`);
  members.push(...(data as LegacyMemberRow[]));
  if (data.length < PAGE_SIZE) break;
}

const { data: existingRows, error: existingError } = await admin
  .from('family_member_portrait_versions')
  .select('family_member_id');
if (existingError) {
  throw new Error(`Could not load existing portrait versions: ${existingError.message}`);
}
const alreadyMigrated = new Set(
  (existingRows ?? []).map((row) => row.family_member_id as string),
);

const owners = [...new Set(
  members
    .map((member) => member.profile_picture_key && keyOwner(member.profile_picture_key))
    .filter((owner): owner is string => Boolean(owner)),
)];
const profiles: ProfileRow[] = [];
for (let offset = 0; offset < owners.length; offset += 100) {
  const { data, error } = await admin
    .from('user_profiles')
    .select('id, timezone')
    .in('id', owners.slice(offset, offset + 100));
  if (error) throw new Error(`Could not load uploader timezones: ${error.message}`);
  profiles.push(...(data as ProfileRow[]));
}
const timezoneByOwner = new Map(profiles.map((profile) => [profile.id, profile.timezone ?? 'UTC']));

let readyCount = 0;
let sourceOnlyCount = 0;
let recoveredDateCount = 0;
let undatedCount = 0;
let skippedCount = 0;
let failedCount = 0;

console.log(`${shouldApply ? 'Applying' : 'Dry-running'} legacy portrait migration`);
console.log(`Found ${members.length} family member(s) with a legacy profile photo`);

for (const member of members) {
  if (alreadyMigrated.has(member.id)) {
    skippedCount += 1;
    console.log(`Member ${member.id}: skipped (portrait version already exists)`);
    continue;
  }

  const sourceKey = member.profile_picture_key;
  if (!sourceKey) continue;
  const ownerId = keyOwner(sourceKey);
  if (!ownerId) {
    failedCount += 1;
    console.error(`Member ${member.id}: invalid legacy source-key owner`);
    continue;
  }

  const versionId = await deterministicUuid(`momora:legacy-portrait-version:${member.id}`);
  const attemptId = await deterministicUuid(`momora:legacy-portrait-attempt:${member.id}`);
  const versionPrefix = `${ownerId}/family/${member.id}/portraits/${versionId}`;
  const targetPhotoKey = `${versionPrefix}/photo.jpg`;
  const targetPortraitKey = `${versionPrefix}/portrait/${attemptId}.webp`;

  try {
    const photoBytes = await getObjectBytes(sourceKey);
    const normalizedPhoto = await normalizePhotoToJpeg(photoBytes);
    const today = todayInTimezone(timezoneByOwner.get(ownerId) ?? 'UTC');
    const referenceDate = await recoverReferenceDate(
      photoBytes,
      member.date_of_birth,
      today,
    );
    const portraitBytes = member.illustrated_profile_key
      ? await getObjectBytes(member.illustrated_profile_key)
      : null;

    if (referenceDate) recoveredDateCount += 1;
    else undatedCount += 1;
    if (portraitBytes) readyCount += 1;
    else sourceOnlyCount += 1;

    console.log(
      `Member ${member.id}: ${referenceDate ?? 'manual review / legacy date unknown'}, ` +
        `${portraitBytes ? 'ready portrait' : 'source photo only'}`,
    );

    if (!shouldApply) continue;

    await putObjectBytes(targetPhotoKey, normalizedPhoto, 'image/jpeg');
    if (portraitBytes) {
      await putObjectBytes(targetPortraitKey, portraitBytes, 'image/webp');
    }

    const verifiedPhoto = await getObjectBytes(targetPhotoKey);
    if (!bytesEqual(verifiedPhoto, normalizedPhoto)) {
      throw new Error('normalized source verification failed');
    }
    if (portraitBytes) {
      const verifiedPortrait = await getObjectBytes(targetPortraitKey);
      if (!bytesEqual(verifiedPortrait, portraitBytes)) {
        throw new Error('portrait verification failed');
      }
    }

    const { error: insertError } = await admin
      .from('family_member_portrait_versions')
      .insert({
        id: versionId,
        family_id: member.family_id,
        family_member_id: member.id,
        user_id: member.user_id,
        reference_date: referenceDate,
        date_source: referenceDate ? 'exif' : 'legacy_unknown',
        profile_picture_key: targetPhotoKey,
        illustrated_profile_key: portraitBytes ? targetPortraitKey : null,
        illustrated_profile_status: portraitBytes ? 'ready' : 'failed',
      });
    if (insertError) throw insertError;
  } catch (error) {
    failedCount += 1;
    console.error(
      `Member ${member.id}: failed`,
      error instanceof Error ? error.message : 'unknown error',
    );
    // Keep any copied objects after a DB failure. Deterministic keys make the
    // apply safely retryable, while deleting here could race a successful
    // concurrent retry and remove bytes behind its committed row.
  }
}

console.log(
  `Finished: ${recoveredDateCount} EXIF date(s), ${undatedCount} needing manual review, ` +
    `${readyCount} ready portrait(s), ${sourceOnlyCount} source-only, ` +
    `${skippedCount} skipped, ${failedCount} failed`,
);

if (!shouldApply && members.length - skippedCount > 0) {
  console.log('Review every manual-review row, then rerun with --apply when ready.');
}
if (failedCount > 0) Deno.exit(1);
