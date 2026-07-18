/**
 * Production demo-fixture seeder.
 *
 * This is deliberately dry-run by default. `--apply` is required before any
 * external request which can create data or incur model charges is made.
 *
 * Usage:
 *   deno run --allow-all --env-file=supabase/.env.local --env-file=.env.local \
 *     supabase/scripts/seed-demo-account.ts [--apply] [--phase profiles|memories|all] [--only slug]
 */
import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2";
import {
  createPresignedGetUrls,
  getObjectBytes,
  putObjectBytes,
} from "../functions/_shared/r2.ts";
import {
  buildMemoryMediaAssetKey,
  buildPortraitVersionPhotoKey,
} from "../functions/_shared/storage-keys.ts";
import { DEMO_FAMILY_SPEC } from "./demo-family-spec.ts";

const DEMO_ACCOUNT_EMAIL = "hello+demo@usemomora.com";
const IMAGE_MODEL = "gpt-image-2";
const PORTRAIT_POLL_ATTEMPTS = 36;
const ILLUSTRATION_POLL_ATTEMPTS = 42;
const POLL_INTERVAL_MS = 5_000;
const VIDEO_DURATION_TOLERANCE_SECONDS = 1.5;
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const MAX_VIDEO_BYTES = 100 * 1024 * 1024;
const GENERATED_IMAGE_ASPECT_RATIO = 2 / 3;
const ASPECT_RATIO_TOLERANCE = 0.04;
const SEEDANCE_STATE_PATH = "/tmp/momora-demo-seedance-requests.json";
const FAL_QUEUE_ORIGIN = "https://queue.fal.run";
const SEEDANCE_QUEUE_BASE = `${FAL_QUEUE_ORIGIN}/bytedance/seedance-2.0`;
const SEEDANCE_QUEUE_SUBMISSION_URL =
  `${SEEDANCE_QUEUE_BASE}/reference-to-video`;

type Phase = "all" | "profiles" | "memories";
type MemoryType = "text_only" | "text_illustration" | "media";
type AssetKind = "photo" | "video";

interface DemoMemberSpec {
  slug: string;
  name: string;
  dateOfBirth?: string | null;
  gender?: string | null;
  additionalInfo?: string | null;
  profilePhotoPrompt: string;
  nicknames?: readonly string[];
  isUserProfile?: boolean;
  /** Earlier demo members whose synthetic source photos may guide family resemblance. */
  profileReferenceSlugs?: string[];
}

interface DemoAssetSpec {
  slug: string;
  kind: AssetKind;
  prompt: string;
  memberSlugs?: string[];
  contentType?: string;
  aspectRatio?: "2:3" | "9:16";
}

interface DemoMemorySpec {
  slug: string;
  type: MemoryType;
  caption?: string | null;
  memoryDate: string;
  tags?: string[];
  /** Used only for generated photo/video assets, never logged. */
  prompt?: string;
  assets?: DemoAssetSpec[];
}

interface DemoFamilySpec {
  family: { slug: string; name: string; portraitReferenceDate?: string };
  account?: { name?: string; timezone?: string };
  members: DemoMemberSpec[];
  memories: DemoMemorySpec[];
}

interface CliOptions {
  apply: boolean;
  phase: Phase;
  only: Set<string>;
}

interface DemoContext {
  admin: SupabaseClient;
  user: SupabaseClient;
  userId: string;
  familyId: string;
  spec: DemoFamilySpec;
  options: CliOptions;
  memberIds: Map<string, string>;
  memberSourceKeys: Map<string, string>;
  memberVideoReferenceKeys: Map<string, string>;
}

interface OwnedFamilyMembership {
  family_id: string;
  family:
    | { id: string; name: string; deleted_at: string | null }
    | Array<{ id: string; name: string; deleted_at: string | null }>
    | null;
}

interface VideoProbeData {
  format?: { duration?: string };
  streams?: Array<{ width?: number; height?: number }>;
}

export interface SeedanceQueueDescriptor {
  requestId: string;
  statusUrl: string;
  responseUrl: string;
}

interface SeedanceRequestState {
  version: 2;
  requests: Record<string, SeedanceQueueDescriptor>;
}

interface MediaAssetRow {
  objectKey: string;
  previewObjectKey?: string | null;
  contentType: string;
  durationMs?: number | null;
  aspectRatio?: number | null;
}

function status(slug: string, state: string, id?: string): void {
  console.log(JSON.stringify({ slug, state, ...(id ? { id } : {}) }));
}

function requireEnv(name: string): string {
  const value = Deno.env.get(name);
  if (!value) throw new Error(`Missing ${name}`);
  return value;
}

function supabaseUrl(): string {
  return Deno.env.get("SUPABASE_URL") ?? requireEnv("EXPO_PUBLIC_SUPABASE_URL");
}

function supabaseAnonKey(): string {
  return Deno.env.get("SUPABASE_ANON_KEY") ??
    requireEnv("EXPO_PUBLIC_SUPABASE_ANON_KEY");
}

function slugify(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(
    /^-+|-+$/g,
    "",
  );
}

