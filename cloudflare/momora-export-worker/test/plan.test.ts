import { describe, expect, it } from 'vitest';

import { buildExportPlan, type ExportRows } from '../src/plan';

function rows(): ExportRows {
  return {
    profile: null,
    families: [{ id: 'f1', owner_id: 'owner', name: 'Los Yi', illustration_style: 'x', created_at: '2025-01-01T00:00:00Z' }],
    familyMembers: [
      { id: 'mem-enzo', family_id: 'f1', user_id: null, name: 'Enzo', nicknames: null, date_of_birth: null, gender: null, profile_picture_key: 'p/enzo.jpg', illustrated_profile_key: 'p/enzo-v2.webp', illustrated_profile_status: 'completed', additional_info: null, is_user_profile: false, created_at: '2025-01-01T00:00:00Z' },
    ],
    memories: [
      { id: 'm-2026', family_id: 'f1', user_id: 'u-adri', memory_type: 'media', content: 'Beach day', audio_transcript: null, link_previews: null, memory_date: '2026-07-01', emotion: 'joy', illustration_key: 'i/beach.webp', illustration_status: 'completed', media_key: 'u/m/1.jpg', media_content_type: 'image/jpeg', created_at: '2026-07-01T10:00:00Z' },
      { id: 'm-2025', family_id: 'f1', user_id: 'u-adri', memory_type: 'audio', content: null, audio_transcript: 'Hola', link_previews: null, memory_date: '2025-03-01', emotion: null, illustration_key: null, illustration_status: 'none', media_key: 'u/m/clip.m4a', media_content_type: 'audio/mp4', created_at: '2025-03-01T10:00:00Z' },
      { id: 'm-legacy', family_id: 'f1', user_id: null, memory_type: 'media', content: 'Old one', audio_transcript: null, link_previews: null, memory_date: '2025-03-01', emotion: null, illustration_key: null, illustration_status: 'none', media_key: 'u/m/legacy.jpg', media_content_type: 'image/jpeg', created_at: '2025-03-01T11:00:00Z' },
    ],
    memoryTags: [{ memory_id: 'm-2026', family_member_id: 'mem-enzo' }],
    memoryMedia: [
      { id: 'mm2', memory_id: 'm-2026', object_key: 'u/m/2.mp4', content_type: 'video/mp4', duration_ms: 1000, position: 1, created_at: '' },
      { id: 'mm1', memory_id: 'm-2026', object_key: 'u/m/1.jpg', content_type: 'image/jpeg', duration_ms: null, position: 0, created_at: '' },
      { id: 'mm3', memory_id: 'm-2025', object_key: 'u/m/clip.m4a', content_type: 'audio/mp4', duration_ms: 3000, position: 0, created_at: '' },
    ],
    memoryComments: [{ id: 'c1', memory_id: 'm-2026', user_id: 'u-tita', content: 'Precioso', created_at: '2026-07-02T00:00:00Z' }],
    portraitVersions: [
      { id: 'v1', family_id: 'f1', family_member_id: 'mem-enzo', user_id: null, reference_date: '2025-06-01', date_source: 'x', profile_picture_key: 'p/enzo-2025.jpg', illustrated_profile_key: 'p/enzo-v1.webp', illustrated_profile_status: 'completed', created_at: '2025-06-01T00:00:00Z' },
      // Current portrait repeated as a version: must not be exported twice.
      { id: 'v2', family_id: 'f1', family_member_id: 'mem-enzo', user_id: null, reference_date: '2026-01-01', date_source: 'x', profile_picture_key: 'p/enzo.jpg', illustrated_profile_key: 'p/enzo-v2.webp', illustrated_profile_status: 'completed', created_at: '2026-01-01T00:00:00Z' },
    ],
    userNames: { 'u-adri': 'Adrianita', 'u-tita': 'Tita' },
  };
}

describe('buildExportPlan', () => {
  const plan = buildExportPlan('job', 'owner', rows(), '2026-09-26T00:00:00Z');

  it('orders year groups oldest first and the family group last', () => {
    expect(plan.groups.map((group) => group.baseName)).toEqual([
      'Momora - Los Yi - 2025',
      'Momora - Los Yi - 2026',
      'Momora - Los Yi - Family & portraits',
    ]);
  });

  it('lays memories out by year and date with readable media names', () => {
    const [y2025, y2026] = plan.groups;
    expect(y2026.entries.map((entry) => entry.path)).toEqual([
      'Momora - Los Yi/2026/2026-07-01 - Beach day/memory.txt',
      'Momora - Los Yi/2026/2026-07-01 - Beach day/photo-1.jpg',
      'Momora - Los Yi/2026/2026-07-01 - Beach day/video-2.mp4',
      'Momora - Los Yi/2026/2026-07-01 - Beach day/illustration.webp',
    ]);
    expect(y2025.entries.map((entry) => entry.path)).toEqual([
      'Momora - Los Yi/2025/2025-03-01 - Hola/memory.txt',
      'Momora - Los Yi/2025/2025-03-01 - Hola/voice.m4a',
      'Momora - Los Yi/2025/2025-03-01 - Old one/memory.txt',
      'Momora - Los Yi/2025/2025-03-01 - Old one/photo.jpg',
    ]);
    const memoryText = y2026.entries[0].type === 'text' ? y2026.entries[0].text : '';
    expect(memoryText).toContain('Added by Adrianita');
    expect(memoryText).toContain('With Enzo');
    expect(memoryText).toContain('- Tita (2026-07-02): Precioso');
  });

  it('puts each family member\'s photos and portrait history in the family group, once each', () => {
    const family = plan.groups[2];
    expect(family.entries.map((entry) => entry.path)).toEqual([
      'Momora - Los Yi/Family/Enzo/profile-photo.jpg',
      'Momora - Los Yi/Family/Enzo/portrait.webp',
      'Momora - Los Yi/Family/Enzo/Portraits over time/2025-06-01 photo.jpg',
      'Momora - Los Yi/Family/Enzo/Portraits over time/2025-06-01 portrait.webp',
    ]);
  });

  it('never plans the same object twice across the family', () => {
    const keys = plan.groups.flatMap((group) => group.entries).flatMap((entry) => (entry.type === 'object' ? [entry.objectKey] : []));
    expect(new Set(keys).size).toBe(keys.length);
  });
});
