import {
  fetchFamilyActivity,
  fetchFamilyActivityUnread,
  groupFamilyActivity,
  mapFamilyActivityRow,
  markFamilyActivitySeen,
  type FamilyActivityEvent,
  type FamilyActivityRpcRow,
} from './family-activity';
import { supabase } from '@/lib/supabase';
import { buildFamilyActivityCopy, familyActivityCopyPlainText } from '@/utils/family-activity-copy';

jest.mock('@/lib/supabase', () => ({
  supabase: {
    rpc: jest.fn(),
  },
}));

const mockedRpc = supabase.rpc as jest.Mock;

function makeRow(overrides: Partial<FamilyActivityRpcRow> = {}): FamilyActivityRpcRow {
  return {
    id: 'event-1',
    kind: 'memory_added',
    created_at: '2026-08-21T12:00:00Z',
    actor_id: 'actor-1',
    actor_name: 'Ana',
    actor_is_former: false,
    memory_id: 'memory-1',
    memory_creation_source: 'manual',
    memory_excerpt: 'First swim',
    memory_illustration_key: null,
    memory_media_key: null,
    memory_media_content_type: null,
    comment_id: null,
    comment_snippet: null,
    invite_id: null,
    ...overrides,
  };
}

function makeEvent(overrides: Partial<FamilyActivityEvent> = {}): FamilyActivityEvent {
  return {
    id: 'event-1',
    kind: 'memory_added',
    createdAt: '2026-08-21T12:00:00Z',
    actorId: 'actor-1',
    actorName: 'Ana',
    actorIsFormer: false,
    memoryId: 'memory-1',
    memoryCreationSource: 'manual',
    memoryExcerpt: 'First swim',
    memoryIllustrationKey: null,
    memoryMediaKey: null,
    memoryMediaContentType: null,
    commentId: null,
    commentSnippet: null,
    inviteId: null,
    ...overrides,
  };
}

describe('mapFamilyActivityRow', () => {
  it('maps snake_case RPC columns to a camelCase event', () => {
    const event = mapFamilyActivityRow(makeRow());

    expect(event).toEqual({
      id: 'event-1',
      kind: 'memory_added',
      createdAt: '2026-08-21T12:00:00Z',
      actorId: 'actor-1',
      actorName: 'Ana',
      actorIsFormer: false,
      memoryId: 'memory-1',
      memoryCreationSource: 'manual',
      memoryExcerpt: 'First swim',
      memoryIllustrationKey: null,
      memoryMediaKey: null,
      memoryMediaContentType: null,
      commentId: null,
      commentSnippet: null,
      inviteId: null,
    });
  });

  it('falls back the actor name to "A former member" when actor_is_former is true', () => {
    const event = mapFamilyActivityRow(makeRow({ actor_is_former: true, actor_name: 'Ana' }));
    expect(event.actorName).toBe('A former member');
    expect(event.actorIsFormer).toBe(true);
  });

  it('falls back a null actor_name to "A former member" defensively', () => {
    const event = mapFamilyActivityRow(makeRow({ actor_name: null }));
    expect(event.actorName).toBe('A former member');
  });
});

describe('fetchFamilyActivity / fetchFamilyActivityUnread / markFamilyActivitySeen', () => {
  beforeEach(() => jest.clearAllMocks());

  it('calls get_family_activity and sorts rows newest-first', async () => {
    mockedRpc.mockResolvedValue({
      data: [
        makeRow({ id: 'older', created_at: '2026-08-21T10:00:00Z' }),
        makeRow({ id: 'newer', created_at: '2026-08-21T12:00:00Z' }),
      ],
      error: null,
    });

    const result = await fetchFamilyActivity('family-1');

    expect(supabase.rpc).toHaveBeenCalledWith('get_family_activity', { target_family_id: 'family-1' });
    expect(result.data?.map((event) => event.id)).toEqual(['newer', 'older']);
  });

  it('maps an RPC error', async () => {
    mockedRpc.mockResolvedValue({ data: null, error: { message: 'boom', code: 'x' } });
    const result = await fetchFamilyActivity('family-1');
    expect(result.data).toBeNull();
    expect(result.error).toEqual({ message: 'boom', code: 'x' });
  });

  it('calls get_family_activity_unread and coerces to boolean', async () => {
    mockedRpc.mockResolvedValue({ data: true, error: null });
    const result = await fetchFamilyActivityUnread('family-1');
    expect(supabase.rpc).toHaveBeenCalledWith('get_family_activity_unread', { target_family_id: 'family-1' });
    expect(result.data).toBe(true);
  });

  it('calls mark_family_activity_seen', async () => {
    mockedRpc.mockResolvedValue({ data: null, error: null });
    const result = await markFamilyActivitySeen('family-1');
    expect(supabase.rpc).toHaveBeenCalledWith('mark_family_activity_seen', { target_family_id: 'family-1' });
    expect(result.error).toBeNull();
  });
});

