/**
 * Local curation tool: download real before/after (source photo -> finished
 * illustrated portrait) pairs for a family's members, crop+resize them for a
 * small onboarding card, and bundle them as optimized webp assets.
 *
 * First consumer: S16's "pick a photo" state
 * (app/(onboarding)/portrait.tsx), which rotates through demo-account
 * before/after pairs instead of showing one fixed finished portrait (see
 * src/constants/onboarding-portrait-pairs.ts, the data module this script's
 * output feeds).
 *
 * Deliberately reusable beyond that one screen and beyond the demo account:
 * --email and --output-dir are both parameters, not hardcoded, so a
 * follow-up pass pulling illustrated memories/media from the owner's own
 * account (or a refreshed demo family) for other onboarding screens can
 * reuse this script instead of writing a new one. Follows the same shape as
 * export-onboarding-memories.ts (list/download modes, magic-link auth as
 * the target account, manifest.json alongside the downloaded files).
 *
 * Examples:
 *   npm run export:onboarding-portraits -- --email hello+demo@usemomora.com --list
 *   npm run export:onboarding-portraits -- --email hello+demo@usemomora.com --download
 *   npm run export:onboarding-portraits -- --email hello+demo@usemomora.com --download \
 *     --output-dir assets/onboarding/portrait-pairs --scale 2 --quality 74
 *   npm run export:onboarding-portraits -- --email hello+demo@usemomora.com --download --member Maya --member Theo
 *
 * Requires Supabase (SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY/anon key) and R2
 * vars in supabase/.env.local. DB/R2 access is not available in every
 * environment this script runs in -- it must typecheck even when it cannot
 * be executed.
 *
 * Reads `family_member_portrait_versions` directly, NOT the legacy
 * `family_members.profile_picture_key` / `illustrated_profile_key` columns
 * -- those are frozen/read-only post-migration (see
 * supabase/migrations/20260715120000_portrait_timeline.sql's
 * `family_members_legacy_portrait_cutoff` trigger). Only versions with
 * `illustrated_profile_status = 'ready'` are ever downloaded: the table's
 * own check constraint guarantees a ready row has both a source photo
 * (`profile_picture_key`, not null) and a finished illustrated portrait
 * (`illustrated_profile_key`) -- a genuine before/after pair.
 *
 * This is a local curation tool: printing member names in --list is
 * intended and fine (no memory content is ever touched here).
 */
import { toFileUrl } from 'jsr:@std/path@1/to-file-url';
import { createClient } from 'npm:@supabase/supabase-js@2';
import sharp from 'npm:sharp@0.33';

import { getObjectBytes } from '../functions/_shared/r2.ts';

type SupabaseClient = Awaited<ReturnType<typeof createAuthedClient>>;

export interface PortraitVersionRow {
  id: string;
  family_member_id: string;
  illustrated_profile_status: string;
  profile_picture_key: string | null;
  illustrated_profile_key: string | null;
  reference_date: string | null;
  created_at: string;
}

export interface CliOptions {
  email?: string;
  list: boolean;
  download: boolean;
  outputDir: URL;
  memberNames?: string[];
  displayWidth: number;
  displayHeight: number;
  scale: number;
  quality: number;
}

export interface PixelSize {
  width: number;
  height: number;
}

export interface ManifestEntry {
  memberId: string;
  name: string;
  slug: string;
  photoFile: string;
  portraitFile: string;
  referenceDate: string | null;
}

const DEFAULT_OUTPUT_DIR = new URL('../../assets/onboarding/portrait-pairs/', import.meta.url);
// S16's before/after cards render at ~108x128 (app/(onboarding)/portrait.tsx
// styles.photoCard) -- 2x covers retina without ballooning bundle size for
// what's always displayed small. Override via --scale for a higher-density
// future use.
const DEFAULT_DISPLAY_WIDTH = 108;
const DEFAULT_DISPLAY_HEIGHT = 128;
const DEFAULT_SCALE = 2;
const DEFAULT_QUALITY = 74;