/** A stable UUIDv5-shaped identifier without a new dependency. */
export async function deterministicUuid(
  scope: string,
  slug: string,
): Promise<string> {
  const input = new TextEncoder().encode(
    `momora-demo:${scope}:${slugify(slug)}`,
  );
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", input));
  digest[6] = (digest[6] & 0x0f) | 0x50;
  digest[8] = (digest[8] & 0x3f) | 0x80;
  const hex = [...digest.slice(0, 16)].map((byte) =>
    byte.toString(16).padStart(2, "0")
  ).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${
    hex.slice(16, 20)
  }-${hex.slice(20)}`;
}

export function parseArgs(args: string[]): CliOptions {
  const options: CliOptions = { apply: false, phase: "all", only: new Set() };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--apply") {
      options.apply = true;
    } else if (arg === "--phase") {
      const phase = args[index + 1] as Phase | undefined;
      if (!phase || !["all", "profiles", "memories"].includes(phase)) {
        throw new Error("--phase must be all, profiles, or memories");
      }
      options.phase = phase;
      index += 1;
    } else if (arg === "--only") {
      const slug = args[index + 1];
      if (!slug) throw new Error("--only requires a slug");
      options.only.add(slugify(slug));
      index += 1;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return options;
}

export function shouldRun(
  options: CliOptions,
  slug: string,
  phase: Exclude<Phase, "all">,
): boolean {
  return (options.phase === "all" || options.phase === phase) &&
    (options.only.size === 0 || options.only.has(slugify(slug)));
}

export function mediaContentType(kind: AssetKind): "image/jpeg" | "video/mp4" {
  return kind === "video" ? "video/mp4" : "image/jpeg";
}

export function mediaExtension(kind: AssetKind): "jpg" | "mp4" {
  return kind === "video" ? "mp4" : "jpg";
}

export function demoMediaAssetKey(
  userId: string,
  memoryId: string,
  assetId: string,
  kind: AssetKind,
): string {
  return buildMemoryMediaAssetKey(
    userId,
    memoryId,
    assetId,
    mediaExtension(kind),
  );
}

export function seedanceRequestStateKey(
  userId: string,
  memoryId: string,
  assetId: string,
): string {
  return `${userId}:${memoryId}:${assetId}`;
}

export function buildSeedancePrompt(
  scenePrompt: string,
  referenceCount: number,
): string {
  const mapping = Array.from(
    { length: referenceCount },
    (_, index) =>
      `@Image${
        index + 1
      } is original 2D storybook character artwork of an entirely fictional family member, not a photograph.`,
  ).join(" ");
  return [
    "Render photorealistic five-second vertical candid smartphone footage of entirely fictional people. Translate only broad identity anchors from the original artwork, including approximate age, skin-tone family, hair color and texture, and face shape. Do not copy any real person's likeness. Keep the moment child-safe, natural, imperfect, and unstaged.",
    scenePrompt,
    mapping,
  ].filter(Boolean).join("\n\n");
}

export function seedanceQueueDescriptor(
  requestId: string,
): SeedanceQueueDescriptor {
  const encodedRequestId = encodeURIComponent(requestId);
  return {
    requestId,
    // Seedance is a nested queue endpoint, but FAL exposes status and result
    // routes at the model base rather than below `reference-to-video`.
    statusUrl: `${SEEDANCE_QUEUE_BASE}/requests/${encodedRequestId}/status`,
    responseUrl: `${SEEDANCE_QUEUE_BASE}/requests/${encodedRequestId}`,
  };
}

function persistedFalQueueUrl(value: unknown): string | null {
  if (typeof value !== "string" || value.length === 0) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.hostname !== "queue.fal.run") {
      return null;
    }
    // FAL queue URLs do not require query parameters. Dropping them avoids
    // ever writing a signed or credential-bearing URL into the local state.
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    return null;
  }
}

export function seedanceQueueDescriptorFromSubmission(
  value: unknown,
): SeedanceQueueDescriptor | null {
  if (!value || typeof value !== "object") return null;
  const submission = value as Record<string, unknown>;
  const requestId = typeof submission.request_id === "string"
    ? submission.request_id
    : typeof submission.requestId === "string"
    ? submission.requestId
    : null;
  if (!requestId) return null;
  const derived = seedanceQueueDescriptor(requestId);
  return {
    requestId,
    statusUrl: persistedFalQueueUrl(
      submission.status_url ?? submission.statusUrl,
    ) ?? derived.statusUrl,
    responseUrl: persistedFalQueueUrl(
      submission.response_url ?? submission.responseUrl,
    ) ?? derived.responseUrl,
  };
}

export function seedanceResultFailureMessage(statusCode: number): string {
  return statusCode === 422
    ? "Seedance result was rejected (422, non-retryable)"
    : `Seedance result failed (${statusCode})`;
}

export function parseSeedanceRequestState(value: string): SeedanceRequestState {
  try {
    const parsed = JSON.parse(value) as {
      version?: unknown;
      requests?: unknown;
    };
    if (
      (parsed.version !== 1 && parsed.version !== 2) || !parsed.requests ||
      typeof parsed.requests !== "object"
    ) {
      return { version: 2, requests: {} };
    }
    const requests: Record<string, SeedanceQueueDescriptor> = {};
    for (const [key, request] of Object.entries(parsed.requests)) {
      if (typeof key !== "string") continue;
      const descriptor = typeof request === "string"
        ? request.length > 0 ? seedanceQueueDescriptor(request) : null
        : seedanceQueueDescriptorFromSubmission(request);
      if (descriptor) requests[key] = descriptor;
    }
    return { version: 2, requests };
  } catch {
    return { version: 2, requests: {} };
  }
}

function assertSpec(input: unknown): asserts input is DemoFamilySpec {
  const spec = input as Partial<DemoFamilySpec>;
  if (
    !spec.family?.slug || !spec.family.name || !Array.isArray(spec.members) ||
    !Array.isArray(spec.memories)
  ) {
    throw new Error("demo-family-spec.ts has an invalid shape");
  }
  const memberSlugs = new Set<string>();
  for (const member of spec.members) {
    if (!member.slug || !member.name || !member.profilePhotoPrompt) {
      throw new Error(
        "Every demo member needs slug, name, and profilePhotoPrompt",
      );
    }
    const slug = slugify(member.slug);
    if (memberSlugs.has(slug)) {
      throw new Error(`Duplicate member slug: ${slug}`);
    }
    memberSlugs.add(slug);
  }
  for (const memory of spec.memories) {
    if (
      !memory.slug || !memory.memoryDate ||
      !["text_only", "text_illustration", "media"].includes(memory.type)
    ) {
      throw new Error(
        "Every demo memory needs slug, memoryDate, and a valid type",
      );
    }
    if (
      memory.type === "media" &&
      (!memory.assets || memory.assets.length < 1 || memory.assets.length > 10)
    ) {
      throw new Error(`Media memory ${memory.slug} must have 1 to 10 assets`);
    }
    if (memory.type !== "media" && !memory.caption?.trim()) {
      throw new Error(`Text memory ${memory.slug} needs a caption`);
    }
    if (memory.type === "text_illustration" && (memory.tags?.length ?? 0) > 6) {
      throw new Error(
        `Illustrated memory ${memory.slug} exceeds the six-member tag limit`,
      );
    }
    for (const tag of memory.tags ?? []) {
      if (!memberSlugs.has(slugify(tag))) {
        throw new Error(`Unknown member tag: ${tag}`);
      }
    }
    for (const asset of memory.assets ?? []) {
      const expectedAspect = asset.kind === "video" ? "9:16" : "2:3";
      if (asset.aspectRatio && asset.aspectRatio !== expectedAspect) {
        throw new Error(
          `Asset ${asset.slug} has an incompatible generated aspect ratio`,
        );
      }
    }
  }
}

class DryRunStop extends Error {}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function withRetries<T>(
  operation: () => Promise<T>,
  retries = 2,
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      const status = error instanceof Error
        ? Number(error.message.match(/\((\d{3})\)/)?.[1])
        : Number.NaN;
      const isTransient = error instanceof TypeError ||
        [408, 409, 429].includes(status) || status >= 500;
      if (!isTransient || attempt === retries) break;
      await sleep(1_000 * (attempt + 1));
    }
  }
  throw lastError;
}

function createAdmin(): SupabaseClient {
  return createClient(supabaseUrl(), requireEnv("SUPABASE_SERVICE_ROLE_KEY"), {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

async function findUserByEmail(admin: SupabaseClient, email: string) {
  for (let page = 1; page <= 20; page += 1) {
    const { data, error } = await admin.auth.admin.listUsers({
      page,
      perPage: 1000,
    });
    if (error) {
      throw new Error(`Could not list demo auth user: ${error.message}`);
    }
    const user = data.users.find((candidate) =>
      candidate.email?.toLowerCase() === email
    );
    if (user) return user;
    if (data.users.length < 1000) break;
  }
  return null;
}

async function provisionDemoUser(
  admin: SupabaseClient,
  spec: DemoFamilySpec,
  apply: boolean,
) {
  const existing = await findUserByEmail(admin, DEMO_ACCOUNT_EMAIL);
  if (existing) {
    if (!existing.email_confirmed_at && apply) {
      const { error } = await admin.auth.admin.updateUserById(existing.id, {
        email_confirm: true,
      });
      if (error) {
        throw new Error(`Could not confirm demo auth user: ${error.message}`);
      }
    }
    status("account", "found", existing.id);
    return existing;
  }
  if (!apply) throw new DryRunStop();
  const { data, error } = await admin.auth.admin.createUser({
    email: DEMO_ACCOUNT_EMAIL,
    email_confirm: true,
    user_metadata: {
      name: spec.account?.name ?? "Maya Carter",
      timezone: spec.account?.timezone ?? "America/Los_Angeles",
    },
  });
  if (error || !data.user) {
    throw new Error(
      `Could not create demo auth user: ${error?.message ?? "unknown error"}`,
    );
  }
  status("account", "created", data.user.id);
  return data.user;
}

async function createUserClient(
  admin: SupabaseClient,
  email: string,
): Promise<{ user: SupabaseClient; userId: string }> {
  const { data: linkData, error: linkError } = await admin.auth.admin
    .generateLink({ type: "magiclink", email });
  if (linkError || !linkData.properties?.hashed_token) {
    throw new Error(
      `Could not mint demo session: ${linkError?.message ?? "unknown error"}`,
    );
  }
  const verifier = createClient(supabaseUrl(), supabaseAnonKey(), {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const { data: sessionData, error: sessionError } = await verifier.auth
    .verifyOtp({
      type: "magiclink",
      token_hash: linkData.properties.hashed_token,
    });
  if (sessionError || !sessionData.session || !sessionData.user) {
    throw new Error(
      `Could not verify demo session: ${
        sessionError?.message ?? "unknown error"
      }`,
    );
  }
  return {
    user: createClient(supabaseUrl(), supabaseAnonKey(), {
      global: {
        headers: {
          Authorization: `Bearer ${sessionData.session.access_token}`,
        },
      },
      auth: { autoRefreshToken: false, persistSession: false },
    }),
    userId: sessionData.user.id,
  };
}

async function findOrCreateFamily(
  user: SupabaseClient,
  spec: DemoFamilySpec,
  apply: boolean,
): Promise<string> {
  const { data: memberships, error } = await user
    .from("family_memberships")
    .select("family_id, role, family:families(id, name, deleted_at)")
    .eq("role", "owner");
  if (error) throw new Error(`Could not load demo families: ${error.message}`);
  const existing = ((memberships ?? []) as unknown as OwnedFamilyMembership[])
    .find((membership) => {
      const family = Array.isArray(membership.family)
        ? membership.family[0]
        : membership.family;
      return family?.name === spec.family.name && !family.deleted_at;
    });
  if (existing) return existing.family_id;
  if (!apply) throw new DryRunStop();
  const { data, error: createError } = await user.rpc("create_family", {
    name: spec.family.name,
  });
  if (createError || !data) {
    throw new Error(
      `Could not create demo family: ${
        createError?.message ?? "unknown error"
      }`,
    );
  }
  return (data as { id: string }).id;
}

async function generateImage(
  prompt: string,
  quality: "medium" | "high",
  referenceImages: Uint8Array[] = [],
): Promise<Uint8Array> {
  const apiKey = requireEnv("OPENAI_API_KEY");
  let response: Response;
  if (referenceImages.length === 0) {
    response = await fetch("https://api.openai.com/v1/images/generations", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: IMAGE_MODEL,
        prompt,
        size: "1024x1536",
        quality,
        output_format: "jpeg",
        output_compression: 90,
      }),
    });
  } else {
    const body = new FormData();
    body.append("model", IMAGE_MODEL);
    body.append("prompt", prompt);
    body.append("size", "1024x1536");
    body.append("quality", quality);
    body.append("output_format", "jpeg");
    body.append("output_compression", "90");
    for (const [index, bytes] of referenceImages.entries()) {
      const imageBuffer = bytes.buffer.slice(
        bytes.byteOffset,
        bytes.byteOffset + bytes.byteLength,
      ) as ArrayBuffer;
      body.append(
        "image[]",
        new Blob([imageBuffer], { type: "image/jpeg" }),
        `reference-${index + 1}.jpg`,
      );
    }
    response = await fetch("https://api.openai.com/v1/images/edits", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}` },
      body,
    });
  }
  if (!response.ok) {
    throw new Error(`OpenAI image request failed (${response.status})`);
  }
  const payload = await response.json();
  const base64 = payload.data?.[0]?.b64_json;
  if (typeof base64 !== "string") {
    throw new Error("OpenAI image request returned no image");
  }
  const raw = atob(base64);
  return Uint8Array.from(raw, (character) => character.charCodeAt(0));
}

