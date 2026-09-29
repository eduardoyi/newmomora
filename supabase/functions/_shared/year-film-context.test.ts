import { assertEquals } from 'jsr:@std/assert@1';
import { type FamilyRows, mapFamilyRows, planFilm, stickyQuotes } from './year-film-context.ts';

// Synthetic rows (no family data).
function rows(): FamilyRows {
  return {
    family: { id: 'f', name: 'Fam', gallery_caption_language: 'es' },
    members: [
      { id: 'kid', name: 'Enzo Yi', date_of_birth: '2022-10-23', relationship: 'child', created_at: '2024-01-01' },
      { id: 'niece', name: 'Elena', date_of_birth: '2020-05-01', relationship: 'cousin', created_at: '2024-01-01' },
    ],
    memories: [
      { id: 'm1', content: 'a', memory_date: '2026-01-10', memory_type: 'media', emotion: 'joy', topics: null, illustration_status: 'ready', illustration_key: 'ill/m1.webp', media_key: null, media_content_type: null, onboarding_media_pending: false, created_at: '2026-01-10T10:00:00Z' },
      { id: 'm2', content: 'b', memory_date: '2026-01-11', memory_type: 'media', emotion: null, topics: ['park'], illustration_status: 'ready', illustration_key: 'ill/m2.webp', media_key: 'legacy/m2.mp4', media_content_type: 'video/mp4', onboarding_media_pending: false, created_at: '2026-10-27T10:00:00Z' },
      { id: 'm3', content: 'c', memory_date: '2026-01-12', memory_type: 'text_only', emotion: null, topics: null, illustration_status: 'none', illustration_key: null, media_key: null, media_content_type: null, onboarding_media_pending: true },
    ],
    media: [{ id: 'x', memory_id: 'm1', object_key: 'u/m1.jpg', preview_object_key: null, content_type: 'image/jpeg', duration_ms: null, aspect_ratio: 1.5, position: 0 }],
    tags: [{ memory_id: 'm1', family_member_id: 'kid' }],
    milestones: [{ memory_id: 'm1', family_member_id: 'kid', milestone_id: 'first_steps', status: 'confirmed', out_of_band: false }],
    portraits: [],
    reports: [{ target_type: 'memory_illustration', target_id: 'm1' }],
  };
}

Deno.test('mapFamilyRows: family-wide reports, legacy media, pending uploads left out', () => {
  const data = mapFamilyRows(rows());
  assertEquals(data.memories.map((m) => m.id), ['m1', 'm2']);
  assertEquals(data.memories[0].illustrationReady, false); // reported illustration
  assertEquals(data.memories[0].taggedMemberIds, ['kid']);
  assertEquals(data.memories[1].assets.map((a) => a.key), ['legacy/m2.mp4']);
  assertEquals(data.language, 'es');
});

Deno.test('mapFamilyRows: pool cut-off and removed memories', () => {
  assertEquals(mapFamilyRows(rows(), { poolCutoffAt: '2026-10-26T00:00:00Z' }).memories.map((m) => m.id), ['m1']);
  const data = mapFamilyRows(rows(), { excludeMemoryIds: ['m1'] });
  assertEquals(data.memories.map((m) => m.id), ['m2']);
  assertEquals(data.milestones, []); // milestones of removed memories go too
});

Deno.test('planFilm: skip reasons before any paid call', () => {
  const data = mapFamilyRows(rows());
  assertEquals(planFilm(data, { kind: 'birthday', familyMemberId: 'niece', ageYear: 6, scopeStart: '2025-05-01', scopeEndExclusive: '2026-05-04' }),
    { ok: false, reason: 'NOT_OWN_CHILD' });
  assertEquals(planFilm(data, { kind: 'birthday', familyMemberId: 'kid', ageYear: 4, scopeStart: '2025-10-23', scopeEndExclusive: '2026-10-26' }),
    { ok: false, reason: 'BELOW_FLOORS' });
  assertEquals(planFilm(data, { kind: 'family_month', familyMemberId: null, ageYear: null, scopeStart: '2026-01-01', scopeEndExclusive: '2026-02-01' }),
    { ok: false, reason: 'BELOW_FLOORS' });
});

Deno.test('stickyQuotes: unchanged text only, the chosen quote first', () => {
  const candidates = [
    { memoryId: 'a', quote: 'one', speakerId: 'kid', textHash: 'ha' },
    { memoryId: 'b', quote: 'two', speakerId: 'kid', textHash: 'hb' },
    { memoryId: 'c', quote: 'three', speakerId: 'kid', textHash: 'hc' },
  ];
  const hashes = new Map([['a', 'ha'], ['b', 'CHANGED'], ['c', 'hc']]);
  assertEquals(stickyQuotes(candidates, hashes, null).map((q) => q.memoryId), ['a', 'c']);
  assertEquals(stickyQuotes(candidates, hashes, { memoryId: 'c', textHash: 'hc' }).map((q) => q.memoryId), ['c', 'a']);
  assertEquals(stickyQuotes(candidates, hashes, { memoryId: 'b', textHash: 'hb' }).map((q) => q.memoryId), ['a', 'c']);
});

Deno.test('scriptReferences: memories, keys, members, portrait versions and on-screen text', async () => {
  const { scriptReferences } = await import('./year-film-context.ts');
  const f = (memoryId: string | null, key: string, kind = 'photo', extra = {}) => ({ memoryId, key, previewKey: null, kind, date: null, durationMs: null, aspectRatio: null, emotion: null, why: '', ...extra });
  const refs = scriptReferences({
    subjects: [{ id: 'kid' }],
    references: [{ id: 'kid' }, { id: 'sib' }],
    scenes: [
      { type: 'line', quote: 'q', memoryId: 'mq', speakerName: 'K', frame: null, alternates: [] },
      { type: 'sound', source: 'audio', frame: f('ms', 'a.m4a', 'audio'), caption: 'c', needsVoiceCheck: false, alternates: [] },
      { type: 'starring', people: [{ memberId: 'gma', name: 'G', portrait: f(null, 'ill/gma.webp', 'portrait', { pairKey: 'photo/gma.jpg' }), moments: [f('m1', 'p1.jpg')] }] },
      { type: 'burst', role: 'finale', titles: [], frames: [f('m2', 'v.mp4', 'video', { previewKey: 'v.jpg' })], secondsPerFrame: 0.5 },
    ],
  } as never, [{ id: 'pv1', illustrated_profile_key: 'ill/gma.webp', profile_picture_key: 'photo/gma.jpg' }, { id: 'pv2', illustrated_profile_key: 'x', profile_picture_key: null }]);
  assertEquals(refs.memoryIds, ['m1', 'm2', 'mq', 'ms']);
  assertEquals(refs.textMemoryIds, ['mq', 'ms']);
  assertEquals(refs.memberIds, ['gma', 'kid', 'sib']);
  assertEquals(refs.portraitVersionIds, ['pv1']);
  assertEquals(refs.assetKeys, ['a.m4a', 'ill/gma.webp', 'p1.jpg', 'photo/gma.jpg', 'v.jpg', 'v.mp4']);
});

Deno.test('mapFamilyRows: memories by a parent-blocked account are left out', () => {
  const r = rows();
  r.memories = r.memories.map((m) => ({ ...m, user_id: m.id === 'm1' ? 'blocked-aunt' : 'dad' }));
  assertEquals(mapFamilyRows({ ...r, blockedAuthorIds: ['blocked-aunt'] }).memories.map((m) => m.id), ['m2']);
  assertEquals(mapFamilyRows(r).memories.map((m) => m.id), ['m1', 'm2']);
});
