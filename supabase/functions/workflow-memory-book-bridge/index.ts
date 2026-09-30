/**
 * Signed HMAC bridge for the Memory Book Cloudflare Workflow (V5a "part
 * C"). Mirrors workflow-illustration-bridge/index.ts's shape: the Worker
 * has no Supabase service-role credentials, so every private read/write
 * happens here, authorized by a signed request rather than a user JWT (see
 * docs/durable-ai-generation-workflows.md's "Authentication and privacy").
 *
 * Documented deviation from the illustration/portrait bridge precedent:
 * this task's scope explicitly excludes schema changes, so there is no
 * `memory_book_workflow_bridge_nonces` replay ledger table here (the
 * illustration bridge's nonce check is a DB insert against such a table --
 * see that file). This bridge instead relies on `isSignedWorkflowRequest`'s
 * timestamp window (5 minutes, same bound the illustration bridge also
 * enforces) plus the fact that every mutating operation here is ALREADY a
 * database compare-and-set keyed on `generation_attempt_id`
 * (`publish`/`fail`) or naturally idempotent (`ensure_share_tokens`'
 * read-then-insert-if-absent, where a `23505` unique-active-token conflict
 * from a concurrent/retried call is treated as success by re-reading and
 * minting only what is still missing) -- a replayed request within the window can
 * only ever repeat a no-op, never double-publish or double-fail. A replayed
 * `load_generation_context` is a pure read. This is a real, intentional
 * trade against the playbook's stated nonce-ledger pattern; a future change
 * that also owns a schema migration should add the ledger table and close
 * this gap the same way the illustration bridge does.
 */
import { errorResponse, jsonResponse } from '../_shared/errors.ts';
import { sendExpoPushNotification } from '../_shared/expo-push.ts';
import { pickCoverAssetKey } from '../_shared/memory-book-cover.ts';
import { byMemoryIds, fetchAll, PagedQueryError } from '../_shared/paged-query.ts';
import { createServiceClient } from '../_shared/supabase-admin.ts';
import { serveWithSentry } from '../_shared/sentry.ts';

const MAX_SIGNATURE_AGE_MS = 5 * 60_000;
// Below this many non-empty in-window captions, the outline call also gets
// a sample of the family's wider caption history purely to judge journal
// language (never eligible as a spread/backbone/quote source) -- mirrors
// the eval CLI's WINDOW_CAPTION_SPARSE_THRESHOLD/LANGUAGE_EVIDENCE_SAMPLE_LIMIT.
const WINDOW_CAPTION_SPARSE_THRESHOLD = 5;
const LANGUAGE_EVIDENCE_SAMPLE_LIMIT = 40;
const LANGUAGE_EVIDENCE_EXCERPT_MAX_CHARS = 80;
// Ids per `.in('memory_id', ...)` call. 36 chars/uuid => ~5.5 KB of query
// string at 150; the year-film bridge proves 200 works in production, this
// keeps margin for the longer select lists here.
const MEMORY_ID_CHUNK_SIZE = 150;

type Supabase = ReturnType<typeof createServiceClient>;

/** A real query/network failure: retryable (HTTP 500 `context_load_failed`). */
class ContextLoadError extends Error {
  constructor(readonly step: string) {
    super(`context_load_failed:${step}`);
    this.name = 'ContextLoadError';
  }
}

/**
 * The data itself is deterministically unusable (null child on a child-scoped
 * book, or loaded rows still short of the pre-load counts after one reload):
 * NOT retryable, so HTTP 422 `context_invalid` -- a 5xx would make the worker
 * retry the same outcome 3x in-call x 4 step attempts.
 */
class ContextInvalidError extends Error {
  constructor(readonly reason: string) {
    super(`context_invalid:${reason}`);
    this.name = 'ContextInvalidError';
  }
}