async function assertGeneratedImage(bytes: Uint8Array): Promise<void> {
  if (bytes.byteLength > MAX_IMAGE_BYTES) {
    throw new Error("Generated image exceeds 20 MB");
  }
  const directory = await Deno.makeTempDir({ prefix: "momora-demo-image-" });
  const input = `${directory}/image.jpg`;
  try {
    await Deno.writeFile(input, bytes);
    const result = await new Deno.Command("sips", {
      args: ["-g", "pixelWidth", "-g", "pixelHeight", input],
    }).output();
    if (!result.success) throw new Error("sips rejected generated image");
    const output = new TextDecoder().decode(result.stdout);
    const width = Number(output.match(/pixelWidth:\s*(\d+)/)?.[1]);
    const height = Number(output.match(/pixelHeight:\s*(\d+)/)?.[1]);
    if (!Number.isFinite(width) || !Number.isFinite(height) || height === 0) {
      throw new Error("Generated image dimensions are unavailable");
    }
    if (
      Math.abs(width / height - GENERATED_IMAGE_ASPECT_RATIO) >
        ASPECT_RATIO_TOLERANCE
    ) {
      throw new Error("Generated image has an unexpected aspect ratio");
    }
  } finally {
    await Deno.remove(directory, { recursive: true }).catch(() => undefined);
  }
}

