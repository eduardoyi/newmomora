import { supabase } from '@/lib/supabase';
import type { Database } from '@/types/database';

export type FamilyActivityKind =
  | 'memory_added'
  | 'memory_commented'
  | 'memory_liked'
  | 'member_joined'
  | 'member_pending';

export interface ServiceError {
  message: string;
  code?: string;
}

function mapSupabaseError(error: { message: string; code?: string }): ServiceError {
  return { message: error.message, code: error.code };
}

type GeneratedFamilyActivityRow =
  Database['public']['Functions']['get_family_activity']['Returns'][number];

// Shape of one row returned by the `get_family_activity` RPC (plan §6,
// docs/plans/family-activity.md). `kind` is narrowed from the generated
// `string` to the actual closed union the DB check constraint enforces
// (plan §5.1). The memory/comment/invite columns are widened back to
// nullable: Supabase's generated function metadata marks every output
// column non-null, but at runtime most of them are null whenever the event
// kind doesn't apply (e.g. `comment_id` is null for a `memory_added` row) --
// same caveat `FamilyMemberProfile` documents in src/services/family.ts for
// `get_family_member_profiles`.
export type FamilyActivityRpcRow = Omit<
  GeneratedFamilyActivityRow,
  | 'kind'
  | 'actor_name'
  | 'memory_id'
  | 'memory_creation_source'
  | 'memory_excerpt'
  | 'memory_illustration_key'
  | 'memory_media_key'
  | 'memory_media_content_type'
  | 'comment_id'
  | 'comment_snippet'
  | 'invite_id'
> & {
  kind: FamilyActivityKind;
  actor_name: string | null;
  memory_id: string | null;
  memory_creation_source: string | null;
  memory_excerpt: string | null;
  memory_illustration_key: string | null;
  memory_media_key: string | null;
  memory_media_content_type: string | null;
  comment_id: string | null;
  comment_snippet: string | null;
  invite_id: string | null;
};

export interface FamilyActivityEvent {
  id: string;
  kind: FamilyActivityKind;
  createdAt: string;
  actorId: string;
  actorName: string;
  actorIsFormer: boolean;
  memoryId: string | null;
  memoryCreationSource: string | null;
  memoryExcerpt: string | null;
  memoryIllustrationKey: string | null;
  memoryMediaKey: string | null;
  memoryMediaContentType: string | null;
  commentId: string | null;
  commentSnippet: string | null;
  inviteId: string | null;
}

export function mapFamilyActivityRow(row: FamilyActivityRpcRow): FamilyActivityEvent {
  return {
    id: row.id,
    kind: row.kind,
    createdAt: row.created_at,
    actorId: row.actor_id,
    actorName: row.actor_is_former ? 'A former member' : row.actor_name ?? 'A former member',
    actorIsFormer: Boolean(row.actor_is_former),
    memoryId: row.memory_id,
    memoryCreationSource: row.memory_creation_source,
    memoryExcerpt: row.memory_excerpt,
    memoryIllustrationKey: row.memory_illustration_key,
    memoryMediaKey: row.memory_media_key,
    memoryMediaContentType: row.memory_media_content_type,
    commentId: row.comment_id,
    commentSnippet: row.comment_snippet,
    inviteId: row.invite_id,
  };
}

/**
 * Newest-first, matching the RPC's own `created_at desc, id desc` index
 * order (plan §5.1) -- sorted defensively here so a caller never has to
 * trust transport ordering.
 */
function sortNewestFirst(events: FamilyActivityEvent[]): FamilyActivityEvent[] {
  return [...events].sort((a, b) => {
    if (a.createdAt !== b.createdAt) {
      return a.createdAt < b.createdAt ? 1 : -1;
    }
    return a.id < b.id ? 1 : -1;
  });
}

export async function fetchFamilyActivity(
  familyId: string,
): Promise<{ data: FamilyActivityEvent[] | null; error: ServiceError | null }> {
  const { data, error } = await supabase.rpc('get_family_activity', {
    target_family_id: familyId,
  });

  if (error) {
    return { data: null, error: mapSupabaseError(error) };
  }

  const rows = (data ?? []) as FamilyActivityRpcRow[];
  return { data: sortNewestFirst(rows.map(mapFamilyActivityRow)), error: null };
}

export async function fetchFamilyActivityUnread(
  familyId: string,
): Promise<{ data: boolean | null; error: ServiceError | null }> {
  const { data, error } = await supabase.rpc('get_family_activity_unread', {
    target_family_id: familyId,
  });

  if (error) {
    return { data: null, error: mapSupabaseError(error) };
  }

  return { data: Boolean(data), error: null };
}

