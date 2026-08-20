/**
 * Additive production demo-fixture engagement seeder.
 *
 * Dry-run is the default. `--apply` is required before Auth, membership, or
 * engagement rows are created. The fixture is deterministic and idempotent:
 * rerunning it adds only missing synthetic accounts, likes, or comments.
 *
 * Usage:
 *   npx --yes deno run --allow-all \
 *     --env-file=supabase/.env.local --env-file=.env.local \
 *     supabase/scripts/seed-demo-engagement.ts
 *   ... seed-demo-engagement.ts --apply
 *   ... seed-demo-engagement.ts --apply --phase audit
 */
import { type SupabaseClient } from "npm:@supabase/supabase-js@2";

import {
  createAdmin,
  deterministicUuid,
  findUserByEmail,
} from "./seed-demo-account.ts";
import {
  DEMO_ACCOUNT_EMAIL,
  DEMO_FAMILY,
  DEMO_MEMORIES,
} from "./demo-family-spec.ts";
import {
  DEMO_EXISTING_MEMORY_DATE_UPDATES,
  DEMO_TOP_UP_MEMORIES,
} from "./demo-top-up-spec.ts";
import {
  DEMO_ENGAGEMENT_ACTORS,
  DEMO_ENGAGEMENT_CURRENT_DATE,
  DEMO_ENGAGEMENT_MEMORY_COUNT,
  DEMO_MEMORY_ENGAGEMENT,
  type DemoEngagementActorSpec,
  type DemoMemoryEngagementSpec,
} from "./demo-engagement-spec.ts";

const COMMENT_SCOPE = "demo-engagement-comment";
const MEMBERSHIP_SCOPE = "demo-engagement-membership";
const ACTOR_SLUGS: readonly string[] = DEMO_ENGAGEMENT_ACTORS.map((actor) =>
  actor.slug
);

type Phase = "all" | "accounts" | "engagement" | "audit";

export interface EngagementCliOptions {
  apply: boolean;
  phase: Phase;
  only: Set<string>;
}

interface DemoMemoryEntry {
  slug: string;
  scope: "memory" | "demo-top-up-memory";
  memoryDate: string;
  caption: string;
}

interface DemoEngagementContext {
  admin: SupabaseClient;
  familyId: string;
  memories: Map<string, DemoMemoryEntry & { id: string }>;
  actorIds: Map<string, string>;
}

interface MemoryRow {
  id: string;
  family_id: string;
  content: string | null;
  memory_date: string;
}

interface LikeRow {
  memory_id: string;
  user_id: string;
}

interface CommentRow {
  id: string;
  memory_id: string;
  user_id: string;
  content: string;
  created_at: string;
}

function status(state: string, details: Record<string, unknown> = {}): void {
  console.log(JSON.stringify({ state, ...details }));
}

function slugify(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(
    /^-+|-+$/g,
    "",
  );
}

function allMemoryEntries(): DemoMemoryEntry[] {
  return [
    ...DEMO_MEMORIES.map((memory) => {
      const dateUpdate = DEMO_EXISTING_MEMORY_DATE_UPDATES.find((update) =>
        update.memorySlug === memory.slug
      );
      return {
        slug: memory.slug,
        scope: "memory" as const,
        memoryDate: dateUpdate?.targetDate ?? memory.memoryDate,
        caption: memory.caption,
      };
    }),
    ...DEMO_TOP_UP_MEMORIES.map((memory) => ({
      slug: memory.slug,
      scope: "demo-top-up-memory" as const,
      memoryDate: memory.memoryDate,
      caption: memory.caption,
    })),
  ];
}

function memoryScopeForSlug(slug: string): DemoMemoryEntry["scope"] {
  return DEMO_MEMORIES.some((memory) => memory.slug === slug)
    ? "memory"
    : "demo-top-up-memory";
}