async function loadSeedanceRequestState(): Promise<SeedanceRequestState> {
  try {
    return parseSeedanceRequestState(
      await Deno.readTextFile(SEEDANCE_STATE_PATH),
    );
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) {
      return { version: 2, requests: {} };
    }
    throw error;
  }
}

async function saveSeedanceRequestState(
  state: SeedanceRequestState,
): Promise<void> {
  const temporaryPath = `${SEEDANCE_STATE_PATH}.${crypto.randomUUID()}.tmp`;
  await Deno.writeTextFile(temporaryPath, JSON.stringify(state));
  await Deno.rename(temporaryPath, SEEDANCE_STATE_PATH);
}

async function clearSeedanceRequest(stateKey: string): Promise<void> {
  const state = await loadSeedanceRequestState();
  if (!(stateKey in state.requests)) return;
  delete state.requests[stateKey];
  await saveSeedanceRequestState(state);
}

async function waitForStatus(
  getStatus: () => Promise<string | null>,
  ready: string,
  failed: string,
  attempts: number,
): Promise<"ready" | "failed"> {
  for (let index = 0; index < attempts; index += 1) {
    const current = await getStatus();
    if (current === ready) return "ready";
    if (current === failed) return "failed";
    await sleep(POLL_INTERVAL_MS);
  }
  throw new Error("Timed out waiting for generation");
}

async function invokeUntilReady(
  getStatus: () => Promise<string | null>,
  invoke: () => Promise<void>,
  attempts: number,
  pollAttempts: number,
): Promise<void> {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const current = await getStatus();
    if (current === "ready") return;
    if (current === "generating") {
      const outcome = await waitForStatus(
        getStatus,
        "ready",
        "failed",
        pollAttempts,
      );
      if (outcome === "ready") return;
      continue;
    }
    await invoke();
    const outcome = await waitForStatus(
      getStatus,
      "ready",
      "failed",
      pollAttempts,
    );
    if (outcome === "ready") return;
  }
  throw new Error(
    "Generation did not reach ready status after bounded retries",
  );
}

function sortMembersTopologically(members: DemoMemberSpec[]): DemoMemberSpec[] {
  const remaining = new Map(
    members.map((member) => [slugify(member.slug), member]),
  );
  for (const member of members) {
    for (const referenceSlug of member.profileReferenceSlugs ?? []) {
      if (!remaining.has(slugify(referenceSlug))) {
        throw new Error(
          `profileReferenceSlugs references an unknown member: ${referenceSlug}`,
        );
      }
    }
  }
  const ordered: DemoMemberSpec[] = [];
  while (remaining.size > 0) {
    const next = [...remaining.values()].find((member) =>
      (member.profileReferenceSlugs ?? []).every((slug) =>
        !remaining.has(slugify(slug))
      )
    );
    if (!next) {
      throw new Error(
        "profileReferenceSlugs contains a cycle or unknown member",
      );
    }
    ordered.push(next);
    remaining.delete(slugify(next.slug));
  }
  return ordered;
}