export function slugify(value: string): string {
  // NFD-normalize + strip combining marks first so accented names (Lucía,
  // Théo, ...) -- common in this family-name domain -- slugify to readable
  // ascii ("lucia") instead of dropping the letter entirely ("luc-a").
  const ascii = value.normalize('NFD').replace(/\p{Diacritic}/gu, '');
  const slug = ascii.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return slug || 'member';
}

function resolveOutputPath(path: string): URL {
  const base = path.startsWith('/') ? toFileUrl(path) : toFileUrl(`${Deno.cwd()}/${path}`);
  return new URL(base.href.endsWith('/') ? base.href : `${base.href}/`);
}

export function parseArgs(args: string[]): CliOptions {
  const options: CliOptions = {
    list: false,
    download: false,
    outputDir: DEFAULT_OUTPUT_DIR,
    displayWidth: DEFAULT_DISPLAY_WIDTH,
    displayHeight: DEFAULT_DISPLAY_HEIGHT,
    scale: DEFAULT_SCALE,
    quality: DEFAULT_QUALITY,
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    const next = args[index + 1];

    switch (arg) {
      case '--email':
        options.email = next;
        index += 1;
        break;
      case '--list':
        options.list = true;
        break;
      case '--download':
        options.download = true;
        break;
      case '--output-dir':
        options.outputDir = resolveOutputPath(next);
        index += 1;
        break;
      case '--member':
        options.memberNames = [...(options.memberNames ?? []), next];
        index += 1;
        break;
      case '--display-width':
        options.displayWidth = Number(next) || DEFAULT_DISPLAY_WIDTH;
        index += 1;
        break;
      case '--display-height':
        options.displayHeight = Number(next) || DEFAULT_DISPLAY_HEIGHT;
        index += 1;
        break;
      case '--scale':
        options.scale = Number(next) || DEFAULT_SCALE;
        index += 1;
        break;
      case '--quality':
        options.quality = Number(next) || DEFAULT_QUALITY;
        index += 1;
        break;
      default:
        break;
    }
  }

  return options;
}

/** Target pixel size for the cropped, bundled webp -- display size * scale. */
export function resolveTargetPixelSize(
  options: Pick<CliOptions, 'displayWidth' | 'displayHeight' | 'scale'>,
): PixelSize {
  return {
    width: Math.max(1, Math.round(options.displayWidth * options.scale)),
    height: Math.max(1, Math.round(options.displayHeight * options.scale)),
  };
}

/**
 * One row per member: the "ready" version the app itself would resolve for
 * that member right now. Mirrors the priority
 * src/utils/portrait-versions.ts's `resolvePortraitVersion` (and the
 * `family_member_portrait_versions_selection` index) use for a member's
 * current portrait -- newest `reference_date` first (nulls last), then
 * newest `created_at` -- so this curation tool never bundles a stale
 * version when a member has more than one ready portrait in their history.
 * Rows missing either key are excluded even if marked `ready`; the DB check
 * constraint prevents that in practice, but this stays defensive since the
 * output must always be a genuine before/after pair.
 */
export function selectLatestReadyVersionPerMember(
  rows: readonly PortraitVersionRow[],
): PortraitVersionRow[] {
  const ready = rows.filter(
    (row) =>
      row.illustrated_profile_status === 'ready' &&
      Boolean(row.profile_picture_key) &&
      Boolean(row.illustrated_profile_key),
  );

  const sorted = [...ready].sort((a, b) => {
    const dateCompare = (b.reference_date ?? '').localeCompare(a.reference_date ?? '');
    if (dateCompare !== 0) return dateCompare;
    return b.created_at.localeCompare(a.created_at);
  });

  const seen = new Set<string>();
  const result: PortraitVersionRow[] = [];
  for (const row of sorted) {
    if (seen.has(row.family_member_id)) continue;
    seen.add(row.family_member_id);
    result.push(row);
  }
  return result;
}