describe('groupFamilyActivity', () => {
  const now = new Date('2026-08-21T18:00:00');

  it('groups consecutive memory_added events by the same actor within 30 minutes', () => {
    const events = [
      makeEvent({ id: 'e3', createdAt: '2026-08-21T17:50:00' }),
      makeEvent({ id: 'e2', createdAt: '2026-08-21T17:40:00' }),
      makeEvent({ id: 'e1', createdAt: '2026-08-21T17:30:00' }),
    ];

    const sections = groupFamilyActivity(events, { now });

    expect(sections).toHaveLength(1);
    expect(sections[0].title).toBe('Today');
    expect(sections[0].data).toHaveLength(1);
    expect(sections[0].data[0].events.map((e) => e.id)).toEqual(['e3', 'e2', 'e1']);
  });

  it('does not group memory_added events more than 30 minutes apart', () => {
    const events = [
      makeEvent({ id: 'e2', createdAt: '2026-08-21T17:50:00' }),
      makeEvent({ id: 'e1', createdAt: '2026-08-21T17:10:00' }),
    ];

    const sections = groupFamilyActivity(events, { now });

    expect(sections[0].data).toHaveLength(2);
  });

  it('does not group memory_added events from different actors', () => {
    const events = [
      makeEvent({ id: 'e2', actorId: 'actor-2', createdAt: '2026-08-21T17:55:00' }),
      makeEvent({ id: 'e1', actorId: 'actor-1', createdAt: '2026-08-21T17:50:00' }),
    ];

    const sections = groupFamilyActivity(events, { now });

    expect(sections[0].data).toHaveLength(2);
  });

  it('breaks a memory_added streak when a different event interleaves', () => {
    const events = [
      makeEvent({ id: 'e3', kind: 'memory_added', createdAt: '2026-08-21T17:55:00' }),
      makeEvent({
        id: 'e2',
        kind: 'memory_commented',
        memoryId: 'memory-2',
        commentSnippet: 'Cute!',
        createdAt: '2026-08-21T17:52:00',
      }),
      makeEvent({ id: 'e1', kind: 'memory_added', createdAt: '2026-08-21T17:50:00' }),
    ];

    const sections = groupFamilyActivity(events, { now });

    expect(sections[0].data).toHaveLength(3);
  });

  it('groups memory_liked events on the same memory within 24 hours, even non-adjacently', () => {
    // All same-calendar-day (Today) so the 24h window is exercised without
    // also crossing a day-section boundary (see the day-section test below
    // for that separate rule).
    const events = [
      makeEvent({
        id: 'like-3',
        kind: 'memory_liked',
        actorId: 'actor-3',
        actorName: 'Luis',
        memoryId: 'memory-1',
        createdAt: '2026-08-21T17:00:00',
      }),
      makeEvent({
        id: 'comment-1',
        kind: 'memory_commented',
        actorId: 'actor-4',
        memoryId: 'memory-2',
        commentSnippet: 'Aw',
        createdAt: '2026-08-21T16:30:00',
      }),
      makeEvent({
        id: 'like-2',
        kind: 'memory_liked',
        actorId: 'actor-2',
        actorName: 'Grandma',
        memoryId: 'memory-1',
        createdAt: '2026-08-21T10:00:00',
      }),
      makeEvent({
        id: 'like-1',
        kind: 'memory_liked',
        actorId: 'actor-1',
        actorName: 'Ana',
        memoryId: 'memory-1',
        createdAt: '2026-08-21T00:30:00', // 16.5h before like-3, within 24h
      }),
    ];

    const sections = groupFamilyActivity(events, { now });

    expect(sections[0].title).toBe('Today');
    expect(sections[0].data).toHaveLength(2); // the like group + the comment
    const likeGroup = sections[0].data.find((group) => group.kind === 'memory_liked');
    expect(likeGroup?.events.map((e) => e.id)).toEqual(['like-3', 'like-2', 'like-1']);
  });

  it('does not group memory_liked events on the same memory more than 24 hours apart', () => {
    // Both land in the "This week" bucket (which can span multiple days) so
    // the >24h delta is exercised without crossing a day-section boundary.
    const events = [
      makeEvent({ id: 'like-2', kind: 'memory_liked', createdAt: '2026-08-19T18:00:00' }),
      makeEvent({ id: 'like-1', kind: 'memory_liked', createdAt: '2026-08-16T17:00:00' }), // ~73h earlier
    ];

    const sections = groupFamilyActivity(events, { now });

    const thisWeek = sections.find((section) => section.title === 'This week');
    expect(thisWeek?.data).toHaveLength(2);
  });

  it('never groups across day sections (Today vs Yesterday)', () => {
    const events = [
      makeEvent({ id: 'today', actorId: 'actor-1', createdAt: '2026-08-21T00:10:00' }),
      makeEvent({ id: 'yesterday', actorId: 'actor-1', createdAt: '2026-08-20T23:55:00' }), // 15 min earlier, would group if not day-bounded
    ];

    const sections = groupFamilyActivity(events, { now });

    expect(sections.map((s) => s.title)).toEqual(['Today', 'Yesterday']);
    expect(sections[0].data).toHaveLength(1);
    expect(sections[1].data).toHaveLength(1);
  });

  it('buckets events into Today / Yesterday / This week / Earlier', () => {
    const events = [
      makeEvent({ id: 'today', kind: 'member_joined', createdAt: '2026-08-21T09:00:00' }),
      makeEvent({ id: 'yesterday', kind: 'member_joined', createdAt: '2026-08-20T09:00:00' }),
      makeEvent({ id: 'this-week', kind: 'member_joined', createdAt: '2026-08-17T09:00:00' }),
      makeEvent({ id: 'earlier', kind: 'member_joined', createdAt: '2026-08-01T09:00:00' }),
    ];

    const sections = groupFamilyActivity(events, { now });

    expect(sections.map((s) => s.title)).toEqual(['Today', 'Yesterday', 'This week', 'Earlier']);
  });

  it('never groups member_joined/member_pending/memory_commented events (always 1:1)', () => {
    const events = [
      makeEvent({ id: 'a', kind: 'member_joined', actorId: 'actor-1', createdAt: '2026-08-21T17:00:00' }),
      makeEvent({ id: 'b', kind: 'member_joined', actorId: 'actor-1', createdAt: '2026-08-21T17:01:00' }),
    ];

    const sections = groupFamilyActivity(events, { now });

    expect(sections[0].data).toHaveLength(2);
  });
});