async function seedProfiles(context: DemoContext): Promise<void> {
  for (const member of sortMembersTopologically(context.spec.members)) {
    const slug = slugify(member.slug);
    if (!shouldRun(context.options, slug, "profiles")) continue;
    const memberId = await deterministicUuid("member", slug);
    const versionId = await deterministicUuid("portrait-version", slug);
    context.memberIds.set(slug, memberId);
    const sourceKey = buildPortraitVersionPhotoKey(
      context.userId,
      memberId,
      versionId,
    );
    context.memberSourceKeys.set(slug, sourceKey);
    if (!context.options.apply) {
      status(slug, "dry_run", memberId);
      continue;
    }

    const { data: existingMember, error: memberError } = await context.user
      .from("family_members").select("id").eq("id", memberId).maybeSingle();
    if (memberError) {
      throw new Error(`Could not load member ${slug}: ${memberError.message}`);
    }
    if (!existingMember) {
      const { error } = await context.user.from("family_members").insert({
        id: memberId,
        user_id: context.userId,
        family_id: context.familyId,
        name: member.name,
        date_of_birth: member.dateOfBirth ?? null,
        gender: member.gender ?? null,
        additional_info: member.additionalInfo ?? null,
        nicknames: member.nicknames ? [...member.nicknames] : null,
        is_user_profile: member.isUserProfile ?? false,
      });
      if (error) {
        throw new Error(`Could not create member ${slug}: ${error.message}`);
      }
      status(slug, "member_created", memberId);
    }

    const { data: version, error: versionError } = await context.user.from(
      "family_member_portrait_versions",
    ).select("id, illustrated_profile_status, profile_picture_key").eq(
      "id",
      versionId,
    ).maybeSingle();
    if (versionError) {
      throw new Error(
        `Could not load portrait version ${slug}: ${versionError.message}`,
      );
    }
    if (!version) {
      let bytes: Uint8Array;
      try {
        bytes = await getObjectBytes(sourceKey);
        status(slug, "source_reused", memberId);
      } catch {
        const referenceBytes = await Promise.all(
          (member.profileReferenceSlugs ?? []).map(async (referenceSlug) => {
            const referenceKey = context.memberSourceKeys.get(
              slugify(referenceSlug),
            );
            if (!referenceKey) {
              throw new Error(`Missing source reference for ${referenceSlug}`);
            }
            return await getObjectBytes(referenceKey);
          }),
        );
        bytes = await withRetries(() =>
          generateImage(
            member.profilePhotoPrompt,
            referenceBytes.length > 0 ? "medium" : "high",
            referenceBytes,
          )
        );
        await putObjectBytes(sourceKey, bytes, "image/jpeg");
      }
      await assertGeneratedImage(bytes);
      const { error } = await context.user.rpc(
        "create_family_member_portrait_version",
        {
          version_id: versionId,
          target_family_member_id: memberId,
          portrait_reference_date: context.spec.family.portraitReferenceDate ??
            "2026-04-18",
          portrait_date_source: "manual",
          source_profile_picture_key: sourceKey,
        },
      );
      if (error) {
        throw new Error(
          `Could not create portrait version ${slug}: ${error.message}`,
        );
      }
      status(slug, "source_ready", memberId);
    }
    const { data: refreshed, error: refreshedError } = await context.user.from(
      "family_member_portrait_versions",
    ).select("illustrated_profile_status").eq("id", versionId).single();
    if (refreshedError) {
      throw new Error(
        `Could not refresh portrait ${slug}: ${refreshedError.message}`,
      );
    }
    if (refreshed.illustrated_profile_status !== "ready") {
      const getPortraitStatus = async () =>
        (await context.user.from("family_member_portrait_versions").select(
          "illustrated_profile_status",
        ).eq("id", versionId).single()).data?.illustrated_profile_status ??
          null;
      await invokeUntilReady(
        getPortraitStatus,
        async () => {
          const { error } = await context.user.functions.invoke(
            "generate-portrait-illustration",
            { body: { portraitVersionId: versionId } },
          );
          if (error) {
            throw new Error(
              `Could not queue portrait ${slug}: ${error.message}`,
            );
          }
        },
        2,
        PORTRAIT_POLL_ATTEMPTS,
      );
    }
    status(slug, "portrait_ready", memberId);
  }
}

async function hydrateVideoReferenceKeys(
  context: DemoContext,
): Promise<void> {
  for (const member of context.spec.members) {
    const slug = slugify(member.slug);
    const versionId = await deterministicUuid("portrait-version", slug);
    const { data, error } = await context.user.from(
      "family_member_portrait_versions",
    ).select("illustrated_profile_key, illustrated_profile_status").eq(
      "id",
      versionId,
    ).maybeSingle();
    if (error) {
      throw new Error(
        `Could not load illustrated video reference ${slug}: ${error.message}`,
      );
    }
    if (
      data?.illustrated_profile_status !== "ready" ||
      !data.illustrated_profile_key
    ) {
      throw new Error(`Missing ready illustrated video reference for ${slug}`);
    }
    context.memberVideoReferenceKeys.set(slug, data.illustrated_profile_key);
  }
}

