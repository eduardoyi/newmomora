/**
 * Shared types for the Memory Book Cloudflare Workflow (V5a "part C").
 * Mirrors cloudflare/memory-illustration-worker/src/types.ts's conventions:
 * the Workflow event payload stays ID-only (never memory/child content), and
 * every bridge response type is validated at the call site -- never trusted
 * blind (see bridge.ts).
 */

export interface Env {
  ENVIRONMENT: string;
  SUPABASE_BRIDGE_URL: string;
  DISPATCH_SIGNING_SECRET: string;
  SUPABASE_BRIDGE_HMAC_SECRET: string;
  OPENAI_API_KEY: string;
  MEMORY_BOOK_PREVIEWS: R2Bucket;
  MEMORY_BOOK_WORKFLOW: Workflow;
}

/** The Workflow event payload -- deliberately ID-only (no memory/child
 * content, no prompt, no candidate data). `bookId` is the stable
 * `memory_books.id`; `attemptId` is the CAS token minted by the dispatcher
 * for THIS attempt (== the Workflow instance id, == the initial
 * `generation_attempt_id`/`workflow_instance_id` the dispatcher wrote --
 * see generate-memory-book/index.ts). Every private input (scope, family
 * memories, tags, milestones...) is fetched fresh from the Supabase bridge
 * inside a step, never carried in this event. */
export interface WorkflowDispatchPayload {
  bookId: string;
  attemptId: string;
}

export const WORKFLOW_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

// ── Bridge operation payloads/responses ────────────────────────────────────

export type BridgeOperation =
  | 'load_generation_context'
  | 'ensure_share_tokens'
  | 'publish'
  | 'fail'
  | 'reconcile';

export interface DbMemoryRow {
  id: string;
  content: string | null;
  memory_date: string;
  memory_type: string;
  emotion: string | null;
  topics: string[];
  topic_details: Record<string, string>;
  illustration_key: string | null;
}

export interface DbMediaRow {
  id: string;
  memory_id: string;
  object_key: string;
  preview_object_key: string | null;
  content_type: string;
  position: number;
  duration_ms: number | null;
  aspect_ratio: number | null;
}

export interface DbTagRow {
  memory_id: string;
  family_member_id: string;
}

export interface DbMilestoneRow {
  memory_id: string;
  family_member_id: string;
  milestone_id: string;
  detail: string | null;
  out_of_band: boolean;
}

export interface DbFamilyMemberRow {
  id: string;
  name: string;
  date_of_birth: string | null;
  nicknames: string[];
}

export interface DbPortraitVersionRow {
  id: string;
  reference_date: string | null;
  illustrated_profile_key: string | null;
  profile_picture_key: string | null;
}

export interface GenerationContextResponse {
  book: {
    id: string;
    familyId: string;
    childId: string | null;
    scopeKind: 'age_year' | 'calendar_year' | 'everything' | 'custom_range';
    /** Half-open window, matching the eval CLI's own convention -- `start`
     * inclusive, `endExclusive` exclusive. `everything` scope resolves this
     * server-side (bridge) to the family's actual memory date range so the
     * rest of the pipeline never needs a null-window special case. */
    windowStart: string;
    windowEndExclusive: string;
    scopeLabel: string;
    pageBudget: number;
  };
  child: { id: string; name: string; dateOfBirth: string | null } | null;
  familyName: string;
  configuredLanguage: string | null;
  memories: DbMemoryRow[];
  media: DbMediaRow[];
  tags: DbTagRow[];
  milestones: DbMilestoneRow[];
  engagementCounts: Record<string, number>;
  familyMembers: DbFamilyMemberRow[];
  portraitVersions: DbPortraitVersionRow[];
  /** Recent account-wide non-empty captions, populated by the bridge only
   * when the window's own caption count is sparse (mirrors the eval CLI's
   * WINDOW_CAPTION_SPARSE_THRESHOLD). `[]` otherwise. */
  languageEvidenceCaptions: string[];
}

export interface EnsureShareTokensResponse {
  tokensByMemoryId: Record<string, string>;
}

export interface PublishResponse {
  published: boolean;
}

export interface FailResponse {
  failed: boolean;
}

export type ReconcileOutcome = 'succeeded' | 'failed' | 'retry' | 'superseded';

export interface ReconcileResponse {
  outcome: ReconcileOutcome;
}