export function parseArgs(args: string[]): EngagementCliOptions {
  const options: EngagementCliOptions = {
    apply: false,
    phase: "all",
    only: new Set(),
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--apply") {
      options.apply = true;
      continue;
    }
    if (arg === "--audit") {
      options.phase = "audit";
      continue;
    }
    if (arg === "--phase") {
      const phase = args[index + 1] as Phase | undefined;
      if (
        !phase ||
        !["all", "accounts", "engagement", "audit"].includes(phase)
      ) {
        throw new Error(
          "--phase must be all, accounts, engagement, or audit",
        );
      }
      options.phase = phase;
      index += 1;
      continue;
    }
    if (arg === "--only") {
      const slug = args[index + 1];
      if (!slug) throw new Error("--only requires a memory slug");
      options.only.add(slugify(slug));
      index += 1;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  return options;
}

export function shouldRun(
  options: EngagementCliOptions,
  memorySlug: string,
): boolean {
  return options.only.size === 0 || options.only.has(slugify(memorySlug));
}

function assertFixtureSpec(): void {
  const entries = allMemoryEntries();
  const entrySlugs = new Set(entries.map((entry) => entry.slug));
  const engagementSlugs = new Set<string>(
    DEMO_MEMORY_ENGAGEMENT.map((memory) => memory.memorySlug),
  );
  const actorSlugs = new Set<string>(ACTOR_SLUGS);

  if (entries.length !== DEMO_ENGAGEMENT_MEMORY_COUNT || entries.length !== 56) {
    throw new Error("Engagement fixture must cover exactly 56 demo memories");
  }
  if (entrySlugs.size !== entries.length) {
    throw new Error("Demo memory slugs must be unique");
  }
  if (engagementSlugs.size !== DEMO_MEMORY_ENGAGEMENT.length) {
    throw new Error("Engagement memory slugs must be unique");
  }
  for (const slug of entrySlugs) {
    if (!engagementSlugs.has(slug)) {
      throw new Error(`Missing engagement comments for ${slug}`);
    }
  }
  for (const slug of engagementSlugs) {
    if (!entrySlugs.has(slug)) {
      throw new Error(`Engagement references unknown memory ${slug}`);
    }
  }
  if (new Set(DEMO_ENGAGEMENT_ACTORS.map((actor) => actor.email)).size !== ACTOR_SLUGS.length) {
    throw new Error("Engagement actor emails must be unique");
  }
  if (DEMO_ENGAGEMENT_ACTORS.some((actor) => (actor.email as string) === DEMO_ACCOUNT_EMAIL)) {
    throw new Error("Engagement actors must not reuse the demo owner email");
  }

  for (const memory of DEMO_MEMORY_ENGAGEMENT) {
    if (memory.comments.length < 2 || memory.comments.length > 6) {
      throw new Error(
        `Memory needs between two and six comments: ${memory.memorySlug}`,
      );
    }
    for (const [index, comment] of memory.comments.entries()) {
      if (!actorSlugs.has(comment.actorSlug)) {
        throw new Error(
          `Unknown comment actor ${memory.memorySlug}/${index}: ${comment.actorSlug}`,
        );
      }
      const content = comment.content.trim();
      if (!content || content.length > 1000) {
        throw new Error(`Invalid comment content: ${memory.memorySlug}/${index}`);
      }
      if (content.includes("—")) {
        throw new Error(`Comment contains an em dash: ${memory.memorySlug}/${index}`);
      }
    }
  }
}

function hashSlug(slug: string): number {
  let hash = 2166136261;
  for (const character of slug) {
    hash ^= character.charCodeAt(0);
    hash = Math.imul(hash, 16777619) >>> 0;
  }
  return hash >>> 0;
}

/** Choose 2–4 synthetic viewers in a stable but non-uniform pattern. */
export function selectLikeActorSlugs(memorySlug: string): string[] {
  const hash = hashSlug(memorySlug);
  const count = 2 + (hash % 3);
  const start = (hash >>> 5) % ACTOR_SLUGS.length;
  const stride = (hash & 1) === 0 ? 1 : 3;
  return Array.from({ length: count }, (_, index) =>
    ACTOR_SLUGS[(start + index * stride) % ACTOR_SLUGS.length]
  );
}

function fixtureTimestamp(memoryIndex: number, itemIndex: number): string {
  const baseDate = new Date(`${DEMO_ENGAGEMENT_CURRENT_DATE}T09:00:00.000Z`);
  baseDate.setUTCDate(baseDate.getUTCDate() - 1 - ((memoryIndex * 7) % 10));
  baseDate.setUTCHours(baseDate.getUTCHours() + itemIndex * 3);
  return baseDate.toISOString();
}

function commentSpecForSlug(slug: string): DemoMemoryEngagementSpec {
  const spec = DEMO_MEMORY_ENGAGEMENT.find((memory) => memory.memorySlug === slug);
  if (!spec) throw new Error(`Missing engagement spec for ${slug}`);
  return spec;
}

async function findDemoFamily(admin: SupabaseClient): Promise<{
  familyId: string;
  ownerId: string;
}> {
  const owner = await findUserByEmail(admin, DEMO_ACCOUNT_EMAIL);
  if (!owner) throw new Error(`Demo account was not found: ${DEMO_ACCOUNT_EMAIL}`);

  const { data: families, error } = await admin
    .from("families")
    .select("id, owner_id, name, deleted_at")
    .eq("owner_id", owner.id)
    .eq("name", DEMO_FAMILY.name)
    .is("deleted_at", null)
    .limit(1);
  if (error) throw new Error(`Could not load demo family: ${error.message}`);
  const family = (families ?? [])[0] as {
    id: string;
    owner_id: string;
  } | undefined;
  if (!family) throw new Error(`Demo family was not found: ${DEMO_FAMILY.name}`);
  return { familyId: family.id, ownerId: family.owner_id };
}

async function loadDemoMemories(
  admin: SupabaseClient,
  familyId: string,
): Promise<Map<string, DemoMemoryEntry & { id: string }>> {
  const entries = allMemoryEntries();
  const { data, error } = await admin
    .from("memories")
    .select("id, family_id, content, memory_date")
    .eq("family_id", familyId);
  if (error) throw new Error(`Could not load demo memories: ${error.message}`);

  const rows = (data ?? []) as MemoryRow[];
  const rowsById = new Map(rows.map((row) => [row.id, row]));
  const result = new Map<string, DemoMemoryEntry & { id: string }>();
  for (const entry of entries) {
    const id = await deterministicUuid(entry.scope, entry.slug);
    const row = rowsById.get(id);
    if (
      !row ||
      row.family_id !== familyId ||
      row.content !== entry.caption ||
      row.memory_date !== entry.memoryDate
    ) {
      throw new Error(`Demo memory is missing or changed: ${entry.slug}`);
    }
    result.set(entry.slug, { ...entry, id });
  }
  return result;
}

async function ensureActor(
  admin: SupabaseClient,
  familyId: string,
  actor: DemoEngagementActorSpec,
): Promise<string> {
  let authUser = await findUserByEmail(admin, actor.email);
  if (!authUser) {
    const { data, error } = await admin.auth.admin.createUser({
      email: actor.email,
      email_confirm: true,
      user_metadata: { name: actor.name, timezone: actor.timezone },
    });
    if (error || !data.user) {
      throw new Error(
        `Could not create engagement actor ${actor.slug}: ${error?.message ?? "unknown error"}`,
      );
    }
    authUser = data.user;
  } else if (!authUser.email_confirmed_at) {
    const { error } = await admin.auth.admin.updateUserById(authUser.id, {
      email_confirm: true,
    });
    if (error) throw new Error(`Could not confirm actor ${actor.slug}: ${error.message}`);
  }

  const { data: profile, error: profileLookupError } = await admin
    .from("user_profiles")
    .select("id")
    .eq("id", authUser.id)
    .maybeSingle();
  if (profileLookupError) {
    throw new Error(`Could not load actor profile ${actor.slug}: ${profileLookupError.message}`);
  }
  const profileValues = {
    name: actor.name,
    timezone: actor.timezone,
    has_completed_onboarding: true,
    active_family_id: familyId,
  };
  if (profile) {
    const { error } = await admin
      .from("user_profiles")
      .update(profileValues)
      .eq("id", authUser.id);
    if (error) throw new Error(`Could not update actor profile ${actor.slug}: ${error.message}`);
  } else {
    const { error } = await admin.from("user_profiles").insert({
      id: authUser.id,
      ...profileValues,
    });
    if (error) throw new Error(`Could not create actor profile ${actor.slug}: ${error.message}`);
  }

  const { data: membership, error: membershipLookupError } = await admin
    .from("family_memberships")
    .select("id, family_id, user_id, role")
    .eq("family_id", familyId)
    .eq("user_id", authUser.id)
    .maybeSingle();
  if (membershipLookupError) {
    throw new Error(
      `Could not load actor membership ${actor.slug}: ${membershipLookupError.message}`,
    );
  }
  if (membership && membership.role !== actor.role) {
    throw new Error(
      `Refusing to change existing actor role ${actor.slug}: ${membership.role}`,
    );
  }
  if (!membership) {
    const membershipId = await deterministicUuid(MEMBERSHIP_SCOPE, actor.slug);
    const { error } = await admin.from("family_memberships").insert({
      id: membershipId,
      family_id: familyId,
      user_id: authUser.id,
      role: actor.role,
    });
    if (error) {
      throw new Error(`Could not add actor ${actor.slug} to family: ${error.message}`);
    }
  }
  return authUser.id;
}

async function ensureActors(
  admin: SupabaseClient,
  familyId: string,
): Promise<Map<string, string>> {
  const actorIds = new Map<string, string>();
  for (const actor of DEMO_ENGAGEMENT_ACTORS) {
    const actorId = await ensureActor(admin, familyId, actor);
    actorIds.set(actor.slug, actorId);
    status("actor_ready", { slug: actor.slug, id: actorId });
  }
  return actorIds;
}

async function seedEngagement(
  context: DemoEngagementContext,
  options: EngagementCliOptions,
): Promise<{ likeCount: number; commentCount: number }> {
  const likeRows: Array<LikeRow & { created_at: string }> = [];
  const commentRows: Array<CommentRow> = [];
  const entries = [...context.memories.values()].filter((memory) =>
    shouldRun(options, memory.slug)
  );

  for (const [memoryIndex, memory] of entries.entries()) {
    for (const [actorIndex, actorSlug] of selectLikeActorSlugs(memory.slug).entries()) {
      const actorId = context.actorIds.get(actorSlug);
      if (!actorId) throw new Error(`Missing actor id for ${actorSlug}`);
      likeRows.push({
        memory_id: memory.id,
        user_id: actorId,
        created_at: fixtureTimestamp(memoryIndex, actorIndex),
      });
    }

    const comments = commentSpecForSlug(memory.slug).comments;
    for (const [commentIndex, spec] of comments.entries()) {
      const actorId = context.actorIds.get(spec.actorSlug);
      if (!actorId) throw new Error(`Missing actor id for ${spec.actorSlug}`);
      commentRows.push({
        id: await deterministicUuid(
          COMMENT_SCOPE,
          `${memory.slug}:${commentIndex}`,
        ),
        memory_id: memory.id,
        user_id: actorId,
        content: spec.content.trim(),
        created_at: fixtureTimestamp(memoryIndex, commentIndex),
      });
    }
  }

  if (likeRows.length > 0) {
    const { error } = await context.admin.from("memory_likes").upsert(
      likeRows,
      { onConflict: "memory_id,user_id", ignoreDuplicates: true },
    );
    if (error) throw new Error(`Could not seed likes: ${error.message}`);
  }
  if (commentRows.length > 0) {
    const { error } = await context.admin.from("memory_comments").upsert(
      commentRows,
      { onConflict: "id", ignoreDuplicates: true },
    );
    if (error) throw new Error(`Could not seed comments: ${error.message}`);
  }

  await verifySeededRows(context, likeRows, commentRows);
  for (const memory of entries) {
    status("engagement_seeded", { slug: memory.slug, id: memory.id });
  }
  return { likeCount: likeRows.length, commentCount: commentRows.length };
}

async function verifySeededRows(
  context: DemoEngagementContext,
  expectedLikes: Array<LikeRow & { created_at: string }>,
  expectedComments: Array<CommentRow>,
): Promise<void> {
  const memoryIds = [...new Set([
    ...expectedLikes.map((row) => row.memory_id),
    ...expectedComments.map((row) => row.memory_id),
  ])];
  const { data: likes, error: likesError } = await context.admin
    .from("memory_likes")
    .select("memory_id, user_id")
    .in("memory_id", memoryIds);
  if (likesError) throw new Error(`Could not verify likes: ${likesError.message}`);
  const likeKeys = new Set(
    ((likes ?? []) as LikeRow[]).map((row) => `${row.memory_id}:${row.user_id}`),
  );
  for (const expected of expectedLikes) {
    if (!likeKeys.has(`${expected.memory_id}:${expected.user_id}`)) {
      throw new Error("Seeded like could not be verified");
    }
  }

  const commentIds = expectedComments.map((row) => row.id);
  const { data: comments, error: commentsError } = await context.admin
    .from("memory_comments")
    .select("id, memory_id, user_id, content, created_at")
    .in("id", commentIds);
  if (commentsError) {
    throw new Error(`Could not verify comments: ${commentsError.message}`);
  }
  const commentsById = new Map(
    ((comments ?? []) as CommentRow[]).map((row) => [row.id, row]),
  );
  for (const expected of expectedComments) {
    const actual = commentsById.get(expected.id);
    if (
      !actual ||
      actual.memory_id !== expected.memory_id ||
      actual.user_id !== expected.user_id ||
      actual.content !== expected.content
    ) {
      throw new Error("Seeded comment could not be verified");
    }
  }
}

async function audit(
  context: DemoEngagementContext,
): Promise<void> {
  const memoryIds = [...context.memories.values()].map((memory) => memory.id);
  const [{ data: likes, error: likesError }, { data: comments, error: commentsError }] =
    await Promise.all([
      context.admin.from("memory_likes").select("memory_id, user_id").in(
        "memory_id",
        memoryIds,
      ),
      context.admin.from("memory_comments").select("memory_id, user_id").in(
        "memory_id",
        memoryIds,
      ),
    ]);
  if (likesError) throw new Error(`Could not audit likes: ${likesError.message}`);
  if (commentsError) {
    throw new Error(`Could not audit comments: ${commentsError.message}`);
  }
  const likeRows = (likes ?? []) as LikeRow[];
  const commentRows = (comments ?? []) as Array<Pick<CommentRow, "memory_id" | "user_id">>;
  status("audit", {
    familyId: context.familyId,
    memoryCount: memoryIds.length,
    actorCount: DEMO_ENGAGEMENT_ACTORS.length,
    likeCount: likeRows.length,
    commentCount: commentRows.length,
    likedMemoryCount: new Set(likeRows.map((row) => row.memory_id)).size,
    commentedMemoryCount: new Set(commentRows.map((row) => row.memory_id)).size,
    commentingActorCount: new Set(commentRows.map((row) => row.user_id)).size,
  });
}

async function run(): Promise<void> {
  const options = parseArgs(Deno.args);
  assertFixtureSpec();

  if (!options.apply) {
    const likeCount = allMemoryEntries().reduce(
      (total, memory) => total + selectLikeActorSlugs(memory.slug).length,
      0,
    );
    const commentCount = DEMO_MEMORY_ENGAGEMENT.reduce(
      (total, memory) => total + memory.comments.length,
      0,
    );
    status("dry_run", {
      currentDate: DEMO_ENGAGEMENT_CURRENT_DATE,
      syntheticActors: DEMO_ENGAGEMENT_ACTORS.length,
      memories: DEMO_ENGAGEMENT_MEMORY_COUNT,
      likes: likeCount,
      comments: commentCount,
      phase: options.phase,
    });
    return;
  }

  const admin = createAdmin();
  const { familyId } = await findDemoFamily(admin);
  const memories = await loadDemoMemories(admin, familyId);
  const actorIds = options.phase === "audit"
    ? new Map<string, string>()
    : await ensureActors(admin, familyId);
  const context: DemoEngagementContext = {
    admin,
    familyId,
    memories,
    actorIds,
  };

  if (options.phase === "all" || options.phase === "engagement") {
    const counts = await seedEngagement(context, options);
    status("verified", counts);
  }
  if (options.phase === "audit") await audit(context);
}

if (import.meta.main) await run();