async function generateSeedanceVideo(
  prompt: string,
  imageUrls: string[],
  endUserId: string,
  stateKey: string,
): Promise<Uint8Array> {
  const mappedPrompt = buildSeedancePrompt(prompt, imageUrls.length);
  const state = await loadSeedanceRequestState();
  let queueDescriptor = state.requests[stateKey];
  if (queueDescriptor) {
    // Persist the v1 string -> v2 descriptor migration before polling, so an
    // interrupted resume continues to use the corrected model-base routes.
    await saveSeedanceRequestState(state);
  } else {
    const response = await fetch(
      SEEDANCE_QUEUE_SUBMISSION_URL,
      {
        method: "POST",
        headers: {
          Authorization: `Key ${requireEnv("FAL_API_KEY")}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          prompt: mappedPrompt,
          image_urls: imageUrls,
          resolution: "720p",
          duration: "5",
          aspect_ratio: "9:16",
          generate_audio: false,
          bitrate_mode: "standard",
          end_user_id: endUserId,
        }),
      },
    );
    if (!response.ok) {
      throw new Error(`Seedance request failed (${response.status})`);
    }
    const submission = await response.json();
    const submittedDescriptor = seedanceQueueDescriptorFromSubmission(
      submission,
    );
    if (!submittedDescriptor) {
      throw new Error("Seedance queue submission returned no request id");
    }
    queueDescriptor = submittedDescriptor;
    state.requests[stateKey] = queueDescriptor;
    await saveSeedanceRequestState(state);
  }
  let payload: { status?: string; video?: { url?: string } } | null = null;
  for (let attempt = 0; attempt < 120; attempt += 1) {
    const statusResponse = await fetch(
      queueDescriptor.statusUrl,
      { headers: { Authorization: `Key ${requireEnv("FAL_API_KEY")}` } },
    );
    if (!statusResponse.ok) {
      throw new Error(`Seedance status failed (${statusResponse.status})`);
    }
    const queueStatus = await statusResponse.json();
    if (queueStatus.status === "COMPLETED") {
      const resultResponse = await fetch(
        queueDescriptor.responseUrl,
        { headers: { Authorization: `Key ${requireEnv("FAL_API_KEY")}` } },
      );
      if (!resultResponse.ok) {
        throw new Error(seedanceResultFailureMessage(resultResponse.status));
      }
      payload = await resultResponse.json();
      break;
    }
    if (queueStatus.status === "FAILED" || queueStatus.status === "CANCELLED") {
      throw new Error("Seedance generation did not complete");
    }
    await sleep(POLL_INTERVAL_MS);
  }
  if (!payload) throw new Error("Seedance generation timed out");
  const outputUrl = payload.video?.url;
  if (typeof outputUrl !== "string") {
    throw new Error("Seedance returned no video URL");
  }
  const output = await fetch(outputUrl);
  if (!output.ok) {
    throw new Error(`Could not download Seedance video (${output.status})`);
  }
  return new Uint8Array(await output.arrayBuffer());
}

async function inspectVideo(
  bytes: Uint8Array,
): Promise<{ durationMs: number; aspectRatio: number; poster: Uint8Array }> {
  const directory = await Deno.makeTempDir({ prefix: "momora-demo-video-" });
  const input = `${directory}/input.mp4`;
  const poster = `${directory}/poster.jpg`;
  try {
    await Deno.writeFile(input, bytes);
    const probe = await new Deno.Command("ffprobe", {
      args: [
        "-v",
        "error",
        "-show_entries",
        "format=duration:stream=width,height",
        "-of",
        "json",
        input,
      ],
    }).output();
    if (!probe.success) throw new Error("ffprobe rejected generated video");
    const data = JSON.parse(
      new TextDecoder().decode(probe.stdout),
    ) as VideoProbeData;
    const duration = Number(data.format?.duration);
    const stream = data.streams?.find((entry) => entry.width && entry.height);
    if (
      bytes.byteLength > MAX_VIDEO_BYTES || !Number.isFinite(duration) ||
      Math.abs(duration - 5) > VIDEO_DURATION_TOLERANCE_SECONDS || !stream
    ) throw new Error("Generated video did not meet duration requirements");
    const aspectRatio = Number(stream.width) / Number(stream.height);
    if (
      !Number.isFinite(aspectRatio) ||
      Math.abs(aspectRatio - 9 / 16) > ASPECT_RATIO_TOLERANCE
    ) {
      throw new Error("Generated video is not vertical");
    }
    const frame = await new Deno.Command("ffmpeg", {
      args: ["-y", "-i", input, "-frames:v", "1", "-q:v", "2", poster],
    }).output();
    if (!frame.success) throw new Error("ffmpeg could not create video poster");
    return {
      durationMs: Math.round(duration * 1000),
      aspectRatio,
      poster: await Deno.readFile(poster),
    };
  } finally {
    await Deno.remove(directory, { recursive: true }).catch(() => undefined);
  }
}

async function createPhotoAsset(
  context: DemoContext,
  memoryId: string,
  asset: DemoAssetSpec,
): Promise<MediaAssetRow> {
  const assetId = await deterministicUuid(`asset:${memoryId}`, asset.slug);
  const key = demoMediaAssetKey(context.userId, memoryId, assetId, "photo");
  let bytes: Uint8Array;
  try {
    bytes = await getObjectBytes(key);
  } catch {
    const refs = await Promise.all(
      (asset.memberSlugs ?? []).map((slug) => {
        const sourceKey = context.memberSourceKeys.get(slugify(slug));
        if (!sourceKey) {
          throw new Error(`Missing media source reference for ${slug}`);
        }
        return getObjectBytes(sourceKey);
      }),
    );
    bytes = await withRetries(() =>
      generateImage(asset.prompt, "medium", refs)
    );
    await putObjectBytes(key, bytes, "image/jpeg");
  }
  await assertGeneratedImage(bytes);
  return { objectKey: key, contentType: "image/jpeg", aspectRatio: 2 / 3 };
}

async function createVideoAsset(
  context: DemoContext,
  memoryId: string,
  asset: DemoAssetSpec,
): Promise<MediaAssetRow> {
  const assetId = await deterministicUuid(`asset:${memoryId}`, asset.slug);
  const key = demoMediaAssetKey(context.userId, memoryId, assetId, "video");
  const requestStateKey = `${
    seedanceRequestStateKey(context.userId, memoryId, assetId)
  }:illustrated-portraits-v1`;
  const referenceKeys = (asset.memberSlugs ?? []).map((slug) => {
    const portraitKey = context.memberVideoReferenceKeys.get(slugify(slug));
    if (!portraitKey) {
      throw new Error(`Missing illustrated video reference for ${slug}`);
    }
    return portraitKey;
  });
  let bytes: Uint8Array;
  try {
    bytes = await getObjectBytes(key);
  } catch {
    const urls = await createPresignedGetUrls(referenceKeys, 3_600);
    bytes = await generateSeedanceVideo(
      asset.prompt,
      referenceKeys.map((referenceKey) => urls[referenceKey]).filter(Boolean),
      context.userId,
      requestStateKey,
    );
    await putObjectBytes(key, bytes, "video/mp4");
    await clearSeedanceRequest(requestStateKey);
  }
  const details = await inspectVideo(bytes);
  const posterId = `${assetId}-preview`;
  const posterKey = demoMediaAssetKey(
    context.userId,
    memoryId,
    posterId,
    "photo",
  );
  try {
    await getObjectBytes(posterKey);
  } catch {
    await putObjectBytes(posterKey, details.poster, "image/jpeg");
  }
  await clearSeedanceRequest(requestStateKey);
  return {
    objectKey: key,
    previewObjectKey: posterKey,
    contentType: "video/mp4",
    durationMs: details.durationMs,
    aspectRatio: details.aspectRatio,
  };
}

async function analyzeEmotionOrThrow(
  user: SupabaseClient,
  memoryId: string,
  slug: string,
): Promise<{ colorPalette?: string }> {
  const { data, error } = await user.functions.invoke<
    { colorPalette?: string }
  >(
    "analyze-emotion",
    { body: { memoryId } },
  );
  if (error) {
    throw new Error(`Could not analyze emotion ${slug}: ${error.message}`);
  }
  return data ?? {};
}

async function seedMemory(
  context: DemoContext,
  memory: DemoMemorySpec,
): Promise<void> {
  const slug = slugify(memory.slug);
  if (!shouldRun(context.options, slug, "memories")) return;
  const memoryId = await deterministicUuid("memory", slug);
  if (!context.options.apply) {
    status(slug, "dry_run", memoryId);
    return;
  }
  const { data: existing, error: existingError } = await context.user.from(
    "memories",
  ).select("id, illustration_status, memory_type, emotion").eq("id", memoryId)
    .maybeSingle();
  if (existingError) {
    throw new Error(`Could not load memory ${slug}: ${existingError.message}`);
  }
  let generatedMediaAssets: MediaAssetRow[] | null = null;
  if (!existing && memory.type === "media") {
    generatedMediaAssets = [];
    for (const asset of memory.assets ?? []) {
      generatedMediaAssets.push(
        asset.kind === "video"
          ? await createVideoAsset(context, memoryId, asset)
          : await createPhotoAsset(context, memoryId, asset),
      );
    }
    if (!generatedMediaAssets[0]) {
      throw new Error(`Media memory ${slug} has no generated cover asset`);
    }
  }
  if (!existing) {
    const { error } = await context.user.from("memories").insert({
      id: memoryId,
      user_id: context.userId,
      family_id: context.familyId,
      content: memory.caption?.trim() || null,
      memory_date: memory.memoryDate,
      memory_type: memory.type,
      illustration_status: memory.type === "text_illustration"
        ? "pending"
        : "none",
      ...(generatedMediaAssets?.[0]
        ? {
          media_key: generatedMediaAssets[0].objectKey,
          media_content_type: generatedMediaAssets[0].contentType,
        }
        : {}),
    });
    if (error) {
      throw new Error(`Could not create memory ${slug}: ${error.message}`);
    }
  }
  const rows = (memory.tags ?? []).map((tag) => ({
    memory_id: memoryId,
    family_member_id: context.memberIds.get(slugify(tag)),
  }));
  if (rows.some((row) => !row.family_member_id)) {
    throw new Error(`Memory ${slug} has unresolved tag`);
  }
  if (rows.length > 0) {
    const { error } = await context.user.from("memory_family_members").upsert(
      rows as Array<{ memory_id: string; family_member_id: string }>,
      { onConflict: "memory_id,family_member_id", ignoreDuplicates: true },
    );
    if (error) {
      throw new Error(`Could not tag memory ${slug}: ${error.message}`);
    }
  }
  if (memory.type === "media") {
    const { data: existingAssets, error: assetsError } = await context.user
      .from("memory_media").select("id").eq("memory_id", memoryId);
    if (assetsError) {
      throw new Error(
        `Could not load media assets ${slug}: ${assetsError.message}`,
      );
    }
    if ((existingAssets?.length ?? 0) === 0) {
      const assets = generatedMediaAssets ?? [];
      if (assets.length === 0) {
        for (const asset of memory.assets ?? []) {
          assets.push(
            asset.kind === "video"
              ? await createVideoAsset(context, memoryId, asset)
              : await createPhotoAsset(context, memoryId, asset),
          );
        }
      }
      const { error } = await context.user.rpc("replace_memory_media_assets", {
        target_memory_id: memoryId,
        assets,
      });
      if (error) {
        throw new Error(`Could not attach media ${slug}: ${error.message}`);
      }
    }
    const { data: mediaEmotionRow, error: mediaEmotionError } = await context
      .user
      .from("memories").select("emotion").eq("id", memoryId).single();
    if (mediaEmotionError) {
      throw new Error(
        `Could not check media emotion ${slug}: ${mediaEmotionError.message}`,
      );
    }
    const hasPhoto = (memory.assets ?? []).some((asset) =>
      asset.kind === "photo"
    );
    if (hasPhoto && !mediaEmotionRow.emotion) {
      await analyzeEmotionOrThrow(context.user, memoryId, slug);
    }
  } else if (memory.type === "text_illustration") {
    const { data: current, error } = await context.user.from("memories").select(
      "illustration_status",
    ).eq("id", memoryId).single();
    if (error) {
      throw new Error(`Could not check illustration ${slug}: ${error.message}`);
    }
    if (current.illustration_status !== "ready") {
      const emotionData = await analyzeEmotionOrThrow(
        context.user,
        memoryId,
        slug,
      );
      const getIllustrationStatus = async () =>
        (await context.user.from("memories").select("illustration_status").eq(
          "id",
          memoryId,
        ).single()).data?.illustration_status ?? null;
      await invokeUntilReady(
        getIllustrationStatus,
        async () => {
          const { error: invokeError } = await context.user.functions.invoke(
            "generate-illustration",
            {
              body: {
                memoryId,
                ...(emotionData?.colorPalette
                  ? { colorPalette: emotionData.colorPalette }
                  : {}),
              },
            },
          );
          if (invokeError) {
            throw new Error(
              `Could not queue illustration ${slug}: ${invokeError.message}`,
            );
          }
        },
        2,
        ILLUSTRATION_POLL_ATTEMPTS,
      );
    }
  } else {
    const { data: textEmotionRow, error: textEmotionError } = await context.user
      .from("memories").select("emotion").eq("id", memoryId).single();
    if (textEmotionError) {
      throw new Error(
        `Could not check text emotion ${slug}: ${textEmotionError.message}`,
      );
    }
    if (!textEmotionRow.emotion) {
      await analyzeEmotionOrThrow(context.user, memoryId, slug);
    }
  }
  status(slug, "ready", memoryId);
}

function assertFixtureContract(spec: DemoFamilySpec): void {
  const illustrated = spec.memories.filter((memory) =>
    memory.type === "text_illustration"
  );
  const media = spec.memories.filter((memory) => memory.type === "media");
  if (
    spec.members.length !== 8 || spec.memories.length !== 20 ||
    illustrated.length !== 5 || media.length !== 10
  ) {
    throw new Error(
      "Demo family spec no longer matches the required screenshot-fixture contract",
    );
  }
}

async function verifyFixture(context: DemoContext): Promise<void> {
  assertFixtureContract(context.spec);
  const expectedMemberIds = await Promise.all(
    context.spec.members.map((member) =>
      deterministicUuid("member", member.slug)
    ),
  );
  const { data: members, error: membersError } = await context.user.from(
    "family_members",
  ).select("id").eq("family_id", context.familyId);
  if (
    membersError || (members ?? []).length !== expectedMemberIds.length ||
    !(members ?? []).every((member) => expectedMemberIds.includes(member.id))
  ) {
    throw new Error("Family-member fixture is incomplete");
  }
  const { data: versions, error: versionsError } = await context.user.from(
    "family_member_portrait_versions",
  ).select("family_member_id, illustrated_profile_status").eq(
    "family_id",
    context.familyId,
  );
  if (versionsError) {
    throw new Error(
      `Could not verify portrait fixture: ${versionsError.message}`,
    );
  }
  if (
    (versions ?? []).length !== expectedMemberIds.length ||
    !(versions ?? []).every((version) =>
      expectedMemberIds.includes(version.family_member_id) &&
      version.illustrated_profile_status === "ready"
    )
  ) {
    throw new Error("Portrait fixture is incomplete");
  }

  const expectedMemoryIds = await Promise.all(
    context.spec.memories.map((memory) =>
      deterministicUuid("memory", memory.slug)
    ),
  );
  const { data: memories, error: memoriesError } = await context.user.from(
    "memories",
  ).select(
    "id, memory_type, illustration_status, media_key, media_content_type, emotion",
  ).eq("family_id", context.familyId);
  if (memoriesError) {
    throw new Error(
      `Could not verify memory fixture: ${memoriesError.message}`,
    );
  }
  if (
    (memories ?? []).length !== expectedMemoryIds.length ||
    !(memories ?? []).every((memory) => expectedMemoryIds.includes(memory.id))
  ) {
    throw new Error(
      "Memory fixture does not contain exactly the deterministic demo memories",
    );
  }
  const memoriesById = new Map(
    (memories ?? []).map((memory) => [memory.id, memory]),
  );
  for (const memorySpec of context.spec.memories) {
    const memoryId = await deterministicUuid("memory", memorySpec.slug);
    const memory = memoriesById.get(memoryId);
    if (!memory || memory.memory_type !== memorySpec.type) {
      throw new Error("Memory type verification failed");
    }
    if (
      memorySpec.type === "text_illustration" &&
      memory.illustration_status !== "ready"
    ) {
      throw new Error("Illustrated memory is not ready");
    }
    const needsEmotion = memorySpec.type === "text_only" ||
      (memorySpec.type === "media" &&
        (memorySpec.assets ?? []).some((asset) => asset.kind === "photo"));
    if (needsEmotion && !memory.emotion) {
      throw new Error("Memory emotion is missing");
    }
    if (memorySpec.type !== "media") continue;
    const { data: assets, error: assetsError } = await context.user.from(
      "memory_media",
    )
      .select(
        "position, object_key, preview_object_key, content_type, duration_ms, aspect_ratio",
      )
      .eq("memory_id", memoryId)
      .order("position", { ascending: true });
    if (
      assetsError || (assets ?? []).length !== (memorySpec.assets?.length ?? 0)
    ) {
      throw new Error("Media asset verification failed");
    }
    for (const [position, assetSpec] of (memorySpec.assets ?? []).entries()) {
      const asset = assets?.[position];
      const assetId = await deterministicUuid(
        `asset:${memoryId}`,
        assetSpec.slug,
      );
      const expectedKey = demoMediaAssetKey(
        context.userId,
        memoryId,
        assetId,
        assetSpec.kind,
      );
      if (
        !asset || asset.position !== position ||
        asset.object_key !== expectedKey ||
        asset.content_type !== mediaContentType(assetSpec.kind)
      ) {
        throw new Error(
          "Media asset ordering or content type verification failed",
        );
      }
      const expectedRatio = assetSpec.kind === "video"
        ? 9 / 16
        : GENERATED_IMAGE_ASPECT_RATIO;
      if (
        asset.aspect_ratio === null ||
        Math.abs(asset.aspect_ratio - expectedRatio) > ASPECT_RATIO_TOLERANCE
      ) {
        throw new Error("Media asset aspect ratio verification failed");
      }
      if (
        assetSpec.kind === "video" &&
        (!asset.duration_ms ||
          Math.abs(asset.duration_ms - 5_000) >
            VIDEO_DURATION_TOLERANCE_SECONDS * 1_000 ||
          !asset.preview_object_key)
      ) {
        throw new Error("Video asset verification failed");
      }
      if (
        position === 0 &&
        (memory.media_key !== asset.object_key ||
          memory.media_content_type !== asset.content_type)
      ) {
        throw new Error("Media cover does not mirror position zero");
      }
    }
  }
  status("fixture", "verified");
}

async function run(): Promise<void> {
  const options = parseArgs(Deno.args);
  assertSpec(DEMO_FAMILY_SPEC);
  const spec = DEMO_FAMILY_SPEC as DemoFamilySpec;
  assertFixtureContract(spec);
  if (!options.apply) {
    status("seed-demo-account", "dry_run");
    for (const member of spec.members) {
      if (shouldRun(options, member.slug, "profiles")) {
        status(slugify(member.slug), "would_seed");
      }
    }
    for (const memory of spec.memories) {
      if (shouldRun(options, memory.slug, "memories")) {
        status(slugify(memory.slug), "would_seed");
      }
    }
    return;
  }
  const admin = createAdmin();
  await provisionDemoUser(admin, spec, true);
  const session = await createUserClient(admin, DEMO_ACCOUNT_EMAIL);
  const familyId = await findOrCreateFamily(session.user, spec, true);
  const { error: profileError } = await session.user.from("user_profiles")
    .update({
      name: spec.account?.name ?? "Maya Carter",
      timezone: spec.account?.timezone ?? "Europe/Lisbon",
      has_completed_onboarding: true,
    })
    .eq("id", session.userId);
  if (profileError) {
    throw new Error(
      `Could not prepare demo account profile: ${profileError.message}`,
    );
  }
  const context: DemoContext = {
    admin,
    user: session.user,
    userId: session.userId,
    familyId,
    spec,
    options,
    memberIds: new Map(),
    memberSourceKeys: new Map(),
    memberVideoReferenceKeys: new Map(),
  };
  // Fill IDs before any filtered phase so memory-only runs can resolve references.
  for (const member of spec.members) {
    const slug = slugify(member.slug);
    context.memberIds.set(slug, await deterministicUuid("member", slug));
    context.memberSourceKeys.set(
      slug,
      buildPortraitVersionPhotoKey(
        session.userId,
        context.memberIds.get(slug)!,
        await deterministicUuid("portrait-version", slug),
      ),
    );
  }
  if (options.phase === "all" || options.phase === "profiles") {
    await seedProfiles(context);
  }
  if (options.phase === "all" || options.phase === "memories") {
    await hydrateVideoReferenceKeys(context);
    for (const memory of spec.memories) {
      await seedMemory(context, memory);
    }
  }
  if (options.phase === "all" && options.only.size === 0) {
    await verifyFixture(context);
  } else {
    status("fixture", "partial_verified");
  }
}

if (import.meta.main) {
  run().catch((error) => {
    if (error instanceof DryRunStop) return;
    console.error(
      JSON.stringify({
        state: "failed",
        error: error instanceof Error ? error.message : "unknown",
      }),
    );
    Deno.exit(1);
  });
}
