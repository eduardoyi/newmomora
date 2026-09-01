/**
 * Per-memory BookManifest assembly, ported (DB-loading logic only, no R2
 * downloads) from supabase/scripts/eval-memory-book-assets.ts. V5a asset
 * entries reference EXISTING app R2 preview objects directly -- no
 * downloads, no resizing (task brief) -- so unlike the eval CLI's export
 * pipeline, this never fetches image bytes and therefore never learns a
 * PREVIEW asset's real pixel width/height (imageSize() there runs on
 * downloaded bytes) or an ORIGINAL's dimensions (`originalWidth`/
 * `originalHeight`, `shouldMeasureOriginalDimensions`'s gate). Both are
 * DELIBERATELY omitted here (documented V5a deviation): `width`/`height`
 * are a nominal placeholder derived from the real `aspect_ratio` DB column
 * (which IS honored, via `dbAspectRatio` -- `buildManifestAsset` prefers it
 * over the width/height ratio for the manifest's own `aspectRatio` field),
 * and `originalWidth`/`originalHeight` are left unset, which
 * book-renderer's fitter already treats as "never measured" -- these
 * photos simply won't qualify for a panorama/full-bleed placement until a
 * later slice adds real dimension measurement.
 */
import {
  buildManifest,
  buildManifestAsset,
  buildManifestIllustration,
  buildManifestMemory,
  buildManifestMilestone,
  buildManifestPortrait,
  buildManifestScope,
  buildTaggedMember,
  memoryNeedsShareToken,
  type BookManifest,
  type ManifestAsset,
  type ManifestAssetKind,
  type ManifestIllustration,
  type ManifestMemory,
  type ManifestMilestone,
  type ManifestPortrait,
  type ManifestScope,
  type ManifestTaggedMember,
} from '../../../supabase/functions/_shared/memory-book-manifest.ts';
import type {
  DbFamilyMemberRow,
  DbMediaRow,
  DbMilestoneRow,
  GenerationContextResponse,
} from './types';

const PHOTO_CONTENT_TYPE_PREFIX = 'image/';
const VIDEO_CONTENT_TYPE_PREFIX = 'video/';
const FALLBACK_ELIGIBLE_CONTENT_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);

/** Nominal preview-sized placeholder (V5a has no downloaded bytes to
 * measure) -- self-consistent with the real DB `aspect_ratio` when known. */
const PLACEHOLDER_LONG_EDGE = 1280;

interface SelectedMediaAsset {
  key: string;
  kind: ManifestAssetKind;
}

export function selectMediaAsset(media: DbMediaRow): SelectedMediaAsset | null {
  if (media.preview_object_key) {
    return {
      key: media.preview_object_key,
      kind: media.content_type.startsWith(VIDEO_CONTENT_TYPE_PREFIX) ? 'video-poster' : 'photo',
    };
  }
  if (FALLBACK_ELIGIBLE_CONTENT_TYPES.has(media.content_type)) {
    return { key: media.object_key, kind: 'photo' };
  }
  return null;
}

function placeholderDimensions(aspectRatio: number | null): { width: number; height: number } {
  const ratio = aspectRatio && aspectRatio > 0 ? aspectRatio : 1;
  return ratio >= 1
    ? { width: PLACEHOLDER_LONG_EDGE, height: Math.round(PLACEHOLDER_LONG_EDGE / ratio) }
    : { width: Math.round(PLACEHOLDER_LONG_EDGE * ratio), height: PLACEHOLDER_LONG_EDGE };
}

export function buildAssetsForMemory(media: DbMediaRow[]): ManifestAsset[] {
  const sorted = [...media].sort((a, b) => a.position - b.position);
  const assets: ManifestAsset[] = [];
  for (const row of sorted) {
    const selected = selectMediaAsset(row);
    if (!selected) continue;
    const { width, height } = placeholderDimensions(row.aspect_ratio);
    assets.push(
      buildManifestAsset({
        file: selected.key,
        width,
        height,
        kind: selected.kind,
        durationMs: row.duration_ms,
        dbAspectRatio: row.aspect_ratio,
      }),
    );
  }
  return assets;
}

