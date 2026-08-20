/**
 * Additive production demo-fixture top-up.
 *
 * Dry-run is the default. `--apply` is required before any OpenAI, R2, or
 * database write. The original 20-memory fixture is intentionally left in
 * `seed-demo-account.ts`; this runner owns only the dated top-up manifest and
 * its guarded date adjustments.
 *
 * Usage:
 *   npx --yes deno run --allow-all \
 *     --env-file=supabase/.env.local --env-file=.env.local \
 *     supabase/scripts/seed-demo-top-up.ts
 *   ... seed-demo-top-up.ts --apply
 *   ... seed-demo-top-up.ts --phase audit
 */
import { type SupabaseClient } from "npm:@supabase/supabase-js@2";

import {
  assertGeneratedImage,
  createAdmin,
  createUserClient,
  deterministicUuid,
  findUserByEmail,
  generateImage,
  invokeUntilReady,
  withRetries,
} from "./seed-demo-account.ts";
import {
  DEMO_ACCOUNT_EMAIL,
  DEMO_FAMILY,
  DEMO_FAMILY_MEMBERS,
  DEMO_MEMORIES,
} from "./demo-family-spec.ts";
import {
  DEMO_BASELINE_PORTRAIT_DATE,
  DEMO_EXISTING_MEMORY_DATE_UPDATES,
  DEMO_TOP_UP_CURRENT_DATE,
  DEMO_TOP_UP_MEMORIES,
  DEMO_TOP_UP_PORTRAITS,
  type DemoTopUpMemorySpec,
  type DemoTopUpPortraitSpec,
} from "./demo-top-up-spec.ts";
import {
  getObjectBytes,
  putObjectBytes,
} from "../functions/_shared/r2.ts";
import {
  buildMemoryMediaAssetKey,
  buildPortraitVersionPhotoKey,
} from "../functions/_shared/storage-keys.ts";

const PORTRAIT_POLL_ATTEMPTS = 36;
const ILLUSTRATION_POLL_ATTEMPTS = 42;
const POLL_INTERVAL_MS = 5_000;
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const GENERATED_IMAGE_ASPECT_RATIO = 2 / 3;
const ASPECT_RATIO_TOLERANCE = 0.04;
const BASELINE_MEMBER_SCOPE = "member";
const BASELINE_PORTRAIT_SCOPE = "portrait-version";
const OLD_TOP_UP_PORTRAIT_SCOPE = "demo-top-up-portrait-version";
const TOP_UP_PORTRAIT_SCOPE = "demo-top-up-portrait-version-wardrobe-v2";
const TOP_UP_MEMORY_SCOPE = "demo-top-up-memory";

type Phase = "all" | "dates" | "portraits" | "memories" | "audit";

export interface TopUpCliOptions {
  apply: boolean;
  phase: Phase;
  only: Set<string>;
}

interface DemoContext {
  admin: SupabaseClient;
  user: SupabaseClient;
  userId: string;
  familyId: string;
  memberIds: Map<string, string>;
  baselineSources: Map<string, SourceSnapshot>;
  sourcesByMember: Map<string, SourceSnapshot[]>;
}

interface SourceSnapshot {
  memberSlug: string;
  referenceDate: string;
  objectKey: string;
  bytes: Uint8Array;
  versionId: string;
}

interface MediaAssetRow {
  objectKey: string;
  contentType: "image/jpeg";
  aspectRatio: number;
}

interface LookingBackPackageRow {
  package_id: string | null;
  memory_ids: string[];
}

function status(slug: string, state: string, id?: string): void {
  console.log(JSON.stringify({ slug, state, ...(id ? { id } : {}) }));
}

function slugify(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(
    /^-+|-+$/g,
    "",
  );
}

function isIsoDate(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value);
}

function compareDates(left: string, right: string): number {
  return left.localeCompare(right);
}