/** Unique, filesystem-safe slug per member name, de-duped for a family with repeated first names. */
export function assignSlugs(names: readonly string[]): string[] {
  const used = new Set<string>();
  return names.map((name) => {
    const base = slugify(name);
    let candidate = base;
    let suffix = 2;
    while (used.has(candidate)) {
      candidate = `${base}-${suffix}`;
      suffix += 1;
    }
    used.add(candidate);
    return candidate;
  });
}

async function createAuthedClient(userEmail: string): Promise<ReturnType<typeof createClient>> {
  const supabaseUrl = Deno.env.get('EXPO_PUBLIC_SUPABASE_URL') ?? Deno.env.get('SUPABASE_URL');
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  const anonKey = Deno.env.get('EXPO_PUBLIC_SUPABASE_ANON_KEY') ?? Deno.env.get('SUPABASE_ANON_KEY');

  if (!supabaseUrl || !serviceRoleKey || !anonKey) {
    throw new Error('Missing Supabase env vars in supabase/.env.local');
  }

  const admin = createClient(supabaseUrl, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const { data: linkData, error: linkError } = await admin.auth.admin.generateLink({
    type: 'magiclink',
    email: userEmail,
  });

  if (linkError || !linkData.properties?.hashed_token) {
    throw new Error(linkError?.message ?? 'Failed to generate auth link');
  }

  const client = createClient(supabaseUrl, anonKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const { data: sessionData, error: sessionError } = await client.auth.verifyOtp({
    type: 'magiclink',
    token_hash: linkData.properties.hashed_token,
  });

  if (sessionError || !sessionData.session?.access_token) {
    throw new Error(sessionError?.message ?? 'Failed to create session');
  }

  return createClient(supabaseUrl, anonKey, {
    global: { headers: { Authorization: `Bearer ${sessionData.session.access_token}` } },
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

async function loadCandidatePairs(
  supabase: SupabaseClient,
  memberNames: string[] | undefined,
): Promise<{ pairs: PortraitVersionRow[]; namesByMemberId: Map<string, string> }> {
  const { data, error } = await supabase
    .from('family_member_portrait_versions')
    .select('id, family_member_id, illustrated_profile_status, profile_picture_key, illustrated_profile_key, reference_date, created_at')
    .order('created_at', { ascending: false });

  if (error) {
    throw new Error(`Failed to load portrait versions: ${error.message}`);
  }

  const rows = (data ?? []) as PortraitVersionRow[];
  const memberIds = [...new Set(rows.map((row) => row.family_member_id))];

  if (memberIds.length === 0) {
    return { pairs: [], namesByMemberId: new Map() };
  }

  const { data: members, error: membersError } = await supabase
    .from('family_members')
    .select('id, name')
    .in('id', memberIds);

  if (membersError) {
    throw new Error(`Failed to load family member names: ${membersError.message}`);
  }

  const namesByMemberId = new Map(
    ((members ?? []) as Array<{ id: string; name: string }>).map((member) => [member.id, member.name]),
  );

  let filtered = rows;
  if (memberNames && memberNames.length > 0) {
    const wanted = new Set(memberNames.map((name) => name.trim().toLowerCase()));
    const allowedIds = new Set(
      [...namesByMemberId.entries()]
        .filter(([, name]) => wanted.has(name.trim().toLowerCase()))
        .map(([id]) => id),
    );
    filtered = rows.filter((row) => allowedIds.has(row.family_member_id));
  }

  return { pairs: selectLatestReadyVersionPerMember(filtered), namesByMemberId };
}

function runList(pairs: PortraitVersionRow[], namesByMemberId: Map<string, string>): void {
  if (pairs.length === 0) {
    console.log('No members with both a ready portrait and a source photo found.');
    return;
  }

  console.log(`${pairs.length} portrait pair(s) found`);
  for (const pair of pairs) {
    const name = namesByMemberId.get(pair.family_member_id) ?? pair.family_member_id;
    console.log(`  ${name} (member ${pair.family_member_id}, reference date ${pair.reference_date ?? 'unknown'})`);
  }
}

/** Crops to fill the target size (subject-aware crop, not a plain center crop) and re-encodes as webp. */
export async function processPortraitImage(
  bytes: Uint8Array,
  size: PixelSize,
  quality: number,
): Promise<Uint8Array> {
  const buffer = await sharp(bytes)
    .resize(size.width, size.height, { fit: 'cover', position: sharp.strategy.attention })
    .webp({ quality })
    .toBuffer();
  return new Uint8Array(buffer);
}

async function runDownload(
  pairs: PortraitVersionRow[],
  namesByMemberId: Map<string, string>,
  options: CliOptions,
): Promise<void> {
  if (pairs.length === 0) {
    console.error('No members with both a ready portrait and a source photo found.');
    Deno.exit(1);
  }

  await Deno.mkdir(options.outputDir, { recursive: true });
  const target = resolveTargetPixelSize(options);
  const names = pairs.map((pair) => namesByMemberId.get(pair.family_member_id) ?? pair.family_member_id);
  const slugs = assignSlugs(names);

  const manifest: ManifestEntry[] = [];
  let totalBytes = 0;

  for (const [index, pair] of pairs.entries()) {
    const name = names[index];
    const slug = slugs[index];
    console.log(`\n→ ${name}`);

    try {
      const [photoBytes, portraitBytes] = await Promise.all([
        getObjectBytes(pair.profile_picture_key!),
        getObjectBytes(pair.illustrated_profile_key!),
      ]);

      const [photoOut, portraitOut] = await Promise.all([
        processPortraitImage(photoBytes, target, options.quality),
        processPortraitImage(portraitBytes, target, options.quality),
      ]);

      const photoFile = `${slug}-photo.webp`;
      const portraitFile = `${slug}-portrait.webp`;

      await Deno.writeFile(new URL(photoFile, options.outputDir), photoOut);
      await Deno.writeFile(new URL(portraitFile, options.outputDir), portraitOut);

      totalBytes += photoOut.byteLength + portraitOut.byteLength;
      console.log(`  ✓ ${photoFile} (${photoOut.byteLength} bytes)`);
      console.log(`  ✓ ${portraitFile} (${portraitOut.byteLength} bytes)`);

      manifest.push({
        memberId: pair.family_member_id,
        name,
        slug,
        photoFile,
        portraitFile,
        referenceDate: pair.reference_date,
      });
    } catch (error) {
      console.error(`  ✗ ${name}: ${error instanceof Error ? error.message : 'unknown error'}`);
    }
  }

  await Deno.writeFile(
    new URL('manifest.json', options.outputDir),
    new TextEncoder().encode(JSON.stringify(manifest, null, 2)),
  );

  console.log(
    `\nDone. ${manifest.length}/${pairs.length} pair(s) → ${options.outputDir.pathname} ` +
      `(${(totalBytes / 1024).toFixed(1)} KB total)`,
  );

  if (manifest.length < pairs.length) {
    Deno.exit(1);
  }
}

async function main(): Promise<void> {
  const options = parseArgs(Deno.args);

  if (!options.email) {
    console.error('Provide --email <email>');
    Deno.exit(1);
  }

  const modeCount = [options.list, options.download].filter(Boolean).length;
  if (modeCount === 0) {
    console.error('Provide --list or --download');
    Deno.exit(1);
  }
  if (modeCount > 1) {
    console.error('Provide exactly one of --list or --download');
    Deno.exit(1);
  }

  const supabase = await createAuthedClient(options.email);
  const { pairs, namesByMemberId } = await loadCandidatePairs(supabase, options.memberNames);

  if (options.list) {
    runList(pairs, namesByMemberId);
  } else {
    await runDownload(pairs, namesByMemberId, options);
  }
}

if (import.meta.main) {
  await main();
}