export interface BuildManifestInput {
  context: GenerationContextResponse;
  /** Every memory id referenced anywhere in the reading order + top-level
   * candidate arrays (see `mergeCandidateMemoryIds`/
   * `collectMemoryIdsFromElements` in the shared module -- callers compose
   * those upstream and pass the final union here). */
  memoryIds: string[];
  outlineRunId: string;
  language: 'es' | 'en';
  shareTokensByMemoryId: Map<string, string>;
}

export function buildBookManifest(input: BuildManifestInput): BookManifest {
  const { context } = input;
  const memoriesById = new Map(context.memories.map((m) => [m.id, m]));
  const mediaByMemory = new Map<string, DbMediaRow[]>();
  for (const row of context.media) {
    const list = mediaByMemory.get(row.memory_id) ?? [];
    list.push(row);
    mediaByMemory.set(row.memory_id, list);
  }
  const tagsByMemory = new Map<string, string[]>();
  for (const row of context.tags) {
    const list = tagsByMemory.get(row.memory_id) ?? [];
    list.push(row.family_member_id);
    tagsByMemory.set(row.memory_id, list);
  }
  const milestonesByMemory = new Map<string, DbMilestoneRow[]>();
  for (const row of context.milestones) {
    const list = milestonesByMemory.get(row.memory_id) ?? [];
    list.push(row);
    milestonesByMemory.set(row.memory_id, list);
  }
  const familyMembersById = new Map<string, DbFamilyMemberRow>(context.familyMembers.map((m) => [m.id, m]));

  const manifestMemories: Record<string, ManifestMemory> = {};
  for (const memoryId of input.memoryIds) {
    const memory = memoriesById.get(memoryId);
    if (!memory) continue;

    const assets = buildAssetsForMemory(mediaByMemory.get(memoryId) ?? []);

    const milestones: ManifestMilestone[] = (milestonesByMemory.get(memoryId) ?? []).map((row) =>
      buildManifestMilestone(row.milestone_id, row.detail),
    );

    const taggedMembers: ManifestTaggedMember[] = [];
    for (const familyMemberId of tagsByMemory.get(memoryId) ?? []) {
      const familyMember = familyMembersById.get(familyMemberId);
      if (!familyMember) continue;
      taggedMembers.push(
        buildTaggedMember({
          name: familyMember.name,
          dateOfBirth: familyMember.date_of_birth,
          memoryDate: memory.memory_date,
        }),
      );
    }

    const illustration: ManifestIllustration | null = memory.illustration_key
      ? buildManifestIllustration({
        file: memory.illustration_key,
        ...placeholderDimensions(1),
      })
      : null;

    const engagement = context.engagementCounts[memoryId] ?? 0;
    const shareToken = memoryNeedsShareToken(memory.memory_type, assets)
      ? input.shareTokensByMemoryId.get(memoryId) ?? null
      : null;

    manifestMemories[memoryId] = buildManifestMemory({
      memory: {
        memory_date: memory.memory_date,
        memory_type: memory.memory_type,
        content: memory.content,
        emotion: memory.emotion,
        topics: memory.topics,
      },
      assets,
      milestones,
      taggedMembers,
      engagement,
      illustration,
      shareToken,
    });
  }

  const portraits: ManifestPortrait[] = [];
  const childDateOfBirth = context.child?.dateOfBirth ?? null;
  for (const version of context.portraitVersions) {
    if (!version.reference_date || !version.illustrated_profile_key) continue;
    portraits.push(
      buildManifestPortrait({
        file: version.illustrated_profile_key,
        sourceFile: version.profile_picture_key ?? '',
        referenceDate: version.reference_date,
        dateOfBirth: childDateOfBirth,
      }),
    );
  }

  const scope: ManifestScope = buildManifestScope(
    scopeKindToOutlineType(context.book.scopeKind),
    { start: context.book.windowStart, endExclusive: context.book.windowEndExclusive, label: context.book.scopeLabel },
  );

  return buildManifest({
    child: input.context.child
      ? { id: input.context.child.id, name: input.context.child.name }
      : { id: input.context.book.familyId, name: input.context.familyName },
    scope,
    outlineRun: input.outlineRunId,
    memories: manifestMemories,
    portraits,
    language: input.language,
    downloadFailures: [],
    assetMode: 'preview',
  });
}

function scopeKindToOutlineType(scopeKind: GenerationContextResponse['book']['scopeKind']): string {
  if (scopeKind === 'age_year') return 'age-year';
  if (scopeKind === 'calendar_year') return 'calendar-year';
  return 'custom';
}