describe('buildFamilyActivityCopy', () => {
  function group(kind: FamilyActivityEvent['kind'], events: FamilyActivityEvent[]) {
    return { id: `group-${events[0].id}`, kind, createdAt: events[0].createdAt, events };
  }

  it('renders a single memory_added event as "added a memory"', () => {
    const copy = buildFamilyActivityCopy(group('memory_added', [makeEvent({ actorName: 'Ana' })]));
    expect(familyActivityCopyPlainText(copy)).toBe('Ana added a memory');
    expect(copy.segments[0]).toEqual({ text: 'Ana', bold: true });
  });

  it('renders a grouped memory_added event as "added N memories"', () => {
    const events = [
      makeEvent({ id: 'e2', actorName: 'Ana' }),
      makeEvent({ id: 'e1', actorName: 'Ana' }),
    ];
    const copy = buildFamilyActivityCopy(group('memory_added', events));
    expect(familyActivityCopyPlainText(copy)).toBe('Ana added 2 memories');
  });

  it('renders the gallery-import variant only when every memory in the group is a gallery import', () => {
    const galleryEvents = [
      makeEvent({ id: 'e2', actorName: 'Ana', memoryCreationSource: 'gallery_import' }),
      makeEvent({ id: 'e1', actorName: 'Ana', memoryCreationSource: 'gallery_import' }),
    ];
    const copy = buildFamilyActivityCopy(group('memory_added', galleryEvents));
    expect(familyActivityCopyPlainText(copy)).toBe('Ana added 2 memories from their gallery');

    const mixedEvents = [
      makeEvent({ id: 'e2', actorName: 'Ana', memoryCreationSource: 'gallery_import' }),
      makeEvent({ id: 'e1', actorName: 'Ana', memoryCreationSource: 'manual' }),
    ];
    const mixedCopy = buildFamilyActivityCopy(group('memory_added', mixedEvents));
    expect(familyActivityCopyPlainText(mixedCopy)).toBe('Ana added 2 memories');
  });

  it('renders memory_commented as "commented on a memory"', () => {
    const copy = buildFamilyActivityCopy(
      group('memory_commented', [makeEvent({ actorName: 'Luis', kind: 'memory_commented' })]),
    );
    expect(familyActivityCopyPlainText(copy)).toBe('Luis commented on a memory');
  });

  it('renders a single memory_liked event as "liked a memory"', () => {
    const copy = buildFamilyActivityCopy(
      group('memory_liked', [makeEvent({ actorName: 'Grandma', kind: 'memory_liked' })]),
    );
    expect(familyActivityCopyPlainText(copy)).toBe('Grandma liked a memory');
  });

  it('renders two likers as "X and Y liked a memory"', () => {
    const events = [
      makeEvent({ id: 'e2', actorId: 'actor-2', actorName: 'Luis', kind: 'memory_liked' }),
      makeEvent({ id: 'e1', actorId: 'actor-1', actorName: 'Ana', kind: 'memory_liked' }),
    ];
    const copy = buildFamilyActivityCopy(group('memory_liked', events));
    expect(familyActivityCopyPlainText(copy)).toBe('Luis and Ana liked a memory');
  });

  it('renders 3+ likers with up to 2 names and "and N others"', () => {
    const events = [
      makeEvent({ id: 'e3', actorId: 'actor-3', actorName: 'Grandma', kind: 'memory_liked' }),
      makeEvent({ id: 'e2', actorId: 'actor-2', actorName: 'Luis', kind: 'memory_liked' }),
      makeEvent({ id: 'e1', actorId: 'actor-1', actorName: 'Ana', kind: 'memory_liked' }),
    ];
    const copy = buildFamilyActivityCopy(group('memory_liked', events));
    expect(familyActivityCopyPlainText(copy)).toBe('Grandma, Luis and 1 other liked a memory');
  });

  it('renders member_joined as "joined the family"', () => {
    const copy = buildFamilyActivityCopy(
      group('member_joined', [makeEvent({ actorName: 'Marta', kind: 'member_joined' })]),
    );
    expect(familyActivityCopyPlainText(copy)).toBe('Marta joined the family');
  });

  it('renders member_pending as "is waiting for your approval"', () => {
    const copy = buildFamilyActivityCopy(
      group('member_pending', [makeEvent({ actorName: 'Marta', kind: 'member_pending' })]),
    );
    expect(familyActivityCopyPlainText(copy)).toBe('Marta is waiting for your approval');
  });

  it('renders the actor name as "A former member" and never references the memory creator', () => {
    const copy = buildFamilyActivityCopy(
      group('memory_liked', [makeEvent({ kind: 'memory_liked', actorIsFormer: true, actorName: 'Old Name' })]),
    );
    expect(familyActivityCopyPlainText(copy)).toBe('A former member liked a memory');
    expect(familyActivityCopyPlainText(copy)).not.toContain('your memory');
    expect(familyActivityCopyPlainText(copy)).not.toContain('Old Name');
  });
});
