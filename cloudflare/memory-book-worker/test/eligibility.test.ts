import { describe, expect, it } from 'vitest';
import {
  buildMemoryFeature,
  buildTaggedMemberFeatures,
  classifyOrientation,
  computeFirstPhotoOrientation,
  computeMemoryEligibility,
  firstUsablePreviewKey,
  isPrintable,
} from '../src/eligibility';
import type { DbFamilyMemberRow, DbMediaRow, DbMemoryRow, DbMilestoneRow } from '../src/types';

const CHILD_ID = '11111111-1111-1111-1111-111111111111';
const OTHER_ID = '22222222-2222-2222-2222-222222222222';

describe('computeMemoryEligibility', () => {
  it('is eligible when tagged to the subject child', () => {
    expect(computeMemoryEligibility([CHILD_ID, OTHER_ID], CHILD_ID)).toEqual({
      eligible: true,
      taggedToChild: true,
      untaggedInWindow: false,
    });
  });

  it('is eligible when untagged', () => {
    expect(computeMemoryEligibility([], CHILD_ID)).toEqual({
      eligible: true,
      taggedToChild: false,
      untaggedInWindow: true,
    });
  });

  it('is NOT eligible when tagged only to other members', () => {
    expect(computeMemoryEligibility([OTHER_ID], CHILD_ID)).toEqual({
      eligible: false,
      taggedToChild: false,
      untaggedInWindow: false,
    });
  });
});

describe('orientation classification', () => {
  it('classifies wide/tall/square by aspect ratio thresholds', () => {
    expect(classifyOrientation(2.0)).toBe('wide');
    expect(classifyOrientation(0.5)).toBe('tall');
    expect(classifyOrientation(1.0)).toBe('square');
  });

  it('reads the first PHOTO asset by position, never a video', () => {
    const media: DbMediaRow[] = [
      { id: 'm1', memory_id: 'x', object_key: 'a', preview_object_key: null, content_type: 'video/mp4', position: 0, duration_ms: 1000, aspect_ratio: 1.7 },
      { id: 'm2', memory_id: 'x', object_key: 'b', preview_object_key: null, content_type: 'image/jpeg', position: 1, duration_ms: null, aspect_ratio: 1.5 },
    ];
    expect(computeFirstPhotoOrientation(media)).toEqual({ orientation: 'wide', ratio: 1.5 });
  });

  it('is null when there is no photo or no aspect data', () => {
    expect(computeFirstPhotoOrientation([])).toBeNull();
  });
});

describe('firstUsablePreviewKey', () => {
  it('prefers preview_object_key at the lowest position', () => {
    const media: DbMediaRow[] = [
      { id: 'm1', memory_id: 'x', object_key: 'raw-0', preview_object_key: null, content_type: 'image/jpeg', position: 1, duration_ms: null, aspect_ratio: null },
      { id: 'm2', memory_id: 'x', object_key: 'raw-1', preview_object_key: 'preview-1', content_type: 'image/jpeg', position: 0, duration_ms: null, aspect_ratio: null },
    ];
    expect(firstUsablePreviewKey(media)).toBe('preview-1');
  });

  it('falls back to the raw key only for a photo, never a video', () => {
    const video: DbMediaRow[] = [
      { id: 'm1', memory_id: 'x', object_key: 'raw.mp4', preview_object_key: null, content_type: 'video/mp4', position: 0, duration_ms: 1000, aspect_ratio: null },
    ];
    expect(firstUsablePreviewKey(video)).toBeNull();

    const photo: DbMediaRow[] = [
      { id: 'm1', memory_id: 'x', object_key: 'raw.jpg', preview_object_key: null, content_type: 'image/jpeg', position: 0, duration_ms: null, aspect_ratio: null },
    ];
    expect(firstUsablePreviewKey(photo)).toBe('raw.jpg');
  });
});

describe('buildTaggedMemberFeatures', () => {
  it('reads the profile nickname list and classifies child/adult from age', () => {
    const membersById = new Map<string, DbFamilyMemberRow>([
      [CHILD_ID, { id: CHILD_ID, name: 'Enzo Rivas', date_of_birth: '2024-10-23', nicknames: ['Enzito'] }],
      [OTHER_ID, { id: OTHER_ID, name: 'Maria Rivas', date_of_birth: '1990-01-01', nicknames: [] }],
    ]);
    const features = buildTaggedMemberFeatures([CHILD_ID, OTHER_ID], membersById, '2025-01-01');
    expect(features).toEqual([
      { firstName: 'Enzo', personType: 'child', nicknames: ['Enzito'] },
      { firstName: 'Maria', personType: 'adult', nicknames: [] },
    ]);
  });

  it('skips a tagged id with no matching family member row', () => {
    expect(buildTaggedMemberFeatures(['unknown'], new Map(), '2025-01-01')).toEqual([]);
  });
});

describe('buildMemoryFeature', () => {
  const memory: DbMemoryRow = {
    id: 'mem-1',
    content: 'We went to the beach today!',
    memory_date: '2025-06-01',
    memory_type: 'text',
    emotion: 'joy',
    topics: ['beach'],
    topic_details: {},
    illustration_key: null,
  };

  it('separates the child birthday milestone from other milestones', () => {
    const milestones: DbMilestoneRow[] = [
      { memory_id: 'mem-1', family_member_id: CHILD_ID, milestone_id: 'birthday', detail: '1', out_of_band: false },
      { memory_id: 'mem-1', family_member_id: CHILD_ID, milestone_id: 'first-steps', detail: null, out_of_band: false },
      { memory_id: 'mem-1', family_member_id: OTHER_ID, milestone_id: 'birthday', detail: '30', out_of_band: false },
    ];
    const feature = buildMemoryFeature(memory, [], [CHILD_ID], CHILD_ID, milestones, 3);
    expect(feature.birthdayAgeTurned).toBe(1);
    expect(feature.milestones).toHaveLength(1);
    expect(feature.milestones[0].milestoneId).toBe('first-steps');
    expect(feature.taggedToChild).toBe(true);
    expect(feature.excerpt).toBe('We went to the beach today!');
    expect(feature.hasText).toBe(true);
    expect(feature.engagementCount).toBe(3);
  });

  it('is printable when it has text, or a photo/video, but not neither', () => {
    const textOnly = buildMemoryFeature({ ...memory, content: 'hello' }, [], [], CHILD_ID, [], 0);
    expect(isPrintable(textOnly)).toBe(true);

    const empty = buildMemoryFeature({ ...memory, content: null }, [], [], CHILD_ID, [], 0);
    expect(isPrintable(empty)).toBe(false);

    const photoOnly = buildMemoryFeature(
      { ...memory, content: null },
      [{ id: 'm1', memory_id: 'mem-1', object_key: 'a', preview_object_key: null, content_type: 'image/jpeg', position: 0, duration_ms: null, aspect_ratio: 1 }],
      [],
      CHILD_ID,
      [],
      0,
    );
    expect(isPrintable(photoOnly)).toBe(true);
  });
});
