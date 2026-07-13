/**
 * Backfill persisted aspect ratios for existing video memory assets.
 *
 * Dry run:
 * deno run --allow-all --env-file=.env.local --env-file=supabase/.env.local \
 *   supabase/scripts/backfill-media-aspect-ratios.ts
 *
 * Apply:
 * deno run --allow-all --env-file=.env.local --env-file=supabase/.env.local \
 *   supabase/scripts/backfill-media-aspect-ratios.ts --apply
 */
import { createClient } from 'npm:@supabase/supabase-js@2';

import { createPresignedGetUrls } from '../functions/_shared/r2.ts';

interface FfprobeStream {
  width?: number;
  height?: number;
  tags?: { rotate?: string };
  side_data_list?: Array<{ rotation?: number }>;
}

interface FfprobeResult {
  streams?: FfprobeStream[];
}

function requireEnv(name: string): string {
  const value = Deno.env.get(name);
  if (!value) {
    throw new Error(`Missing ${name}`);
  }
  return value;
}

function getDisplayAspectRatio(stream: FfprobeStream): number | null {
  const { width, height } = stream;
  if (!width || !height || width <= 0 || height <= 0) {
    return null;
  }

  const sideDataRotation = stream.side_data_list
    ?.map((item) => item.rotation)
    .find((rotation): rotation is number => typeof rotation === 'number');
  const tagRotation = Number(stream.tags?.rotate);
  const rotation = sideDataRotation ?? (Number.isFinite(tagRotation) ? tagRotation : 0);
  const normalizedRotation = Math.abs(rotation) % 180;

  return normalizedRotation === 90 ? height / width : width / height;
}

async function probeVideo(url: string): Promise<number | null> {
  const command = new Deno.Command('ffprobe', {
    args: [
      '-v',
      'error',
      '-select_streams',
      'v:0',
      '-show_entries',
      'stream=width,height:stream_tags=rotate:stream_side_data=rotation',
      '-of',
      'json',
      url,
    ],
    stdout: 'piped',
    stderr: 'piped',
  });
  const output = await command.output();

  if (!output.success) {
    return null;
  }

  const parsed = JSON.parse(new TextDecoder().decode(output.stdout)) as FfprobeResult;
  const stream = parsed.streams?.[0];
  return stream ? getDisplayAspectRatio(stream) : null;
}

const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? requireEnv('EXPO_PUBLIC_SUPABASE_URL');
const serviceRoleKey = requireEnv('SUPABASE_SERVICE_ROLE_KEY');
const shouldApply = Deno.args.includes('--apply');
const shouldSummarizeOnly = Deno.args.includes('--summary');
const shouldScopeToActiveFamilies = Deno.args.includes('--active-families-only');
const admin = createClient(supabaseUrl, serviceRoleKey, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const { data: assets, error: selectError } = await admin
  .from('memory_media')
  .select('id, memory_id, object_key')
  .like('content_type', 'video/%')
  .is('aspect_ratio', null)
  .order('created_at', { ascending: true });

if (selectError) {
  throw new Error(`Could not load video media rows: ${selectError.message}`);
}

if (assets.length === 0) {
  console.log('No video aspect ratios need backfilling');
  Deno.exit(0);
}

const memoryIds = [...new Set(assets.map((asset) => asset.memory_id))];
const [{ data: memories, error: memoriesError }, { data: profiles, error: profilesError }] =
  await Promise.all([
    admin.from('memories').select('id, family_id').in('id', memoryIds),
    admin.from('user_profiles').select('active_family_id').not('active_family_id', 'is', null),
  ]);

if (memoriesError || profilesError) {
  throw new Error(
    `Could not resolve active families: ${memoriesError?.message ?? profilesError?.message}`,
  );
}

const familyIdByMemoryId = new Map(memories.map((memory) => [memory.id, memory.family_id]));
const activeFamilyIds = new Set(
  profiles
    .map((profile) => profile.active_family_id)
    .filter((familyId): familyId is string => typeof familyId === 'string'),
);
const activeFamilyAssets = assets.filter((asset) => {
  const familyId = familyIdByMemoryId.get(asset.memory_id);
  return familyId ? activeFamilyIds.has(familyId) : false;
});
const candidateAssets = shouldScopeToActiveFamilies ? activeFamilyAssets : assets;

const assetsByObjectKey = new Map<string, typeof candidateAssets>();
for (const asset of candidateAssets) {
  const matchingAssets = assetsByObjectKey.get(asset.object_key) ?? [];
  matchingAssets.push(asset);
  assetsByObjectKey.set(asset.object_key, matchingAssets);
}

const memoryCount = new Set(candidateAssets.map((asset) => asset.memory_id)).size;
console.log(
  `Found ${candidateAssets.length} candidate video row(s) across ${memoryCount} memory/memories and ` +
    `${assetsByObjectKey.size} unique R2 object(s)`,
);
console.log(
  `${activeFamilyAssets.length} of ${assets.length} total null-ratio video row(s) belong to ` +
    'a currently active family',
);

if (shouldSummarizeOnly) {
  Deno.exit(0);
}

console.log(`${shouldApply ? 'Applying' : 'Dry-running'} video aspect-ratio backfill`);

let updatedCount = 0;
let failedCount = 0;

for (const [objectKey, matchingAssets] of assetsByObjectKey) {
  const representative = matchingAssets[0];
  try {
    const urls = await createPresignedGetUrls([objectKey], 300);
    const url = urls[objectKey];
    const aspectRatio = url ? await probeVideo(url) : null;

    if (!aspectRatio || aspectRatio < 0.1 || aspectRatio > 10) {
      failedCount += matchingAssets.length;
      console.error(`Media ${representative.id}: could not determine a valid aspect ratio`);
      continue;
    }

    if (shouldApply) {
      const { error: updateError } = await admin
        .from('memory_media')
        .update({ aspect_ratio: aspectRatio })
        .in('id', matchingAssets.map((asset) => asset.id))
        .is('aspect_ratio', null);

      if (updateError) {
        throw updateError;
      }
    }

    updatedCount += matchingAssets.length;
    console.log(
      `Media ${representative.id} (+${matchingAssets.length - 1} duplicate row(s)): ` +
        `${aspectRatio.toFixed(6)}${shouldApply ? ' saved' : ''}`,
    );
  } catch (error) {
    failedCount += matchingAssets.length;
    console.error(
      `Media ${representative.id}: failed`,
      error instanceof Error ? error.message : 'unknown error',
    );
  }
}

console.log(`Finished: ${updatedCount} measured, ${failedCount} failed`);

if (failedCount > 0) {
  Deno.exit(1);
}