function hex(bytes: ArrayBuffer): string {
  return [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function constantTimeEqual(left: string, right: string): boolean {
  const toFixedDigest = (value: string): Uint8Array => {
    const digest = new Uint8Array(32);
    if (!/^[0-9a-f]{64}$/i.test(value)) return digest;
    for (let index = 0; index < 32; index += 1) {
      digest[index] = Number.parseInt(value.slice(index * 2, index * 2 + 2), 16);
    }
    return digest;
  };
  const leftDigest = toFixedDigest(left);
  const rightDigest = toFixedDigest(right);
  let mismatch = 0;
  for (let index = 0; index < 32; index += 1) mismatch |= leftDigest[index] ^ rightDigest[index];
  return mismatch === 0;
}

export async function isSignedWorkflowRequest(req: Request, rawBody: string): Promise<boolean> {
  const timestamp = req.headers.get('x-workflow-timestamp');
  const signature = req.headers.get('x-workflow-signature');
  const nonce = req.headers.get('x-workflow-nonce');
  const secret = Deno.env.get('CLOUDFLARE_MEMORY_BOOK_BRIDGE_SECRET');
  if (!timestamp || !signature || !nonce || !secret) return false;
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(nonce)) return false;
  const timestampMs = Number(timestamp);
  if (!Number.isFinite(timestampMs) || Math.abs(Date.now() - timestampMs) > MAX_SIGNATURE_AGE_MS) return false;
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const digest = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${timestamp}.${nonce}.${rawBody}`));
  return constantTimeEqual(hex(digest), signature.toLowerCase());
}

interface BridgeBody {
  operation: string;
  bookId?: unknown;
  attemptId?: unknown;
  memoryIds?: unknown;
  bookDocument?: unknown;
  failureReason?: unknown;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_PATTERN.test(value);
}

interface ActiveBookRow {
  id: string;
  family_id: string;
  child_id: string | null;
  scope_kind: 'age_year' | 'calendar_year' | 'everything' | 'custom_range';
  scope_start_date: string | null;
  scope_end_date: string | null;
  scope_label: string;
  page_budget: number;
  status: string;
  generation_attempt_id: string | null;
}

async function loadActiveBook(
  supabase: ReturnType<typeof createServiceClient>,
  bookId: string,
  attemptId: string,
): Promise<{ row: ActiveBookRow } | { error: Response }> {
  const { data: row, error } = await supabase
    .from('memory_books')
    .select('id, family_id, child_id, scope_kind, scope_start_date, scope_end_date, scope_label, page_budget, status, generation_attempt_id')
    .eq('id', bookId)
    .maybeSingle<ActiveBookRow>();
  if (error) return { error: errorResponse('Failed to load memory book', 500, 'internal_error') };
  if (!row) return { error: errorResponse('Memory book not found', 404, 'BOOK_NOT_FOUND') };
  if (row.status !== 'generating' || row.generation_attempt_id !== attemptId) {
    return { error: errorResponse('Memory book attempt is no longer current', 409, 'BOOK_SUPERSEDED') };
  }
  return { row };
}

function addDaysToDateOnly(dateStr: string, days: number): string {
  const [year, month, day] = dateStr.split('-').map(Number);
  const utcMs = Date.UTC(year, month - 1, day) + days * 24 * 60 * 60 * 1000;
  const dt = new Date(utcMs);
  const pad = (n: number, width: number) => String(n).padStart(width, '0');
  return `${pad(dt.getUTCFullYear(), 4)}-${pad(dt.getUTCMonth() + 1, 2)}-${pad(dt.getUTCDate(), 2)}`;
}

interface WindowRows {
  memories: Array<{ id: string; content: string | null } & Record<string, unknown>>;
  media: unknown[];
  tags: unknown[];
  milestones: unknown[];
  likeRows: Array<{ memory_id: string }>;
  commentRows: Array<{ memory_id: string }>;
}

interface WindowCounts {
  memories: number;
  media: number;
  tags: number;
  milestones: number;
}

/**
 * Head-only exact counts that do NOT depend on an id list, so they can
 * cross-check what the id-chunked loads return. Child tables go through a
 * `memories!inner(...)` embed filtered on the parent's family + window.
 * Unambiguous: memory_media, memory_family_members and memory_milestones
 * each have exactly ONE foreign key to `memories` (memory_milestones' is the
 * composite (memory_id, family_id) FK), so PostgREST never raises PGRST201.
 * `memory_family_members` has no `id` column, hence `memory_id` is selected.
 */
async function countWindowRows(
  supabase: Supabase,
  familyId: string,
  windowStart: string,
  windowEndExclusive: string,
): Promise<WindowCounts> {
  const head = { count: 'exact' as const, head: true as const };
  const check = (step: string, result: { count: number | null; error: unknown }): number => {
    if (result.error || typeof result.count !== 'number') throw new ContextLoadError(step);
    return result.count;
  };
  const memories = check('count_memories', await supabase
    .from('memories')
    .select('id', head)
    .eq('family_id', familyId)
    .gte('memory_date', windowStart)
    .lt('memory_date', windowEndExclusive));
  const media = check('count_media', await supabase
    .from('memory_media')
    .select('memory_id, memories!inner(family_id)', head)
    .eq('memories.family_id', familyId)
    .gte('memories.memory_date', windowStart)
    .lt('memories.memory_date', windowEndExclusive));
  const tags = check('count_tags', await supabase
    .from('memory_family_members')
    .select('memory_id, memories!inner(family_id)', head)
    .eq('memories.family_id', familyId)
    .gte('memories.memory_date', windowStart)
    .lt('memories.memory_date', windowEndExclusive));
  const milestones = check('count_milestones', await supabase
    .from('memory_milestones')
    .select('memory_id, memories!inner(family_id)', head)
    .neq('status', 'dismissed')
    .eq('memories.family_id', familyId)
    .gte('memories.memory_date', windowStart)
    .lt('memories.memory_date', windowEndExclusive));
  return { memories, media, tags, milestones };
}

/** Every window read, paged (memories) or id-chunked + paged (children),
 * each with a stable sort key and sequential chunks. Any error throws. */
async function loadWindowRows(
  supabase: Supabase,
  familyId: string,
  windowStart: string,
  windowEndExclusive: string,
): Promise<WindowRows> {
  const chunk = { chunkSize: MEMORY_ID_CHUNK_SIZE };
  const memories = await fetchAll<WindowRows['memories'][number]>(
    (from, to) =>
      supabase
        .from('memories')
        .select('id, content, memory_date, memory_type, emotion, topics, topic_details, illustration_key')
        .eq('family_id', familyId)
        .gte('memory_date', windowStart)
        .lt('memory_date', windowEndExclusive)
        .order('memory_date', { ascending: true })
        .order('id', { ascending: true })
        .range(from, to),
    { dedupeKey: (row) => row.id },
  );
  const memoryIds = memories.map((m) => m.id);

  const media = await byMemoryIds<{ id: string }>(
    memoryIds,
    (ids, from, to) =>
      supabase
        .from('memory_media')
        .select('id, memory_id, object_key, preview_object_key, content_type, position, duration_ms, aspect_ratio')
        .in('memory_id', ids)
        .order('id', { ascending: true })
        .range(from, to),
    { ...chunk, dedupeKey: (row) => row.id },
  );
  const tags = await byMemoryIds<{ memory_id: string; family_member_id: string }>(
    memoryIds,
    (ids, from, to) =>
      supabase
        .from('memory_family_members')
        .select('memory_id, family_member_id')
        .in('memory_id', ids)
        .order('memory_id', { ascending: true })
        .order('family_member_id', { ascending: true })
        .range(from, to),
    { ...chunk, dedupeKey: (row) => `${row.memory_id}|${row.family_member_id}` },
  );
  // (memory_id, milestone_id) is UNIQUE, so it is a safe dedupe key even
  // though `id` (the sort key) is not selected.
  const milestones = await byMemoryIds<{ memory_id: string; milestone_id: string }>(
    memoryIds,
    (ids, from, to) =>
      supabase
        .from('memory_milestones')
        .select('memory_id, family_member_id, milestone_id, detail, out_of_band')
        .neq('status', 'dismissed')
        .in('memory_id', ids)
        .order('id', { ascending: true })
        .range(from, to),
    { ...chunk, dedupeKey: (row) => `${row.memory_id}|${row.milestone_id}` },
  );
  // memory_likes has no `id` column: its primary key is (memory_id, user_id).
  const likeRows = await byMemoryIds<{ memory_id: string; user_id: string }>(
    memoryIds,
    (ids, from, to) =>
      supabase
        .from('memory_likes')
        .select('memory_id, user_id')
        .in('memory_id', ids)
        .order('memory_id', { ascending: true })
        .order('user_id', { ascending: true })
        .range(from, to),
    { ...chunk, dedupeKey: (row) => `${row.memory_id}|${row.user_id}` },
  );
  const commentRows = await byMemoryIds<{ id: string; memory_id: string }>(
    memoryIds,
    (ids, from, to) =>
      supabase
        .from('memory_comments')
        .select('id, memory_id')
        .in('memory_id', ids)
        .order('id', { ascending: true })
        .range(from, to),
    { ...chunk, dedupeKey: (row) => row.id },
  );

  return { memories, media, tags, milestones, likeRows, commentRows };
}

/** Kinds whose loaded row count is below what the pre-load head count saw. */
function findShortfalls(expected: WindowCounts, loaded: WindowRows): Array<keyof WindowCounts> {
  const actual: WindowCounts = {
    memories: loaded.memories.length,
    media: loaded.media.length,
    tags: loaded.tags.length,
    milestones: loaded.milestones.length,
  };
  return (Object.keys(expected) as Array<keyof WindowCounts>).filter((kind) => actual[kind] < expected[kind]);
}

async function buildGenerationContext(
  supabase: Supabase,
  book: ActiveBookRow,
): Promise<Response> {
  const { data: family, error: familyError } = await supabase
    .from('families')
    .select('name, gallery_caption_language')
    .eq('id', book.family_id)
    .maybeSingle();
  if (familyError) throw new ContextLoadError('family');

  let child: { id: string; name: string; dateOfBirth: string | null } | null = null;
  if (book.child_id) {
    const { data: childRow, error: childError } = await supabase
      .from('family_members')
      .select('id, name, date_of_birth')
      .eq('id', book.child_id)
      .maybeSingle();
    if (childError) throw new ContextLoadError('child');
    // A null child on a child-scoped book would otherwise mean "no tag
    // filter, every memory eligible" downstream -- fail instead.
    if (!childRow) throw new ContextInvalidError('child_missing');
    child = { id: childRow.id, name: childRow.name, dateOfBirth: childRow.date_of_birth };
  }

  let windowStart: string;
  let windowEndExclusive: string;
  // No memory can ever match a window before/at its own start (a strict
  // gte/lt pair), so this sentinel makes an 'everything' family with zero
  // memories yield an empty result via the SAME query path below, rather
  // than a malformed date value reaching Postgres.
  const EMPTY_WINDOW_SENTINEL = '0001-01-01';
  if (book.scope_kind === 'everything') {
    const [earliestResult, latestResult] = await Promise.all([
      supabase.from('memories').select('memory_date').eq('family_id', book.family_id).order('memory_date', { ascending: true }).limit(1).maybeSingle(),
      supabase.from('memories').select('memory_date').eq('family_id', book.family_id).order('memory_date', { ascending: false }).limit(1).maybeSingle(),
    ]);
    // An error here must not degrade into the empty-window sentinel (a
    // misleading NO_ELIGIBLE_MEMORIES).
    if (earliestResult.error || latestResult.error) throw new ContextLoadError('everything_window');
    windowStart = earliestResult.data?.memory_date ?? EMPTY_WINDOW_SENTINEL;
    windowEndExclusive = latestResult.data?.memory_date ? addDaysToDateOnly(latestResult.data.memory_date, 1) : EMPTY_WINDOW_SENTINEL;
  } else {
    windowStart = book.scope_start_date!;
    windowEndExclusive = addDaysToDateOnly(book.scope_end_date!, 1);
  }

  // Count BEFORE loading so concurrent inserts between the two can only make
  // loaded >= expected. Only loaded < expected fails (deletions in that gap
  // are rare, hence one re-count + reload before giving up).
  let expected = await countWindowRows(supabase, book.family_id, windowStart, windowEndExclusive);
  let rows = await loadWindowRows(supabase, book.family_id, windowStart, windowEndExclusive);
  let shortfalls = findShortfalls(expected, rows);
  if (shortfalls.length > 0) {
    // Counts only -- never memory content.
    console.error('workflow memory book bridge context shortfall, reloading once', book.id, shortfalls.join(','), JSON.stringify(expected));
    expected = await countWindowRows(supabase, book.family_id, windowStart, windowEndExclusive);
    rows = await loadWindowRows(supabase, book.family_id, windowStart, windowEndExclusive);
    shortfalls = findShortfalls(expected, rows);
    if (shortfalls.length > 0) {
      console.error('workflow memory book bridge context still short after reload', book.id, shortfalls.join(','), JSON.stringify(expected));
      throw new ContextInvalidError(`count_mismatch:${shortfalls.join(',')}`);
    }
  }
  const { memories, media, tags, milestones, likeRows, commentRows } = rows;

  const [familyMembersResult, portraitVersionsResult] = await Promise.all([
    supabase.from('family_members').select('id, name, date_of_birth, nicknames').eq('family_id', book.family_id),
    book.child_id
      ? supabase.from('family_member_portrait_versions')
        .select('id, reference_date, illustrated_profile_key, profile_picture_key')
        .eq('family_member_id', book.child_id).eq('illustrated_profile_status', 'ready')
        .gte('reference_date', windowStart).lt('reference_date', windowEndExclusive).order('reference_date', { ascending: true })
      : Promise.resolve({ data: [] as Array<{ id: string; reference_date: string | null; illustrated_profile_key: string | null; profile_picture_key: string | null }>, error: null }),
  ]);
  if (familyMembersResult.error) throw new ContextLoadError('family_members');
  if (portraitVersionsResult.error) throw new ContextLoadError('portrait_versions');
  const familyMembers = familyMembersResult.data;
  const portraitVersions = portraitVersionsResult.data;

  const engagementCounts: Record<string, number> = {};
  for (const row of likeRows) {
    engagementCounts[row.memory_id] = (engagementCounts[row.memory_id] ?? 0) + 1;
  }
  for (const row of commentRows) {
    engagementCounts[row.memory_id] = (engagementCounts[row.memory_id] ?? 0) + 1;
  }

  const inWindowNonEmptyCaptionCount = memories.filter((m) => (m.content ?? '').trim().length > 0).length;
  let languageEvidenceCaptions: string[] = [];
  if (inWindowNonEmptyCaptionCount < WINDOW_CAPTION_SPARSE_THRESHOLD) {
    const { data: sample, error: sampleError } = await supabase
      .from('memories')
      .select('content')
      .eq('family_id', book.family_id)
      .not('content', 'is', null)
      .neq('content', '')
      .order('memory_date', { ascending: false })
      .order('id', { ascending: false })
      .limit(LANGUAGE_EVIDENCE_SAMPLE_LIMIT);
    if (sampleError) throw new ContextLoadError('language_evidence');
    languageEvidenceCaptions = ((sample ?? []) as Array<{ content: string }>)
      .map((row) => row.content.trim().slice(0, LANGUAGE_EVIDENCE_EXCERPT_MAX_CHARS))
      .filter((c) => c.length > 0);
  }

  return jsonResponse({
    book: {
      id: book.id,
      familyId: book.family_id,
      childId: book.child_id,
      scopeKind: book.scope_kind,
      windowStart,
      windowEndExclusive,
      scopeLabel: book.scope_label,
      pageBudget: book.page_budget,
    },
    child,
    familyName: family?.name ?? 'Family',
    configuredLanguage: family?.gallery_caption_language ?? null,
    memories,
    media,
    tags,
    milestones,
    engagementCounts,
    familyMembers: familyMembers ?? [],
    portraitVersions: portraitVersions ?? [],
    languageEvidenceCaptions,
  });
}

async function handleLoadGenerationContext(
  supabase: Supabase,
  bookId: string,
  attemptId: string,
): Promise<Response> {
  const active = await loadActiveBook(supabase, bookId, attemptId);
  if ('error' in active) return active.error;
  try {
    return await buildGenerationContext(supabase, active.row);
  } catch (error) {
    if (error instanceof ContextInvalidError) {
      // Step name / counts only; never memory content.
      console.error('workflow memory book bridge context invalid', bookId, error.reason);
      return errorResponse('Memory book context is invalid', 422, 'context_invalid');
    }
    const step = error instanceof ContextLoadError ? error.step : error instanceof PagedQueryError ? 'paged_query' : 'unexpected';
    console.error('workflow memory book bridge context load failed', bookId, step);
    return errorResponse('Failed to load memory book context', 500, 'context_load_failed');
  }
}

/** Base62 alphabet -- same generator contract as
 * `_shared/memory-book-manifest.ts`'s `generateShareToken` (22 chars,
 * ~131 bits). Duplicated here rather than imported so this Deno function
 * has no runtime dependency surprise; the token SHAPE (not the RNG
 * mechanics) is the actual cross-file contract, enforced by
 * `media_share_tokens.token`'s own type (text, no length/charset
 * constraint at the DB level -- callers just need "opaque and unguessable"). */
function generateShareToken(): string {
  const alphabet = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
  const length = 22;
  const rejectionCeiling = alphabet.length * Math.floor(256 / alphabet.length);
  let token = '';
  while (token.length < length) {
    const batch = crypto.getRandomValues(new Uint8Array(length - token.length));
    for (const byte of batch) {
      if (token.length === length) break;
      if (byte >= rejectionCeiling) continue;
      token += alphabet[byte % alphabet.length];
    }
  }
  return token;
}

async function handleEnsureShareTokens(
  supabase: ReturnType<typeof createServiceClient>,
  bookId: string,
  attemptId: string,
  memoryIds: string[],
): Promise<Response> {
  const active = await loadActiveBook(supabase, bookId, attemptId);
  if ('error' in active) return active.error;
  if (memoryIds.length === 0) return jsonResponse({ tokensByMemoryId: {} });

  // Duplicate ids would put two identical rows in one bulk insert and trip
  // the unique active-token index on ourselves.
  const uniqueIds = [...new Set(memoryIds)];
  const tokensByMemoryId: Record<string, string> = {};
  const readActiveTokens = async (): Promise<void> => {
    const existing = await byMemoryIds<{ memory_id: string; token: string }>(
      uniqueIds,
      (ids, from, to) =>
        supabase
          .from('media_share_tokens')
          .select('memory_id, token')
          .in('memory_id', ids)
          .is('revoked_at', null)
          .order('token', { ascending: true })
          .range(from, to),
      { chunkSize: MEMORY_ID_CHUNK_SIZE, dedupeKey: (row) => row.token },
    );
    for (const row of existing) tokensByMemoryId[row.memory_id] = row.token;
  };

  // read -> insert-the-missing. A unique violation (23505) on the partial
  // unique index `media_share_tokens_active_memory_key` means an active
  // token for one of these memories appeared since we read (a concurrent or
  // retried call already minted it): that is success for those rows, so
  // re-read and mint only what is still missing. The bulk insert is atomic,
  // so a conflicting insert wrote nothing and the next pass retries the rest.
  const MAX_PASSES = 3;
  for (let pass = 0; pass < MAX_PASSES; pass += 1) {
    try {
      await readActiveTokens();
    } catch {
      return errorResponse('Failed to load share tokens', 500, 'internal_error');
    }
    const missingIds = uniqueIds.filter((id) => !tokensByMemoryId[id]);
    if (missingIds.length === 0) break;
    const newRows = missingIds.map((memory_id) => ({ memory_id, token: generateShareToken() }));
    const { error: insertError } = await supabase.from('media_share_tokens').insert(newRows);
    if (!insertError) {
      for (const row of newRows) tokensByMemoryId[row.memory_id] = row.token;
      break;
    }
    if ((insertError as { code?: string }).code !== '23505' || pass === MAX_PASSES - 1) {
      return errorResponse('Failed to mint share tokens', 500, 'internal_error');
    }
  }

  return jsonResponse({ tokensByMemoryId });
}

interface PublishedBookRow {
  id: string;
  family_id: string;
  child_id: string | null;
  scope_label: string;
  requested_by: string | null;
}

/**
 * "Your memory book is ready" transactional push -- sent to the family
 * member who REQUESTED this book (`requested_by`), never the whole family
 * (unlike notify-family-activity's new-memory push, which fans out to every
 * OTHER member). Deliberately NOT gated on `notify_new_memories` or any
 * other notification preference: this reports the outcome of the
 * requester's own action (they tapped "create book"), the same class of
 * notification as an order-confirmation email, not an activity ping about
 * someone else's content.
 *
 * Called only when `handlePublish`'s CAS actually won (see call site) --
 * that CAS is keyed on `generation_attempt_id` + `status = 'generating'`,
 * so it can succeed at most ONCE per attempt (Postgres evaluates the
 * `UPDATE ... WHERE` against the row's live state at write time, same
 * argument as this file's header comment / `handlePublish`'s own CAS
 * comment). This bridge still has no nonce-replay ledger, but a replayed
 * publish request within the signature window re-runs the identical CAS
 * against a row that is no longer `'generating'` -- `data` comes back null,
 * this function is never called a second time, and no duplicate push goes
 * out.
 */
async function sendBookReadyPush(
  supabase: ReturnType<typeof createServiceClient>,
  sendPush: typeof sendExpoPushNotification,
  book: PublishedBookRow,
): Promise<void> {
  if (!book.requested_by) return; // No requester on record -- nothing to notify.

  const { data: profile, error } = await supabase
    .from('user_profiles')
    .select('id, expo_push_token, deleted_at')
    .eq('id', book.requested_by)
    .maybeSingle();
  // Same deleted_at/missing-token guard style as send-daily-reminder/index.ts.
  if (error || !profile || profile.deleted_at || !profile.expo_push_token) return;

  await sendPush(
    profile.expo_push_token,
    'Your memory book is ready',
    `“${book.scope_label}” is ready to look through.`,
    {
      route: 'memory-book',
      familyId: book.family_id,
      ...(book.child_id ? { memberId: book.child_id } : {}),
      bookId: book.id,
    },
  );
}

async function handlePublish(
  supabase: ReturnType<typeof createServiceClient>,
  bookId: string,
  attemptId: string,
  bookDocument: unknown,
  sendPush: typeof sendExpoPushNotification = sendExpoPushNotification,
): Promise<Response> {
  if (!bookDocument || typeof bookDocument !== 'object') {
    return errorResponse('bookDocument is required', 400, 'validation_error');
  }
  // Compare-and-set: Postgres evaluates this WHERE clause against the
  // CURRENT row at write time, not a value this function read earlier --
  // see generate-memory-book/index.ts's header comment for why this single
  // UPDATE statement is already a complete CAS with no separate RPC needed.
  const { data, error } = await supabase
    .from('memory_books')
    .update({
      status: 'ready',
      book_document: bookDocument,
      generation_completed_at: new Date().toISOString(),
      // Memory-book shelf redesign (migration
      // 20260917120000_memory_book_cover_asset.sql) -- denormalized here, in
      // the SAME CAS update that flips status to 'ready', so the picker's
      // poll loop never has to ship the whole book_document to render a
      // shelf tile. See _shared/memory-book-cover.ts's own header comment
      // for the precedence this mirrors.
      cover_asset_key: pickCoverAssetKey(bookDocument),
    })
    .eq('id', bookId)
    .eq('generation_attempt_id', attemptId)
    .eq('status', 'generating')
    .select('id, family_id, child_id, scope_label, requested_by')
    .maybeSingle<PublishedBookRow>();
  if (error) return errorResponse('Failed to publish memory book', 500, 'internal_error');

  if (data) {
    try {
      await sendBookReadyPush(supabase, sendPush, data);
    } catch {
      // A push failure must NEVER fail the publish response -- the book is
      // already durably 'ready' by this point. Log the book id only, no
      // PII/memory content (AGENTS.md "Child & family data" house rule).
      console.error('workflow-memory-book-bridge ready push failed', bookId);
    }
  }

  return jsonResponse({ published: Boolean(data) });
}

async function handleFail(
  supabase: ReturnType<typeof createServiceClient>,
  bookId: string,
  attemptId: string,
  failureReason: string,
): Promise<Response> {
  const { data, error } = await supabase
    .from('memory_books')
    .update({
      status: 'failed',
      failure_reason: failureReason.slice(0, 200),
      generation_completed_at: new Date().toISOString(),
    })
    .eq('id', bookId)
    .eq('generation_attempt_id', attemptId)
    .eq('status', 'generating')
    .select('id')
    .maybeSingle();
  if (error) return errorResponse('Failed to record memory book failure', 500, 'internal_error');
  return jsonResponse({ failed: Boolean(data) });
}

async function handleReconcile(
  supabase: ReturnType<typeof createServiceClient>,
  bookId: string,
  attemptId: string,
): Promise<Response> {
  const { data: row, error } = await supabase
    .from('memory_books')
    .select('status, generation_attempt_id')
    .eq('id', bookId)
    .maybeSingle();
  if (error) return errorResponse('Failed to reconcile memory book', 500, 'internal_error');
  if (!row) return jsonResponse({ outcome: 'failed' });

  if (row.status === 'ready') {
    // Deliberately no ready-push here on the 'succeeded' outcome: reconcile
    // only runs after a LOST publish response (the Workflow never learned
    // whether its own publish call landed), and the flip to 'ready' already
    // happened -- either from that same lost call, or (mid-window replay)
    // from `handlePublish`'s own CAS, which already sent the push when it
    // won. Sending one here too would risk a duplicate on every reconcile
    // of an already-notified book.
    return jsonResponse({ outcome: row.generation_attempt_id === attemptId ? 'succeeded' : 'superseded' });
  }
  if (row.status === 'failed') return jsonResponse({ outcome: 'failed' });
  if (row.status === 'generating' && row.generation_attempt_id === attemptId) {
    return jsonResponse({ outcome: 'retry' });
  }
  return jsonResponse({ outcome: 'superseded' });
}

export async function handleWorkflowMemoryBookBridge(
  req: Request,
  dependencyOverrides: {
    createServiceClient?: typeof createServiceClient;
    sendExpoPushNotification?: typeof sendExpoPushNotification;
  } = {},
): Promise<Response> {
  if (req.method !== 'POST') return errorResponse('Method not allowed', 405, 'method_not_allowed');

  const rawBody = await req.text();
  if (!(await isSignedWorkflowRequest(req, rawBody))) {
    return errorResponse('Unauthorized', 401, 'unauthorized');
  }

  let body: BridgeBody;
  try {
    body = JSON.parse(rawBody);
  } catch {
    return errorResponse('Invalid JSON body', 400, 'invalid_json');
  }

  const validOperations = new Set(['load_generation_context', 'ensure_share_tokens', 'publish', 'fail', 'reconcile']);
  if (typeof body.operation !== 'string' || !validOperations.has(body.operation) || !isUuid(body.bookId) || !isUuid(body.attemptId)) {
    return errorResponse('Invalid workflow operation', 400, 'validation_error');
  }

  const createClient = dependencyOverrides.createServiceClient ?? createServiceClient;
  const supabase = createClient();
  const bookId = body.bookId as string;
  const attemptId = body.attemptId as string;

  try {
    switch (body.operation) {
      case 'load_generation_context':
        return await handleLoadGenerationContext(supabase, bookId, attemptId);
      case 'ensure_share_tokens': {
        const memoryIds = Array.isArray(body.memoryIds) ? body.memoryIds.filter((id): id is string => typeof id === 'string') : [];
        return await handleEnsureShareTokens(supabase, bookId, attemptId, memoryIds);
      }
      case 'publish':
        return await handlePublish(
          supabase,
          bookId,
          attemptId,
          body.bookDocument,
          dependencyOverrides.sendExpoPushNotification ?? sendExpoPushNotification,
        );
      case 'fail': {
        const reason = typeof body.failureReason === 'string' && body.failureReason.trim() ? body.failureReason.trim() : 'UNKNOWN_ERROR';
        return await handleFail(supabase, bookId, attemptId, reason);
      }
      case 'reconcile':
        return await handleReconcile(supabase, bookId, attemptId);
      default:
        return errorResponse('Invalid workflow operation', 400, 'validation_error');
    }
  } catch {
    console.error('workflow memory book bridge failed', body.operation, bookId);
    return errorResponse('Workflow bridge operation failed', 500, 'internal_error');
  }
}

if (import.meta.main) serveWithSentry('workflow-memory-book-bridge', (request) => handleWorkflowMemoryBookBridge(request));