export async function markFamilyActivitySeen(
  familyId: string,
): Promise<{ error: ServiceError | null }> {
  const { error } = await supabase.rpc('mark_family_activity_seen', {
    target_family_id: familyId,
  });

  return { error: error ? mapSupabaseError(error) : null };
}

// ---------------------------------------------------------------------------
// Grouping (plan §4 "Grouping" -- client-side, over the <=100 fetched rows)
// ---------------------------------------------------------------------------

export type FamilyActivitySectionTitle = 'Today' | 'Yesterday' | 'This week' | 'Earlier';

export interface FamilyActivityGroup {
  /** Stable list key; the id of the newest (first-encountered) event. */
  id: string;
  kind: FamilyActivityKind;
  /** The newest member's timestamp (plan §4). */
  createdAt: string;
  /** Newest first. Single-element for every ungrouped kind. */
  events: FamilyActivityEvent[];
}

export interface FamilyActivitySection {
  title: FamilyActivitySectionTitle;
  data: FamilyActivityGroup[];
}

const GROUP_MEMORY_ADDED_WINDOW_MS = 30 * 60 * 1000;
const GROUP_MEMORY_LIKED_WINDOW_MS = 24 * 60 * 60 * 1000;

function startOfLocalDay(date: Date): number {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
}

function sectionTitleFor(createdAt: string, now: Date): FamilyActivitySectionTitle {
  const dayDiff = Math.round(
    (startOfLocalDay(now) - startOfLocalDay(new Date(createdAt))) / (24 * 60 * 60 * 1000),
  );
  if (dayDiff <= 0) return 'Today';
  if (dayDiff === 1) return 'Yesterday';
  if (dayDiff <= 6) return 'This week';
  return 'Earlier';
}

function newGroup(event: FamilyActivityEvent): FamilyActivityGroup {
  return { id: `group-${event.id}`, kind: event.kind, createdAt: event.createdAt, events: [event] };
}

/**
 * Groups events already narrowed to a single day-section (Today/Yesterday/
 * This week/Earlier), so grouping can never cross a section boundary --
 * satisfied structurally by only ever being called per-bucket from
 * `groupFamilyActivity` below.
 */
function groupEventsWithinSection(events: FamilyActivityEvent[]): FamilyActivityGroup[] {
  const groups: FamilyActivityGroup[] = [];
  // memory_liked groups aren't necessarily adjacent in the feed (an
  // unrelated event can land between two likes on the same memory), so
  // they're tracked by memory id rather than by "last group pushed" the
  // way memory_added's strict-adjacency rule is below.
  const openLikeGroupsByMemoryId = new Map<string, FamilyActivityGroup>();

  for (const event of events) {
    if (event.kind === 'memory_added') {
      const lastGroup = groups[groups.length - 1];
      const lastEvent = lastGroup?.events[lastGroup.events.length - 1];
      if (
        lastGroup?.kind === 'memory_added' &&
        lastEvent &&
        lastEvent.actorId === event.actorId &&
        Math.abs(new Date(lastEvent.createdAt).getTime() - new Date(event.createdAt).getTime()) <=
          GROUP_MEMORY_ADDED_WINDOW_MS
      ) {
        lastGroup.events.push(event);
        continue;
      }
      groups.push(newGroup(event));
      continue;
    }

    if (event.kind === 'memory_liked' && event.memoryId) {
      const existing = openLikeGroupsByMemoryId.get(event.memoryId);
      if (
        existing &&
        Math.abs(new Date(existing.createdAt).getTime() - new Date(event.createdAt).getTime()) <=
          GROUP_MEMORY_LIKED_WINDOW_MS
      ) {
        existing.events.push(event);
        continue;
      }
      const group = newGroup(event);
      groups.push(group);
      openLikeGroupsByMemoryId.set(event.memoryId, group);
      continue;
    }

    // memory_commented, member_joined, member_pending: always 1:1 (plan §4
    // grouping rule 3, "Everything else is 1:1").
    groups.push(newGroup(event));
  }

  return groups;
}

export function groupFamilyActivity(
  events: FamilyActivityEvent[],
  options: { now?: Date } = {},
): FamilyActivitySection[] {
  const now = options.now ?? new Date();
  const buckets: Record<FamilyActivitySectionTitle, FamilyActivityEvent[]> = {
    Today: [],
    Yesterday: [],
    'This week': [],
    Earlier: [],
  };

  for (const event of events) {
    buckets[sectionTitleFor(event.createdAt, now)].push(event);
  }

  const titles: FamilyActivitySectionTitle[] = ['Today', 'Yesterday', 'This week', 'Earlier'];
  return titles
    .map((title) => ({ title, data: groupEventsWithinSection(buckets[title]) }))
    .filter((section) => section.data.length > 0);
}