export function parseArgs(args: string[]): TopUpCliOptions {
  const options: TopUpCliOptions = {
    apply: false,
    phase: "all",
    only: new Set(),
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--apply") {
      options.apply = true;
      continue;
    }
    if (arg === "--audit") {
      options.phase = "audit";
      continue;
    }
    if (arg === "--phase") {
      const phase = args[index + 1] as Phase | undefined;
      if (
        !phase ||
        !["all", "dates", "portraits", "memories", "audit"].includes(phase)
      ) {
        throw new Error(
          "--phase must be all, dates, portraits, memories, or audit",
        );
      }
      options.phase = phase;
      index += 1;
      continue;
    }
    if (arg === "--only") {
      const slug = args[index + 1];
      if (!slug) throw new Error("--only requires a slug");
      options.only.add(slugify(slug));
      index += 1;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  return options;
}

export function shouldRun(
  options: TopUpCliOptions,
  slug: string,
): boolean {
  return options.only.size === 0 || options.only.has(slugify(slug));
}

function assertTopUpSpec(): void {
  const memberSlugs = new Set<string>(
    DEMO_FAMILY_MEMBERS.map((member) => member.slug),
  );
  const originalMemorySlugs = new Set<string>(
    DEMO_MEMORIES.map((memory) => memory.slug),
  );
  const topUpMemorySlugs = new Set<string>();
  const topUpPortraitSlugs = new Set<string>();

  if (DEMO_TOP_UP_MEMORIES.length !== 36) {
    throw new Error("The demo top-up must contain exactly 36 memories");
  }

  const portraitsByMember = new Map<string, number>();
  for (const portrait of DEMO_TOP_UP_PORTRAITS) {
    if (topUpPortraitSlugs.has(portrait.slug)) {
      throw new Error(`Duplicate top-up portrait slug: ${portrait.slug}`);
    }
    topUpPortraitSlugs.add(portrait.slug);
    if (!memberSlugs.has(portrait.memberSlug)) {
      throw new Error(`Unknown portrait member: ${portrait.memberSlug}`);
    }
    if (!isIsoDate(portrait.referenceDate)) {
      throw new Error(`Invalid portrait date: ${portrait.slug}`);
    }
    if (!portrait.wardrobe.trim()) {
      throw new Error(`Historical portrait needs a wardrobe: ${portrait.slug}`);
    }
    if (compareDates(portrait.referenceDate, DEMO_BASELINE_PORTRAIT_DATE) >= 0) {
      throw new Error(
        `Top-up portrait must predate the baseline: ${portrait.slug}`,
      );
    }
    portraitsByMember.set(
      portrait.memberSlug,
      (portraitsByMember.get(portrait.memberSlug) ?? 0) + 1,
    );
  }
  if (
    portraitsByMember.get("maya-kim-ortiz") !== 5 ||
    portraitsByMember.get("theo-kim-ortiz") !== 3 ||
    portraitsByMember.get("ari-kim-ortiz") !== 2
  ) {
    throw new Error("Historical portrait counts no longer match the age plan");
  }
  for (const memberSlug of ["maya-kim-ortiz", "theo-kim-ortiz", "ari-kim-ortiz"]) {
    const wardrobes = DEMO_TOP_UP_PORTRAITS
      .filter((portrait) => portrait.memberSlug === memberSlug)
      .map((portrait) => portrait.wardrobe);
    if (new Set(wardrobes).size !== wardrobes.length) {
      throw new Error(`Historical portrait wardrobes repeat for ${memberSlug}`);
    }
  }

  const recentMemories = DEMO_TOP_UP_MEMORIES.filter((memory) =>
    compareDates(memory.memoryDate, "2026-07-19") >= 0 &&
    compareDates(memory.memoryDate, DEMO_TOP_UP_CURRENT_DATE) <= 0
  );
  const archiveMemories = DEMO_TOP_UP_MEMORIES.filter((memory) =>
    compareDates(memory.memoryDate, "2026-05-13") <= 0
  );
  if (recentMemories.length !== 12 || archiveMemories.length !== 24) {
    throw new Error("The top-up date plan must contain 12 recent and 24 archive memories");
  }

  for (const memory of DEMO_TOP_UP_MEMORIES) {
    if (topUpMemorySlugs.has(memory.slug)) {
      throw new Error(`Duplicate top-up memory slug: ${memory.slug}`);
    }
    if (originalMemorySlugs.has(memory.slug)) {
      throw new Error(`Top-up memory collides with original fixture: ${memory.slug}`);
    }
    topUpMemorySlugs.add(memory.slug);
    if (!isIsoDate(memory.memoryDate) || !memory.caption.trim()) {
      throw new Error(`Invalid top-up memory: ${memory.slug}`);
    }
    if (memory.caption.includes("—")) {
      throw new Error(`Top-up caption contains an em dash: ${memory.slug}`);
    }
    const tagSlugs = [...memory.tagSlugs] as string[];
    if (tagSlugs.length === 0) {
      throw new Error(`Top-up memory needs a tag: ${memory.slug}`);
    }
    if (tagSlugs.some((slug) => !memberSlugs.has(slug))) {
      throw new Error(`Top-up memory has an unknown tag: ${memory.slug}`);
    }
    if (
      memory.memoryType === "text_illustration" &&
      memory.tagSlugs.length > 6
    ) {
      throw new Error(`Top-up illustration exceeds six tags: ${memory.slug}`);
    }
    if (memory.memoryType === "media") {
      const mediaAssets = "mediaAssets" in memory ? memory.mediaAssets : undefined;
      if (!mediaAssets || mediaAssets.length < 1 || mediaAssets.length > 10) {
        throw new Error(`Invalid top-up media asset count: ${memory.slug}`);
      }
      const assetSlugs = new Set<string>();
      for (const asset of mediaAssets) {
        if (assetSlugs.has(asset.slug)) {
          throw new Error(`Duplicate top-up asset slug: ${memory.slug}/${asset.slug}`);
        }
        assetSlugs.add(asset.slug);
        const assetMemberSlugs = [...asset.memberSlugs] as string[];
        if (
          assetMemberSlugs.length === 0 ||
          assetMemberSlugs.some((slug) => !memberSlugs.has(slug))
        ) {
          throw new Error(`Invalid top-up asset references: ${memory.slug}/${asset.slug}`);
        }
      }
    } else if ("mediaAssets" in memory && memory.mediaAssets) {
      throw new Error(`Non-media top-up memory has media assets: ${memory.slug}`);
    }
  }

  const originalMemoryBySlug = new Map(
    DEMO_MEMORIES.map((memory) => [memory.slug, memory]),
  );
  const dateUpdateSlugs = new Set<string>();
  for (const update of DEMO_EXISTING_MEMORY_DATE_UPDATES) {
    if (dateUpdateSlugs.has(update.memorySlug)) {
      throw new Error(`Duplicate existing-memory date update: ${update.memorySlug}`);
    }
    dateUpdateSlugs.add(update.memorySlug);
    const original = originalMemoryBySlug.get(update.memorySlug);
    if (!original || original.memoryDate !== update.expectedCurrentDate) {
      throw new Error(`Date update does not match the original fixture: ${update.memorySlug}`);
    }
    if (!isIsoDate(update.targetDate) || compareDates(update.targetDate, "2026-05-13") > 0) {
      throw new Error(`Date update is not an archive date: ${update.memorySlug}`);
    }
  }
}

async function connectToDemo(): Promise<DemoContext> {
  const admin = createAdmin();
  const authUser = await findUserByEmail(admin, DEMO_ACCOUNT_EMAIL);
  if (!authUser) {
    throw new Error(`Demo account was not found: ${DEMO_ACCOUNT_EMAIL}`);
  }

  const session = await createUserClient(admin, DEMO_ACCOUNT_EMAIL);
  if (session.userId !== authUser.id) {
    throw new Error("Demo session user did not match the located auth user");
  }

  const { data: memberships, error: membershipsError } = await session.user
    .from("family_memberships")
    .select("family_id, role, family:families(id, name, deleted_at)")
    .eq("role", "owner");
  if (membershipsError) {
    throw new Error(`Could not load demo family: ${membershipsError.message}`);
  }
  const familyMembership = (memberships ?? []).find((membership) => {
    const family = Array.isArray(membership.family)
      ? membership.family[0]
      : membership.family;
    return family?.name === DEMO_FAMILY.name && !family.deleted_at;
  });
  if (!familyMembership) {
    throw new Error(`Demo family was not found: ${DEMO_FAMILY.name}`);
  }

  const familyId = familyMembership.family_id as string;
  const memberIds = new Map<string, string>();
  for (const member of DEMO_FAMILY_MEMBERS) {
    memberIds.set(
      member.slug,
      await deterministicUuid(BASELINE_MEMBER_SCOPE, member.slug),
    );
  }

  const { data: members, error: membersError } = await session.user
    .from("family_members")
    .select("id, family_id")
    .eq("family_id", familyId);
  if (membersError) {
    throw new Error(`Could not load demo members: ${membersError.message}`);
  }
  const memberIdSet = new Set((members ?? []).map((member) => member.id));
  for (const [slug, memberId] of memberIds) {
    if (!memberIdSet.has(memberId)) {
      throw new Error(`Expected demo member is missing: ${slug}`);
    }
  }

  return {
    admin,
    user: session.user,
    userId: session.userId,
    familyId,
    memberIds,
    baselineSources: new Map(),
    sourcesByMember: new Map(),
  };
}

async function loadBaselineSources(context: DemoContext): Promise<void> {
  for (const member of DEMO_FAMILY_MEMBERS) {
    const memberId = context.memberIds.get(member.slug);
    if (!memberId) throw new Error(`Missing member id for ${member.slug}`);
    const versionId = await deterministicUuid(BASELINE_PORTRAIT_SCOPE, member.slug);
    const { data: version, error } = await context.user
      .from("family_member_portrait_versions")
      .select(
        "id, family_id, family_member_id, reference_date, profile_picture_key, illustrated_profile_status, illustrated_profile_key",
      )
      .eq("id", versionId)
      .maybeSingle();
    if (error) {
      throw new Error(`Could not load baseline portrait ${member.slug}: ${error.message}`);
    }
    if (
      !version ||
      version.family_id !== context.familyId ||
      version.family_member_id !== memberId ||
      version.reference_date !== DEMO_BASELINE_PORTRAIT_DATE ||
      version.illustrated_profile_status !== "ready" ||
      !version.illustrated_profile_key ||
      !version.profile_picture_key
    ) {
      throw new Error(`Baseline portrait is not ready for ${member.slug}`);
    }
    const bytes = await getObjectBytes(version.profile_picture_key);
    await assertGeneratedImage(bytes);
    const snapshot: SourceSnapshot = {
      memberSlug: member.slug,
      referenceDate: version.reference_date,
      objectKey: version.profile_picture_key,
      bytes,
      versionId,
    };
    context.baselineSources.set(member.slug, snapshot);
    context.sourcesByMember.set(member.slug, [snapshot]);
  }
}

async function ensurePortraitSource(
  context: DemoContext,
  portrait: DemoTopUpPortraitSpec,
  versionId: string,
  sourceKey: string,
  existingProfilePictureKey: string | null,
): Promise<Uint8Array> {
  if (existingProfilePictureKey && existingProfilePictureKey !== sourceKey) {
    throw new Error(`Top-up portrait source key changed: ${portrait.slug}`);
  }
  try {
    const bytes = await getObjectBytes(sourceKey);
    await assertGeneratedImage(bytes);
    status(portrait.slug, "source_reused", versionId);
    return bytes;
  } catch (error) {
    if (existingProfilePictureKey && existingProfilePictureKey !== sourceKey) {
      throw error;
    }
    const reference = context.baselineSources.get(portrait.memberSlug);
    if (!reference) {
      throw new Error(`Missing baseline reference for ${portrait.slug}`);
    }
    const bytes = await withRetries(() =>
      generateImage(portrait.prompt, "high", [reference.bytes])
    );
    if (bytes.byteLength > MAX_IMAGE_BYTES) {
      throw new Error(`Generated portrait source exceeds 20 MB: ${portrait.slug}`);
    }
    await assertGeneratedImage(bytes);
    await putObjectBytes(sourceKey, bytes, "image/jpeg");
    status(portrait.slug, "source_created", versionId);
    return bytes;
  }
}

async function removeReplacedPortraitVersion(
  context: DemoContext,
  portrait: DemoTopUpPortraitSpec,
): Promise<void> {
  if (!shouldRun(currentOptions, portrait.slug)) return;
  const oldVersionId = await deterministicUuid(
    OLD_TOP_UP_PORTRAIT_SCOPE,
    portrait.slug,
  );
  const memberId = context.memberIds.get(portrait.memberSlug);
  if (!memberId) throw new Error(`Missing member id for ${portrait.memberSlug}`);

  const { data: existing, error } = await context.user
    .from("family_member_portrait_versions")
    .select(
      "id, family_id, family_member_id, reference_date, date_source, illustrated_profile_status",
    )
    .eq("id", oldVersionId)
    .maybeSingle();
  if (error) {
    throw new Error(`Could not load replaced portrait ${portrait.slug}: ${error.message}`);
  }
  if (!existing) return;
  if (
    existing.family_id !== context.familyId ||
    existing.family_member_id !== memberId ||
    existing.reference_date !== portrait.referenceDate ||
    existing.date_source !== "manual"
  ) {
    throw new Error(`Refusing to remove unexpected portrait version: ${portrait.slug}`);
  }

  const { error: deleteError } = await context.user.functions.invoke(
    "delete-portrait-version",
    { body: { portraitVersionId: oldVersionId } },
  );
  if (deleteError) {
    throw new Error(`Could not replace portrait ${portrait.slug}: ${deleteError.message}`);
  }

  const { data: remaining, error: remainingError } = await context.user
    .from("family_member_portrait_versions")
    .select("id")
    .eq("id", oldVersionId)
    .maybeSingle();
  if (remainingError) {
    throw new Error(`Could not verify portrait replacement ${portrait.slug}: ${remainingError.message}`);
  }
  if (remaining) {
    throw new Error(`Portrait replacement did not remove the old version: ${portrait.slug}`);
  }
  status(portrait.slug, "old_portrait_removed", oldVersionId);
}

async function removeReplacedPortraitVersions(context: DemoContext): Promise<void> {
  for (const portrait of DEMO_TOP_UP_PORTRAITS) {
    await removeReplacedPortraitVersion(context, portrait);
  }
}

async function seedPortrait(
  context: DemoContext,
  portrait: DemoTopUpPortraitSpec,
): Promise<void> {
  if (!shouldRun(currentOptions, portrait.slug)) return;
  const memberId = context.memberIds.get(portrait.memberSlug);
  if (!memberId) throw new Error(`Missing member id for ${portrait.memberSlug}`);
  const versionId = await deterministicUuid(TOP_UP_PORTRAIT_SCOPE, portrait.slug);
  const sourceKey = buildPortraitVersionPhotoKey(
    context.userId,
    memberId,
    versionId,
  );
  const { data: existing, error: existingError } = await context.user
    .from("family_member_portrait_versions")
    .select(
      "id, family_id, family_member_id, reference_date, date_source, profile_picture_key, illustrated_profile_status, illustrated_profile_key",
    )
    .eq("id", versionId)
    .maybeSingle();
  if (existingError) {
    throw new Error(`Could not load top-up portrait ${portrait.slug}: ${existingError.message}`);
  }
  if (
    existing &&
    (existing.family_id !== context.familyId ||
      existing.family_member_id !== memberId ||
      existing.reference_date !== portrait.referenceDate ||
      existing.date_source !== "manual")
  ) {
    throw new Error(`Top-up portrait metadata changed: ${portrait.slug}`);
  }

  const bytes = await ensurePortraitSource(
    context,
    portrait,
    versionId,
    sourceKey,
    existing?.profile_picture_key ?? null,
  );
  if (!existing) {
    const { error } = await context.user.rpc(
      "create_family_member_portrait_version",
      {
        version_id: versionId,
        target_family_member_id: memberId,
        portrait_reference_date: portrait.referenceDate,
        portrait_date_source: "manual",
        source_profile_picture_key: sourceKey,
      },
    );
    if (error) {
      throw new Error(`Could not create top-up portrait ${portrait.slug}: ${error.message}`);
    }
    status(portrait.slug, "version_created", versionId);
  }

  let portraitStatus = existing?.illustrated_profile_status ?? "pending";
  if (portraitStatus !== "ready") {
    const getPortraitStatus = async () => {
      const { data, error } = await context.user
        .from("family_member_portrait_versions")
        .select("illustrated_profile_status")
        .eq("id", versionId)
        .single();
      if (error) throw new Error(`Could not poll portrait ${portrait.slug}: ${error.message}`);
      return data.illustrated_profile_status as string;
    };
    await invokeUntilReady(
      getPortraitStatus,
      async () => {
        const { error } = await context.user.functions.invoke(
          "generate-portrait-illustration",
          { body: { portraitVersionId: versionId } },
        );
        if (error) {
          throw new Error(`Could not queue portrait ${portrait.slug}: ${error.message}`);
        }
      },
      2,
      PORTRAIT_POLL_ATTEMPTS,
    );
    portraitStatus = await getPortraitStatus();
  }
  if (portraitStatus !== "ready") {
    throw new Error(`Top-up portrait did not become ready: ${portrait.slug}`);
  }

  context.sourcesByMember.get(portrait.memberSlug)?.push({
    memberSlug: portrait.memberSlug,
    referenceDate: portrait.referenceDate,
    objectKey: sourceKey,
    bytes,
    versionId,
  });
  status(portrait.slug, "portrait_ready", versionId);
}

function sourceForMemory(
  context: DemoContext,
  memberSlug: string,
  memoryDate: string,
): SourceSnapshot {
  const sources = context.sourcesByMember.get(memberSlug) ?? [];
  if (sources.length === 0) {
    throw new Error(`No source photos available for ${memberSlug}`);
  }
  const before = sources
    .filter((source) => compareDates(source.referenceDate, memoryDate) <= 0)
    .sort((left, right) => compareDates(right.referenceDate, left.referenceDate));
  if (before[0]) return before[0];
  const after = [...sources].sort((left, right) =>
    compareDates(left.referenceDate, right.referenceDate)
  );
  return after[0];
}

async function createPhotoAsset(
  context: DemoContext,
  memoryId: string,
  memoryDate: string,
  asset: NonNullable<DemoTopUpMemorySpec["mediaAssets"]>[number],
): Promise<MediaAssetRow> {
  const assetId = await deterministicUuid(`asset:${memoryId}`, asset.slug);
  const objectKey = buildMemoryMediaAssetKey(
    context.userId,
    memoryId,
    assetId,
    "jpg",
  );
  try {
    const bytes = await getObjectBytes(objectKey);
    await assertGeneratedImage(bytes);
    status(asset.slug, "source_reused", assetId);
  } catch {
    const references = asset.memberSlugs.map((memberSlug) =>
      sourceForMemory(context, memberSlug, memoryDate).bytes
    );
    const bytes = await withRetries(() =>
      generateImage(asset.prompt, "medium", references)
    );
    if (bytes.byteLength > MAX_IMAGE_BYTES) {
      throw new Error(`Generated media photo exceeds 20 MB: ${asset.slug}`);
    }
    await assertGeneratedImage(bytes);
    await putObjectBytes(objectKey, bytes, "image/jpeg");
    status(asset.slug, "source_created", assetId);
  }
  return {
    objectKey,
    contentType: "image/jpeg",
    aspectRatio: GENERATED_IMAGE_ASPECT_RATIO,
  };
}

async function analyzeEmotionOrThrow(
  context: DemoContext,
  memoryId: string,
  slug: string,
): Promise<{ colorPalette?: string }> {
  const { data, error } = await context.user.functions.invoke<{
    colorPalette?: string;
  }>("analyze-emotion", { body: { memoryId } });
  if (error) {
    throw new Error(`Could not analyze emotion ${slug}: ${error.message}`);
  }
  return data ?? {};
}

async function seedMemory(
  context: DemoContext,
  memory: DemoTopUpMemorySpec,
): Promise<void> {
  if (!shouldRun(currentOptions, memory.slug)) return;
  const memoryId = await deterministicUuid(TOP_UP_MEMORY_SCOPE, memory.slug);
  const { data: existing, error: existingError } = await context.user
    .from("memories")
    .select("id, family_id, content, memory_date, memory_type, illustration_status, emotion")
    .eq("id", memoryId)
    .maybeSingle();
  if (existingError) {
    throw new Error(`Could not load top-up memory ${memory.slug}: ${existingError.message}`);
  }
  if (
    existing &&
    (existing.family_id !== context.familyId ||
      existing.content !== memory.caption ||
      existing.memory_date !== memory.memoryDate ||
      existing.memory_type !== memory.memoryType)
  ) {
    throw new Error(`Top-up memory metadata changed: ${memory.slug}`);
  }

  let generatedMediaAssets: MediaAssetRow[] | null = null;
  if (!existing && memory.memoryType === "media") {
    generatedMediaAssets = [];
    for (const asset of memory.mediaAssets ?? []) {
      generatedMediaAssets.push(
        await createPhotoAsset(context, memoryId, memory.memoryDate, asset),
      );
    }
  }

  if (!existing) {
    const { error } = await context.user.from("memories").insert({
      id: memoryId,
      user_id: context.userId,
      family_id: context.familyId,
      content: memory.caption,
      memory_date: memory.memoryDate,
      memory_type: memory.memoryType,
      illustration_status: memory.memoryType === "text_illustration"
        ? "pending"
        : "none",
      ...(generatedMediaAssets?.[0]
        ? {
          media_key: generatedMediaAssets[0].objectKey,
          media_content_type: generatedMediaAssets[0].contentType,
        }
        : {}),
    });
    if (error) {
      throw new Error(`Could not create top-up memory ${memory.slug}: ${error.message}`);
    }
    status(memory.slug, "memory_created", memoryId);
  }

  const rows = memory.tagSlugs.map((tag) => ({
    memory_id: memoryId,
    family_member_id: context.memberIds.get(tag),
  }));
  if (rows.some((row) => !row.family_member_id)) {
    throw new Error(`Top-up memory has an unresolved tag: ${memory.slug}`);
  }
  const { error: tagError } = await context.user
    .from("memory_family_members")
    .upsert(rows as Array<{ memory_id: string; family_member_id: string }>, {
      onConflict: "memory_id,family_member_id",
      ignoreDuplicates: true,
    });
  if (tagError) {
    throw new Error(`Could not tag top-up memory ${memory.slug}: ${tagError.message}`);
  }

  if (memory.memoryType === "media") {
    const { data: existingAssets, error: assetsError } = await context.user
      .from("memory_media")
      .select("id, position, object_key, content_type, aspect_ratio")
      .eq("memory_id", memoryId)
      .order("position", { ascending: true });
    if (assetsError) {
      throw new Error(`Could not load top-up media ${memory.slug}: ${assetsError.message}`);
    }
    const expectedAssets = generatedMediaAssets ?? await Promise.all(
      (memory.mediaAssets ?? []).map((asset) =>
        createPhotoAsset(context, memoryId, memory.memoryDate, asset)
      ),
    );
    if ((existingAssets?.length ?? 0) === 0) {
      const { error } = await context.user.rpc("replace_memory_media_assets", {
        target_memory_id: memoryId,
        assets: expectedAssets,
      });
      if (error) {
        throw new Error(`Could not attach top-up media ${memory.slug}: ${error.message}`);
      }
    } else {
      if (existingAssets.length !== expectedAssets.length) {
        throw new Error(`Top-up media asset count changed: ${memory.slug}`);
      }
      for (const [position, asset] of expectedAssets.entries()) {
        const existingAsset = existingAssets[position];
        if (
          existingAsset.position !== position ||
          existingAsset.object_key !== asset.objectKey ||
          existingAsset.content_type !== asset.contentType
        ) {
          throw new Error(`Top-up media ordering changed: ${memory.slug}`);
        }
      }
    }
    const { data: emotionRow, error: emotionError } = await context.user
      .from("memories")
      .select("emotion")
      .eq("id", memoryId)
      .single();
    if (emotionError) {
      throw new Error(`Could not check top-up media emotion ${memory.slug}: ${emotionError.message}`);
    }
    if (!emotionRow.emotion) {
      await analyzeEmotionOrThrow(context, memoryId, memory.slug);
    }
  } else if (memory.memoryType === "text_illustration") {
    const getIllustrationStatus = async () => {
      const { data, error } = await context.user
        .from("memories")
        .select("illustration_status")
        .eq("id", memoryId)
        .single();
      if (error) {
        throw new Error(`Could not poll top-up illustration ${memory.slug}: ${error.message}`);
      }
      return data.illustration_status as string;
    };
    if ((await getIllustrationStatus()) !== "ready") {
      const emotionData = await analyzeEmotionOrThrow(context, memoryId, memory.slug);
      await invokeUntilReady(
        getIllustrationStatus,
        async () => {
          const { error } = await context.user.functions.invoke(
            "generate-illustration",
            {
              body: {
                memoryId,
                ...(emotionData.colorPalette
                  ? { colorPalette: emotionData.colorPalette }
                  : {}),
              },
            },
          );
          if (error) {
            throw new Error(`Could not queue top-up illustration ${memory.slug}: ${error.message}`);
          }
        },
        2,
        ILLUSTRATION_POLL_ATTEMPTS,
      );
    }
  } else {
    const { data: emotionRow, error: emotionError } = await context.user
      .from("memories")
      .select("emotion")
      .eq("id", memoryId)
      .single();
    if (emotionError) {
      throw new Error(`Could not check top-up text emotion ${memory.slug}: ${emotionError.message}`);
    }
    if (!emotionRow.emotion) {
      await analyzeEmotionOrThrow(context, memoryId, memory.slug);
    }
  }
  status(memory.slug, "ready", memoryId);
}

async function applyExistingMemoryDateUpdates(
  context: DemoContext,
): Promise<void> {
  for (const update of DEMO_EXISTING_MEMORY_DATE_UPDATES) {
    if (!shouldRun(currentOptions, update.memorySlug)) continue;
    const memoryId = await deterministicUuid("memory", update.memorySlug);
    const { data: memory, error } = await context.user
      .from("memories")
      .select("id, family_id, memory_date")
      .eq("id", memoryId)
      .maybeSingle();
    if (error) {
      throw new Error(`Could not load existing memory date ${update.memorySlug}: ${error.message}`);
    }
    if (!memory || memory.family_id !== context.familyId) {
      throw new Error(`Existing memory is missing from the demo family: ${update.memorySlug}`);
    }
    if (memory.memory_date === update.targetDate) {
      status(update.memorySlug, "date_already_updated", memoryId);
      continue;
    }
    if (memory.memory_date !== update.expectedCurrentDate) {
      throw new Error(
        `Refusing to change manually-edited memory date ${update.memorySlug}: found ${memory.memory_date}`,
      );
    }
    const { error: updateError } = await context.user
      .from("memories")
      .update({ memory_date: update.targetDate })
      .eq("id", memoryId)
      .eq("family_id", context.familyId);
    if (updateError) {
      throw new Error(`Could not update existing memory date ${update.memorySlug}: ${updateError.message}`);
    }
    status(update.memorySlug, "date_updated", memoryId);
  }
}

async function auditDemoAccount(context: DemoContext): Promise<void> {
  const { data: members, error: membersError } = await context.admin
    .from("family_members")
    .select("id")
    .eq("family_id", context.familyId);
  if (membersError) throw new Error(`Could not audit members: ${membersError.message}`);
  const { data: versions, error: versionsError } = await context.admin
    .from("family_member_portrait_versions")
    .select("id, family_member_id, reference_date, illustrated_profile_status")
    .eq("family_id", context.familyId);
  if (versionsError) throw new Error(`Could not audit portraits: ${versionsError.message}`);
  const { data: memories, error: memoriesError } = await context.admin
    .from("memories")
    .select("id, memory_date, memory_type")
    .eq("family_id", context.familyId)
    .order("memory_date", { ascending: false });
  if (memoriesError) throw new Error(`Could not audit memories: ${memoriesError.message}`);
  const { data: media, error: mediaError } = await context.admin
    .from("memory_media")
    .select("memory_id, content_type, position")
    .in("memory_id", (memories ?? []).map((memory) => memory.id));
  if (mediaError) throw new Error(`Could not audit media: ${mediaError.message}`);
  const { data: dailySets, error: dailySetError } = await context.admin
    .from("looking_back_daily_sets")
    .select("id, package_date, refresh_after")
    .eq("family_id", context.familyId)
    .order("package_date", { ascending: false })
    .limit(3);
  if (dailySetError) throw new Error(`Could not audit Looking Back sets: ${dailySetError.message}`);

  const latestDailySet = dailySets?.[0];
  let latestPackages: Array<{ id: string; memoryCount: number }> = [];
  if (latestDailySet?.id) {
    const { data: packageRows, error: packageError } = await context.admin
      .from("looking_back_packages")
      .select("id")
      .eq("daily_set_id", latestDailySet.id);
    if (packageError) {
      throw new Error(`Could not audit Looking Back packages: ${packageError.message}`);
    }
    for (const packageRow of packageRows ?? []) {
      const { count, error: itemError } = await context.admin
        .from("looking_back_package_memories")
        .select("memory_id", { count: "exact", head: true })
        .eq("package_id", packageRow.id);
      if (itemError) {
        throw new Error(`Could not audit Looking Back package items: ${itemError.message}`);
      }
      latestPackages.push({ id: packageRow.id, memoryCount: count ?? 0 });
    }
  }

  const dates = (memories ?? []).map((memory) => memory.memory_date).sort();
  const archiveCount = (memories ?? []).filter((memory) =>
    compareDates(memory.memory_date, "2026-05-13") <= 0
  ).length;
  console.log(JSON.stringify({
    state: "audit",
    familyId: context.familyId,
    memberCount: members?.length ?? 0,
    portraitVersionCount: versions?.length ?? 0,
    readyPortraitVersionCount: (versions ?? []).filter((version) =>
      version.illustrated_profile_status === "ready"
    ).length,
    memoryCount: memories?.length ?? 0,
    mediaAssetCount: media?.length ?? 0,
    archiveEligibleMemoryCount: archiveCount,
    oldestMemoryDate: dates[0] ?? null,
    newestMemoryDate: dates.at(-1) ?? null,
    lookingBackDailySetCount: dailySets?.length ?? 0,
    latestLookingBackPackageDate: latestDailySet?.package_date ?? null,
    latestLookingBackPackages: latestPackages,
    memoryDateTypes: (memories ?? []).map((memory) => ({
      date: memory.memory_date,
      type: memory.memory_type,
    })),
  }));
}

async function verifyTopUp(context: DemoContext): Promise<void> {
  const portraitIds = await Promise.all(
    DEMO_TOP_UP_PORTRAITS.map((portrait) =>
      deterministicUuid(TOP_UP_PORTRAIT_SCOPE, portrait.slug)
    ),
  );
  const { data: versions, error: versionsError } = await context.user
    .from("family_member_portrait_versions")
    .select("id, family_id, family_member_id, reference_date, profile_picture_key, illustrated_profile_status, illustrated_profile_key")
    .in("id", portraitIds);
  if (versionsError || (versions ?? []).length !== portraitIds.length) {
    throw new Error("Top-up portrait verification failed");
  }
  if ((versions ?? []).some((version) =>
    version.family_id !== context.familyId ||
    version.illustrated_profile_status !== "ready" ||
    !version.illustrated_profile_key
  )) {
    throw new Error("Top-up portrait readiness verification failed");
  }

  const memoryIds = await Promise.all(
    DEMO_TOP_UP_MEMORIES.map((memory) =>
      deterministicUuid(TOP_UP_MEMORY_SCOPE, memory.slug)
    ),
  );
  const { data: memories, error: memoriesError } = await context.user
    .from("memories")
    .select("id, family_id, content, memory_date, memory_type, illustration_status, illustration_key")
    .in("id", memoryIds);
  if (memoriesError || (memories ?? []).length !== memoryIds.length) {
    throw new Error("Top-up memory verification failed");
  }
  const memoriesById = new Map((memories ?? []).map((memory) => [memory.id, memory]));
  for (const memorySpec of DEMO_TOP_UP_MEMORIES) {
    const memoryId = await deterministicUuid(TOP_UP_MEMORY_SCOPE, memorySpec.slug);
    const memory = memoriesById.get(memoryId);
    if (
      !memory ||
      memory.family_id !== context.familyId ||
      memory.content !== memorySpec.caption ||
      memory.memory_date !== memorySpec.memoryDate ||
      memory.memory_type !== memorySpec.memoryType
    ) {
      throw new Error(`Top-up memory metadata verification failed: ${memorySpec.slug}`);
    }
    if (
      memorySpec.memoryType === "text_illustration" &&
      (memory.illustration_status !== "ready" || !memory.illustration_key)
    ) {
      throw new Error(`Top-up illustration verification failed: ${memorySpec.slug}`);
    }
  }

  const mediaMemoryIds = DEMO_TOP_UP_MEMORIES
    .filter((memory) => memory.memoryType === "media")
    .map((memory) => memoryIds[DEMO_TOP_UP_MEMORIES.indexOf(memory)]);
  const { data: media, error: mediaError } = await context.user
    .from("memory_media")
    .select("memory_id, position, object_key, content_type, aspect_ratio")
    .in("memory_id", mediaMemoryIds)
    .order("memory_id", { ascending: true })
    .order("position", { ascending: true });
  if (mediaError) throw new Error(`Top-up media verification failed: ${mediaError.message}`);
  if ((media ?? []).some((asset) => asset.content_type !== "image/jpeg")) {
    throw new Error("Top-up contains a non-photo media asset");
  }

  for (const update of DEMO_EXISTING_MEMORY_DATE_UPDATES) {
    const memoryId = await deterministicUuid("memory", update.memorySlug);
    const { data: memory, error } = await context.user
      .from("memories")
      .select("memory_date")
      .eq("id", memoryId)
      .single();
    if (error || memory?.memory_date !== update.targetDate) {
      throw new Error(`Existing memory date verification failed: ${update.memorySlug}`);
    }
  }

  const { data: packages, error: packagesError } = await context.user.rpc(
    "get_or_create_looking_back_packages",
    { p_family_id: context.familyId },
  );
  if (packagesError) {
    throw new Error(`Could not materialize Looking Back packages: ${packagesError.message}`);
  }
  const packageRows = (packages ?? []) as LookingBackPackageRow[];
  const eligiblePackages = packageRows.filter((row) =>
    Boolean(row.package_id) && (row.memory_ids?.length ?? 0) >= 4
  );
  if (eligiblePackages.length === 0) {
    throw new Error("Looking Back did not materialize an eligible package");
  }
  console.log(JSON.stringify({
    state: "verified",
    topUpPortraitCount: versions?.length ?? 0,
    topUpMemoryCount: memories?.length ?? 0,
    topUpMediaAssetCount: media?.length ?? 0,
    lookingBackPackageCount: eligiblePackages.length,
    lookingBackFrameCount: Math.max(
      ...eligiblePackages.map((row) => row.memory_ids.length),
    ),
  }));
}

let currentOptions: TopUpCliOptions = {
  apply: false,
  phase: "all",
  only: new Set(),
};

async function run(): Promise<void> {
  currentOptions = parseArgs(Deno.args);
  assertTopUpSpec();

  if (!currentOptions.apply && currentOptions.phase !== "audit") {
    console.log(JSON.stringify({
      state: "dry_run",
      currentDate: DEMO_TOP_UP_CURRENT_DATE,
      existingMemoryDateUpdates: DEMO_EXISTING_MEMORY_DATE_UPDATES.length,
      historicalPortraitPairs: DEMO_TOP_UP_PORTRAITS.length,
      topUpMemories: DEMO_TOP_UP_MEMORIES.length,
      recentMemories: DEMO_TOP_UP_MEMORIES.filter((memory) =>
        compareDates(memory.memoryDate, "2026-07-19") >= 0
      ).length,
      archiveMemories: DEMO_TOP_UP_MEMORIES.filter((memory) =>
        compareDates(memory.memoryDate, "2026-05-13") <= 0
      ).length,
      mediaMemories: DEMO_TOP_UP_MEMORIES.filter((memory) =>
        memory.memoryType === "media"
      ).length,
      illustratedMemories: DEMO_TOP_UP_MEMORIES.filter((memory) =>
        memory.memoryType === "text_illustration"
      ).length,
      textOnlyMemories: DEMO_TOP_UP_MEMORIES.filter((memory) =>
        memory.memoryType === "text_only"
      ).length,
    }));
    return;
  }

  const context = await connectToDemo();
  if (currentOptions.phase === "audit") {
    await auditDemoAccount(context);
    return;
  }

  await loadBaselineSources(context);
  if (currentOptions.phase === "all" || currentOptions.phase === "dates") {
    await applyExistingMemoryDateUpdates(context);
  }
  if (currentOptions.phase === "all" || currentOptions.phase === "portraits") {
    await removeReplacedPortraitVersions(context);
    for (const portrait of DEMO_TOP_UP_PORTRAITS) {
      await seedPortrait(context, portrait);
    }
  }
  if (currentOptions.phase === "all" || currentOptions.phase === "memories") {
    if (currentOptions.phase === "memories") {
      // A memories-only retry is allowed, but it must not silently fall back
      // to the younger baseline photos for the historical archive frames.
      for (const portrait of DEMO_TOP_UP_PORTRAITS) {
        const versionId = await deterministicUuid(TOP_UP_PORTRAIT_SCOPE, portrait.slug);
        const { data: version, error } = await context.user
          .from("family_member_portrait_versions")
          .select("reference_date, profile_picture_key, illustrated_profile_status")
          .eq("id", versionId)
          .maybeSingle();
        if (
          error ||
          !version ||
          version.reference_date !== portrait.referenceDate ||
          version.illustrated_profile_status !== "ready" ||
          !version.profile_picture_key
        ) {
          throw new Error(`Portrait phase must complete before memory phase: ${portrait.slug}`);
        }
        const bytes = await getObjectBytes(version.profile_picture_key);
        await assertGeneratedImage(bytes);
        context.sourcesByMember.get(portrait.memberSlug)?.push({
          memberSlug: portrait.memberSlug,
          referenceDate: portrait.referenceDate,
          objectKey: version.profile_picture_key,
          bytes,
          versionId,
        });
      }
    }
    for (const memory of DEMO_TOP_UP_MEMORIES) {
      await seedMemory(context, memory);
    }
  }
  if (currentOptions.phase === "all") {
    await verifyTopUp(context);
  }
}

if (import.meta.main) {
  run().catch((error) => {
    console.error(JSON.stringify({
      state: "failed",
      error: error instanceof Error ? error.message : "unknown",
    }));
    Deno.exit(1);
  });
}
