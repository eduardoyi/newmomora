/**
 * Family rows the Workflow reads through the bridge: one loader shared by the
 * film context (`load_film_context`) and the holiday card context
 * (`card_load_context`), so both produce the rows `mapFamilyRows`
 * (_shared/year-film-context.ts) expects. Every query is paged / id-chunked
 * (paged-query.ts) and THROWS on error: a failed read is never "no rows".
 */
import { byMemoryIds as byMemoryIdsChunked, fetchAll } from '../_shared/paged-query.ts';
import type { createServiceClient } from '../_shared/supabase-admin.ts';

export type Client = ReturnType<typeof createServiceClient>;

const CHUNK_SIZE = 200;

const byMemoryIds = <T>(
  ids: string[],
  page: Parameters<typeof byMemoryIdsChunked<T>>[1],
): Promise<T[]> => byMemoryIdsChunked<T>(ids, page, { chunkSize: CHUNK_SIZE });

export const FILM_MEMBER_COLUMNS = 'id, name, date_of_birth, relationship, created_at';
export const FILM_MEMORY_COLUMNS =
  'id, user_id, content, audio_transcript, description, memory_date, memory_type, emotion, topics, illustration_status, illustration_key, media_key, media_content_type, onboarding_media_pending, created_at';
/** Cards also read the parents' accounts / nicknames / gender (the letter's
 * voice and naming) and each memory's open-vocabulary labels (details). */
export const CARD_MEMBER_COLUMNS = `${FILM_MEMBER_COLUMNS}, user_id, nicknames, gender`;
export const CARD_MEMORY_COLUMNS =
  'id, user_id, content, memory_date, memory_type, emotion, topics, labels, illustration_status, illustration_key, media_key, media_content_type, onboarding_media_pending, created_at';

export interface FamilyRowsOptions {
  /** memory_date >= from. */
  from: string;
  /** memory_date < toExclusive. */
  toExclusive: string;
  memberColumns: string;
  memoryColumns: string;
  /** Portrait versions (films read them; cards do not). */
  portraits: boolean;
}

export interface LoadedFamilyRows {
  members: unknown[];
  memories: Record<string, unknown>[];
  media: unknown[];
  tags: unknown[];
  milestones: unknown[];
  portraits: unknown[];
  reports: unknown[];
  blockedAuthorIds: unknown[];
}

export async function loadFamilyRows(supabase: Client, familyId: string, options: FamilyRowsOptions): Promise<LoadedFamilyRows> {
  const { data: members, error: membersError } = await supabase
    .from('family_members')
    .select(options.memberColumns)
    .eq('family_id', familyId);
  if (membersError) throw new Error('members_failed');

  const memories = await fetchAll<Record<string, unknown>>((from, to) =>
    supabase
      .from('memories')
      .select(options.memoryColumns)
      .eq('family_id', familyId)
      .gte('memory_date', options.from)
      .lt('memory_date', options.toExclusive)
      .order('memory_date', { ascending: true })
      .order('id', { ascending: true })
      .range(from, to) as never
  );
  const ids = memories.map((m) => m.id as string);
  const media = await byMemoryIds(ids, (chunk, from, to) =>
    supabase
      .from('memory_media')
      .select('id, memory_id, object_key, preview_object_key, content_type, duration_ms, aspect_ratio, position')
      .in('memory_id', chunk)
      .order('id', { ascending: true })
      .range(from, to)
  );
  const tags = await byMemoryIds(ids, (chunk, from, to) =>
    supabase
      .from('memory_family_members')
      .select('memory_id, family_member_id')
      .in('memory_id', chunk)
      .order('memory_id', { ascending: true })
      .order('family_member_id', { ascending: true })
      .range(from, to)
  );
  const milestones = await byMemoryIds(ids, (chunk, from, to) =>
    supabase
      .from('memory_milestones')
      .select('memory_id, family_member_id, milestone_id, status, out_of_band')
      .in('memory_id', chunk)
      .order('id', { ascending: true })
      .range(from, to)
  );
  const portraits = options.portraits
    ? await fetchAll((from, to) =>
      supabase
        .from('family_member_portrait_versions')
        .select('id, family_member_id, reference_date, profile_picture_key, illustrated_profile_key, illustrated_profile_status, deletion_token, created_at')
        .eq('family_id', familyId)
        .order('id', { ascending: true })
        .range(from, to)
    )
    : [];
  // Accounts a parent (owner/manager) blocked: their memories stay out of
  // every film of the family (owner decision 2026-09-29).
  const { data: blockedAuthors, error: blockedError } = await supabase.rpc('year_film_parent_blocked_users', {
    p_family_id: familyId,
  });
  if (blockedError) throw new Error('blocked_failed');
  // Films are family-wide: every open or reviewing report counts.
  const reports = await fetchAll((from, to) =>
    supabase
      .from('content_reports')
      .select('target_type, target_id')
      .eq('family_id', familyId)
      .in('status', ['open', 'reviewing'])
      .order('id', { ascending: true })
      .range(from, to)
  );

  return {
    members: (members ?? []) as unknown[],
    memories,
    media,
    tags,
    milestones,
    portraits,
    reports,
    blockedAuthorIds: Array.isArray(blockedAuthors) ? blockedAuthors : [],
  };
}
