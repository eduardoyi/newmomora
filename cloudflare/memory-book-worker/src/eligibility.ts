/**
 * Eligibility + per-memory feature building, ported from
 * supabase/scripts/eval-memory-book-outline.ts (computeMemoryEligibility,
 * buildMemoryFeature, buildTaggedMemberFeatures, firstUsablePreviewKey,
 * computeFirstPhotoOrientation) -- see docs/durable-ai-generation-workflows.md
 * and the memory-book-generation.md/CLAUDE.md task brief for why this is a
 * faithful duplicate rather than a `_shared/` extraction: the eval CLI's own
 * 3866-line file (and its test suite) stays untouched; only the pure,
 * stable pieces the Workflow actually needs are ported here.
 */
import { classifyChildOrAdult } from '../../../supabase/functions/_shared/date-context.ts';
import { getAgeInYearsAtDate } from '../../../supabase/functions/_shared/age.ts';
import { getMilestoneById } from '../../../supabase/functions/_shared/memory-milestones.ts';
import type {
  MemoryFeature,
  PhotoOrientation,
  PhotoOrientationInfo,
  TaggedMemberFeature,
} from '../../../supabase/functions/_shared/memory-book-outline.ts';
import type { DbFamilyMemberRow, DbMediaRow, DbMemoryRow, DbMilestoneRow } from './types';

const PHOTO_CONTENT_TYPE_PREFIX = 'image/';
const VIDEO_CONTENT_TYPE_PREFIX = 'video/';
const TEXT_EXCERPT_MAX_CHARS = 120;

export interface EligibilityResult {
  eligible: boolean;
  taggedToChild: boolean;
  untaggedInWindow: boolean;
}

/** A memory is eligible iff it's tagged to the subject child, or has no
 * tags at all -- a memory tagged only to OTHER family members is excluded. */
export function computeMemoryEligibility(taggedMemberIds: string[], childId: string): EligibilityResult {
  const taggedToChild = taggedMemberIds.includes(childId);
  const untaggedInWindow = taggedMemberIds.length === 0;
  return { eligible: taggedToChild || untaggedInWindow, taggedToChild, untaggedInWindow };
}

const WIDE_ASPECT_RATIO_THRESHOLD = 1.15;
const TALL_ASPECT_RATIO_THRESHOLD = 0.87;

export function classifyOrientation(aspectRatio: number): PhotoOrientation {
  if (aspectRatio > WIDE_ASPECT_RATIO_THRESHOLD) return 'wide';
  if (aspectRatio < TALL_ASPECT_RATIO_THRESHOLD) return 'tall';
  return 'square';
}

/** First PHOTO asset by `position`, straight off its own `aspect_ratio` --
 * never inferred from a later photo, never from a video. */
export function computeFirstPhotoOrientation(media: DbMediaRow[]): PhotoOrientationInfo | null {
  const sorted = [...media].sort((a, b) => a.position - b.position);
  const firstPhoto = sorted.find((m) => m.content_type.startsWith(PHOTO_CONTENT_TYPE_PREFIX));
  if (!firstPhoto || firstPhoto.aspect_ratio === null || firstPhoto.aspect_ratio === undefined) return null;
  return { orientation: classifyOrientation(firstPhoto.aspect_ratio), ratio: firstPhoto.aspect_ratio };
}

/** First row's `preview_object_key` (by `position`); falls back to that
 * row's raw `object_key` only when it's a photo (never a video's raw key). */
export function firstUsablePreviewKey(media: DbMediaRow[]): string | null {
  const sorted = [...media].sort((a, b) => a.position - b.position);
  for (const row of sorted) {
    if (row.preview_object_key) return row.preview_object_key;
    if (row.content_type.startsWith(PHOTO_CONTENT_TYPE_PREFIX)) return row.object_key;
  }
  return null;
}

export function buildTaggedMemberFeatures(
  taggedMemberIds: string[],
  membersById: Map<string, DbFamilyMemberRow>,
  memoryDate: string,
): TaggedMemberFeature[] {
  const out: TaggedMemberFeature[] = [];
  for (const id of taggedMemberIds) {
    const member = membersById.get(id);
    if (!member) continue;
    const ageYears = member.date_of_birth ? getAgeInYearsAtDate(member.date_of_birth, memoryDate) : null;
    out.push({
      firstName: member.name.trim().split(/\s+/)[0] || member.name,
      personType: classifyChildOrAdult(ageYears),
      nicknames: member.nicknames ?? [],
    });
  }
  return out;
}

export function buildMemoryFeature(
  memory: DbMemoryRow,
  media: DbMediaRow[],
  taggedMemberIds: string[],
  childId: string,
  milestoneRows: DbMilestoneRow[],
  engagementCount: number,
  taggedMembers: TaggedMemberFeature[] = [],
): MemoryFeature {
  const photoCount = media.filter((m) => m.content_type.startsWith(PHOTO_CONTENT_TYPE_PREFIX)).length;
  const videoCount = media.filter((m) => m.content_type.startsWith(VIDEO_CONTENT_TYPE_PREFIX)).length;
  const content = memory.content?.trim() ?? '';

  const childMilestoneRows = milestoneRows.filter((m) => m.family_member_id === childId);
  const nonBirthdayMilestones = childMilestoneRows.filter((m) => m.milestone_id !== 'birthday');
  const birthdayRow = childMilestoneRows.find((m) => m.milestone_id === 'birthday');

  return {
    id: memory.id,
    date: memory.memory_date,
    topics: memory.topics ?? [],
    topicDetails: memory.topic_details ?? {},
    emotion: memory.emotion,
    hasText: content.length > 0,
    excerpt: content ? content.slice(0, TEXT_EXCERPT_MAX_CHARS) : null,
    textLength: content.length,
    photoCount,
    videoCount,
    previewKey: firstUsablePreviewKey(media),
    engagementCount,
    milestones: nonBirthdayMilestones.map((m) => ({
      milestoneId: m.milestone_id,
      name: getMilestoneById(m.milestone_id)?.name ?? m.milestone_id,
      detail: m.detail,
      outOfBand: m.out_of_band,
    })),
    birthdayAgeTurned: birthdayRow?.detail ? Number(birthdayRow.detail) : null,
    taggedToChild: taggedMemberIds.includes(childId),
    taggedMembers,
    photoOrientation: computeFirstPhotoOrientation(media),
  };
}

/** `hasText || photoCount + videoCount > 0` -- the eval CLI's own
 * "printable" concept, purely code-side (no DB predicate). */
export function isPrintable(feature: MemoryFeature): boolean {
  return feature.hasText || feature.photoCount + feature.videoCount > 0;
}
