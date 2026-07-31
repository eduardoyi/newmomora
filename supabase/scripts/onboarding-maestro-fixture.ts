/**
 * Local-only support for the staged Maestro onboarding journeys.
 *
 * The mobile app sends the OTP during the journey, so a shell runner uses
 * this script between Maestro stages to read the code from local Mailpit.
 * It intentionally refuses every non-loopback endpoint and only cleans up
 * synthetic @example.test users with this script's exact run-id prefix. An
 * owner that generated images is deleted through the normal account-deletion
 * function, which fences active workflows and removes R2 bytes first.
 */

const OWNER_ROLE = "owner";
const FIXTURE_DOMAIN = "example.test";
const DEFAULT_MAILPIT_URL = "http://127.0.0.1:54324";
const OTP_PATTERN = /(?<!\d)(\d{6})(?!\d)/;
const RUN_ID_PATTERN = /^[a-z0-9][a-z0-9-]{5,63}$/;

type FixtureRole = "owner" | "joiner";

interface FixtureIdentity {
  email: string;
  role: FixtureRole;
}

interface MailpitMessageSummary {
  ID?: string;
  id?: string;
  To?: unknown;
  to?: unknown;
}

interface MailpitMessagesResponse {
  messages?: MailpitMessageSummary[];
}

function requiredEnv(name: string): string {
  const value = Deno.env.get(name)?.trim();
  if (!value) {
    throw new Error(
      `Missing ${name}. This local-only harness will not guess a credential.`,
    );
  }
  return value;
}

export function isLoopbackHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" && Boolean(url.port) &&
      ["127.0.0.1", "::1", "[::1]"].includes(url.hostname);
  } catch {
    return false;
  }
}

function requireLoopbackUrl(name: string, value: string): URL {
  if (!isLoopbackHttpUrl(value)) {
    throw new Error(
      `${name} must be an explicit http:// loopback URL with a port; refusing to access ${
        value || "an empty endpoint"
      }.`,
    );
  }
  return new URL(value);
}

export function resolveLocalSupabaseUrl(
  serviceUrl: string | undefined,
  appUrl: string | undefined,
): URL {
  const localServiceUrl = serviceUrl?.trim()
    ? requireLoopbackUrl("SUPABASE_URL", serviceUrl)
    : null;
  const localAppUrl = appUrl?.trim()
    ? requireLoopbackUrl("EXPO_PUBLIC_SUPABASE_URL", appUrl)
    : null;

  if (!localServiceUrl && !localAppUrl) {
    throw new Error(
      "SUPABASE_URL or EXPO_PUBLIC_SUPABASE_URL must be set to the local Supabase URL.",
    );
  }

  // The runner uses SUPABASE_URL for its privileged fixture cleanup while
  // the development client uses EXPO_PUBLIC_SUPABASE_URL. Checking both
  // avoids a deceptive setup where the runner is local but the app writes
  // fixture data to a hosted project.
  if (
    localServiceUrl && localAppUrl &&
    localServiceUrl.origin !== localAppUrl.origin
  ) {
    throw new Error(
      "SUPABASE_URL and EXPO_PUBLIC_SUPABASE_URL must point to the same local Supabase project.",
    );
  }

  return localServiceUrl ?? localAppUrl!;
}

function getSupabaseUrl(): URL {
  return resolveLocalSupabaseUrl(
    Deno.env.get("SUPABASE_URL"),
    Deno.env.get("EXPO_PUBLIC_SUPABASE_URL"),
  );
}

function getMailpitUrl(): URL {
  return requireLoopbackUrl(
    "MAILPIT_URL",
    Deno.env.get("MAILPIT_URL") ?? DEFAULT_MAILPIT_URL,
  );
}

interface LocalImageStack {
  cronSecret: string;
  hardDeleteUrl: URL;
}

/**
 * Image generation may call a real provider, but every system that stores or
 * dispatches fixture data must be explicitly local. This is deliberately
 * redundant with the shell runner: calling this script directly must remain
 * just as safe.
 */
function requireIsolatedLocalImageStack(): LocalImageStack {
  if (Deno.env.get("ONBOARDING_E2E_IMAGE_STACK") !== "isolated-local") {
    throw new Error(
      "Set ONBOARDING_E2E_IMAGE_STACK=isolated-local; refusing to generate fixture images against an unverified stack.",
    );
  }

  requireLoopbackUrl("R2_ENDPOINT", requiredEnv("R2_ENDPOINT"));
  requireLoopbackUrl(
    "CLOUDFLARE_ILLUSTRATION_WORKFLOW_URL",
    requiredEnv("CLOUDFLARE_ILLUSTRATION_WORKFLOW_URL"),
  );
  requireLoopbackUrl(
    "CLOUDFLARE_PORTRAIT_WORKFLOW_URL",
    requiredEnv("CLOUDFLARE_PORTRAIT_WORKFLOW_URL"),
  );
  if (requiredEnv("MEMORY_ILLUSTRATION_BACKEND") !== "cloudflare") {
    throw new Error(
      "MEMORY_ILLUSTRATION_BACKEND must be cloudflare for this Worker E2E run.",
    );
  }
  if (requiredEnv("PORTRAIT_GENERATION_BACKEND") !== "cloudflare") {
    throw new Error(
      "PORTRAIT_GENERATION_BACKEND must be cloudflare for this Worker E2E run.",
    );
  }

  const hardDeleteUrl = new URL(
    "/functions/v1/hard-delete-expired-accounts",
    getSupabaseUrl(),
  );
  // This is derived from the already-validated local Supabase origin, but
  // keep the guard close to the destructive request as a future-proof check.
  requireLoopbackUrl("hard-delete-expired-accounts", hardDeleteUrl.toString());

  return { cronSecret: requiredEnv("CRON_SECRET"), hardDeleteUrl };
}

function getRunId(args: string[]): string {
  const index = args.indexOf("--run-id");
  const runId = index === -1 ? undefined : args[index + 1];
  if (!runId || !RUN_ID_PATTERN.test(runId)) {
    throw new Error(
      "--run-id must be 6-64 lowercase letters, digits, or hyphens (and start with a letter or digit).",
    );
  }
  return runId;
}

export function fixtureEmail(runId: string, role: FixtureRole): string {
  if (!RUN_ID_PATTERN.test(runId)) throw new Error("Invalid fixture run id.");
  return `maestro-onb-${runId}-${role}@${FIXTURE_DOMAIN}`;
}

function fixtureIdentities(runId: string): FixtureIdentity[] {
  return ["owner", "joiner"].map((role) => ({
    role: role as FixtureRole,
    email: fixtureEmail(runId, role as FixtureRole),
  }));
}

function requireServiceRoleKey(): string {
  return requiredEnv("SUPABASE_SERVICE_ROLE_KEY");
}

function apiHeaders(serviceRoleKey: string): HeadersInit {
  return {
    apikey: serviceRoleKey,
    Authorization: `Bearer ${serviceRoleKey}`,
    "Content-Type": "application/json",
  };
}

async function fetchJson<T>(url: URL | string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  if (!response.ok) {
    throw new Error(
      `Local request failed (${response.status}) at ${response.url}.`,
    );
  }
  return await response.json() as T;
}

function hasFixtureEmail(value: unknown, email: string): boolean {
  return JSON.stringify(value).toLowerCase().includes(email.toLowerCase());
}

function messageId(message: MailpitMessageSummary): string | null {
  const candidate = message.ID ?? message.id;
  return typeof candidate === "string" && candidate.length > 0
    ? candidate
    : null;
}

export function extractOtp(value: unknown): string | null {
  const match = JSON.stringify(value).match(OTP_PATTERN);
  return match?.[1] ?? null;
}

async function getMailpitMessages(
  mailpitUrl: URL,
): Promise<MailpitMessageSummary[]> {
  const url = new URL("/api/v1/messages?limit=100", mailpitUrl);
  const payload = await fetchJson<MailpitMessagesResponse>(url);
  return payload.messages ?? [];
}

async function getOtp(email: string): Promise<string> {
  const mailpitUrl = getMailpitUrl();
  const maximumAttempts = 80;

  for (let attempt = 0; attempt < maximumAttempts; attempt += 1) {
    const candidates = (await getMailpitMessages(mailpitUrl)).filter((
      message,
    ) => hasFixtureEmail(message.To ?? message.to ?? message, email));

    for (const candidate of candidates) {
      const id = messageId(candidate);
      if (!id) continue;
      const message = await fetchJson<unknown>(
        new URL(`/api/v1/message/${encodeURIComponent(id)}`, mailpitUrl),
      );
      const otp = extractOtp(message);
      if (otp) return otp;
    }

    await new Promise((resolve) => setTimeout(resolve, 500));
  }

  throw new Error(
    `No local Mailpit OTP arrived for ${email} within 40 seconds.`,
  );
}

interface AuthUser {
  id: string;
  email?: string | null;
}

interface AuthUsersResponse {
  users?: AuthUser[];
}

async function findAuthUserId(
  supabaseUrl: URL,
  serviceRoleKey: string,
  email: string,
): Promise<string | null> {
  const url = new URL("/auth/v1/admin/users?page=1&per_page=1000", supabaseUrl);
  const payload = await fetchJson<AuthUsersResponse>(url, {
    headers: apiHeaders(serviceRoleKey),
  });
  return payload.users?.find((user) =>
    user.email?.toLowerCase() === email.toLowerCase()
  )?.id ?? null;
}

async function getPendingInviteCode(ownerEmail: string): Promise<string> {
  const supabaseUrl = getSupabaseUrl();
  const serviceRoleKey = requireServiceRoleKey();
  const ownerId = await findAuthUserId(supabaseUrl, serviceRoleKey, ownerEmail);
  if (!ownerId) {
    throw new Error(
      "Could not find the local owner fixture after the owner journey.",
    );
  }

  const headers = apiHeaders(serviceRoleKey);
  const familiesUrl = new URL(
    `/rest/v1/families?select=id&owner_id=eq.${
      encodeURIComponent(ownerId)
    }&deleted_at=is.null&limit=2`,
    supabaseUrl,
  );
  const families = await fetchJson<Array<{ id: string }>>(familiesUrl, {
    headers,
  });
  if (families.length !== 1) {
    throw new Error(
      "Expected exactly one active local family owned by the fixture user.",
    );
  }

  const invitesUrl = new URL(
    `/rest/v1/family_invites?select=code&family_id=eq.${
      encodeURIComponent(families[0].id)
    }&invited_by=eq.${
      encodeURIComponent(ownerId)
    }&role=eq.viewer&status=eq.pending&order=created_at.desc&limit=1`,
    supabaseUrl,
  );
  const invites = await fetchJson<Array<{ code: string }>>(invitesUrl, {
    headers,
  });
  if (invites.length !== 1 || !/^[a-z]+-[a-z]+-[a-z]+$/.test(invites[0].code)) {
    throw new Error(
      "Expected the owner Maestro stage to create one pending local viewer invite.",
    );
  }
  return invites[0].code;
}

interface FamilyRow {
  id: string;
}

async function getOwnerFamilyId(
  supabaseUrl: URL,
  serviceRoleKey: string,
  ownerId: string,
): Promise<string | null> {
  const familiesUrl = new URL(
    `/rest/v1/families?select=id&owner_id=eq.${
      encodeURIComponent(ownerId)
    }&limit=2`,
    supabaseUrl,
  );
  const families = await fetchJson<FamilyRow[]>(familiesUrl, {
    headers: apiHeaders(serviceRoleKey),
  });
  if (families.length > 1) {
    throw new Error("Fixture owner unexpectedly owns more than one family.");
  }
  return families[0]?.id ?? null;
}

interface GenerationJob {
  id: string;
}

async function listActiveGenerationJobs(
  supabaseUrl: URL,
  serviceRoleKey: string,
  table: "memory_illustration_jobs" | "portrait_generation_jobs",
  familyId: string,
): Promise<GenerationJob[]> {
  const url = new URL(`/rest/v1/${table}`, supabaseUrl);
  url.searchParams.set("select", "id");
  url.searchParams.set("family_id", `eq.${familyId}`);
  url.searchParams.set("status", "in.(queued,running)");
  url.searchParams.set("limit", "1");
  return await fetchJson<GenerationJob[]>(url, {
    headers: apiHeaders(serviceRoleKey),
  });
}

async function waitForOwnerGenerationToSettle(
  supabaseUrl: URL,
  serviceRoleKey: string,
  ownerId: string,
): Promise<void> {
  const familyId = await getOwnerFamilyId(supabaseUrl, serviceRoleKey, ownerId);
  if (!familyId) return;

  const maximumAttempts = 180;
  for (let attempt = 0; attempt < maximumAttempts; attempt += 1) {
    const [memoryJobs, portraitJobs] = await Promise.all([
      listActiveGenerationJobs(
        supabaseUrl,
        serviceRoleKey,
        "memory_illustration_jobs",
        familyId,
      ),
      listActiveGenerationJobs(
        supabaseUrl,
        serviceRoleKey,
        "portrait_generation_jobs",
        familyId,
      ),
    ]);
    if (memoryJobs.length === 0 && portraitJobs.length === 0) return;
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }

  throw new Error(
    "Fixture generation is still active after six minutes; refusing owner deletion so a late workflow cannot strand storage.",
  );
}

interface HardDeleteResponse {
  deletedCount: number;
  success: true;
}

/**
 * The cron-shaped hard-delete endpoint processes every due profile. Refuse a
 * shared or stale local database before scheduling this run's owner so the
 * fixture cannot clean up an unrelated account as a side effect.
 */
async function assertNoOtherDueHardDeletes(
  supabaseUrl: URL,
  serviceRoleKey: string,
): Promise<void> {
  const url = new URL("/rest/v1/user_profiles", supabaseUrl);
  url.searchParams.set("select", "id");
  url.searchParams.set(
    "scheduled_hard_delete_at",
    `lte.${new Date().toISOString()}`,
  );
  url.searchParams.set("limit", "1");
  const dueProfiles = await fetchJson<Array<{ id: string }>>(url, {
    headers: apiHeaders(serviceRoleKey),
  });
  if (dueProfiles.length > 0) {
    throw new Error(
      "The local database already has a due hard-delete profile; reset or isolate it before running this fixture.",
    );
  }
}

export async function hardDeleteOwnerFixture(
  supabaseUrl: URL,
  serviceRoleKey: string,
  ownerId: string,
  ownerEmail: string,
): Promise<void> {
  const imageStack = requireIsolatedLocalImageStack();
  await waitForOwnerGenerationToSettle(supabaseUrl, serviceRoleKey, ownerId);
  await assertNoOtherDueHardDeletes(supabaseUrl, serviceRoleKey);

  const scheduleUrl = new URL(
    "/rest/v1/rpc/schedule_account_deletion",
    supabaseUrl,
  );
  await fetchJson<string>(scheduleUrl, {
    method: "POST",
    headers: apiHeaders(serviceRoleKey),
    body: JSON.stringify({
      p_operation_token: crypto.randomUUID(),
      p_owner_id: ownerId,
      p_scheduled_hard_delete_at: new Date(Date.now() - 1000).toISOString(),
    }),
  });

  const response = await fetch(imageStack.hardDeleteUrl, {
    method: "POST",
    headers: { "x-cron-secret": imageStack.cronSecret },
  });
  if (!response.ok) {
    throw new Error(
      `Local hard-delete fixture cleanup failed (${response.status}).`,
    );
  }
  const result = await response.json() as HardDeleteResponse;
  if (!result.success || result.deletedCount !== 1) {
    throw new Error(
      "Local hard-delete did not remove exactly one owner fixture; refusing direct Auth deletion.",
    );
  }

  const survivingOwner = await findAuthUserId(
    supabaseUrl,
    serviceRoleKey,
    ownerEmail,
  );
  if (survivingOwner) {
    throw new Error(
      "Owner fixture still exists after local hard-delete cleanup.",
    );
  }
}

async function deleteFixtureMail(
  mailpitUrl: URL,
  identities: FixtureIdentity[],
): Promise<void> {
  const emails = new Set(
    identities.map((identity) => identity.email.toLowerCase()),
  );
  const ids = (await getMailpitMessages(mailpitUrl))
    .filter((message) =>
      [...emails].some((email) =>
        hasFixtureEmail(message.To ?? message.to ?? message, email)
      )
    )
    .map(messageId)
    .filter((id): id is string => Boolean(id));

  if (ids.length === 0) return;
  const response = await fetch(new URL("/api/v1/messages", mailpitUrl), {
    method: "DELETE",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ IDs: ids }),
  });
  if (!response.ok) {
    throw new Error(
      `Could not remove local fixture email (${response.status}).`,
    );
  }
}

async function deleteAuthFixture(
  supabaseUrl: URL,
  serviceRoleKey: string,
  identity: FixtureIdentity,
): Promise<void> {
  const userId = await findAuthUserId(
    supabaseUrl,
    serviceRoleKey,
    identity.email,
  );
  if (!userId) return;

  const response = await fetch(
    new URL(
      `/auth/v1/admin/users/${encodeURIComponent(userId)}`,
      supabaseUrl,
    ),
    {
      method: "DELETE",
      headers: apiHeaders(serviceRoleKey),
    },
  );
  if (!response.ok && response.status !== 404) {
    throw new Error(
      `Could not remove local ${identity.role} fixture user (${response.status}).`,
    );
  }
}

async function cleanup(runId: string): Promise<void> {
  const supabaseUrl = getSupabaseUrl();
  const mailpitUrl = getMailpitUrl();
  const serviceRoleKey = requireServiceRoleKey();
  const identities = fixtureIdentities(runId);

  const owner = identities.find((identity) => identity.role === "owner");
  const joiner = identities.find((identity) => identity.role === "joiner");
  if (!owner || !joiner) throw new Error("Fixture identities are incomplete.");

  // The joiner never owns family storage in this journey. The owner does: use
  // the application’s deletion-fence/R2 cleanup rather than deleting its Auth
  // row directly. If onboarding failed before a family existed, no image work
  // could have started, so direct removal remains safe.
  await deleteAuthFixture(supabaseUrl, serviceRoleKey, joiner);
  const ownerId = await findAuthUserId(
    supabaseUrl,
    serviceRoleKey,
    owner.email,
  );
  if (ownerId) {
    const familyId = await getOwnerFamilyId(
      supabaseUrl,
      serviceRoleKey,
      ownerId,
    );
    if (familyId) {
      await hardDeleteOwnerFixture(
        supabaseUrl,
        serviceRoleKey,
        ownerId,
        owner.email,
      );
    } else {
      await deleteAuthFixture(supabaseUrl, serviceRoleKey, owner);
    }
  }

  await deleteFixtureMail(mailpitUrl, identities);
}

function printSetup(runId: string): void {
  // Plain KEY=VALUE lines let the shell runner parse the values without eval.
  console.log(`RUN_ID=${runId}`);
  console.log(`OWNER_EMAIL=${fixtureEmail(runId, "owner")}`);
  console.log(`JOINER_EMAIL=${fixtureEmail(runId, "joiner")}`);
}

function usage(): never {
  throw new Error(
    "Usage: onboarding-maestro-fixture.ts setup --run-id <id> | otp --email <fixture email> | invite --owner-email <fixture email> | cleanup --run-id <id>",
  );
}

if (import.meta.main) {
  const [command] = Deno.args;

  switch (command) {
    case "setup": {
      getSupabaseUrl();
      getMailpitUrl();
      requireServiceRoleKey();
      requireIsolatedLocalImageStack();
      printSetup(getRunId(Deno.args));
      break;
    }
    case "otp": {
      getSupabaseUrl();
      const index = Deno.args.indexOf("--email");
      const email = index === -1 ? undefined : Deno.args[index + 1];
      if (
        !email?.endsWith(`@${FIXTURE_DOMAIN}`) ||
        !email.startsWith("maestro-onb-")
      ) {
        throw new Error(
          "otp accepts only this harness's synthetic @example.test email address.",
        );
      }
      console.log(await getOtp(email));
      break;
    }
    case "invite": {
      const index = Deno.args.indexOf("--owner-email");
      const ownerEmail = index === -1 ? undefined : Deno.args[index + 1];
      if (
        !ownerEmail?.endsWith(`-owner@${FIXTURE_DOMAIN}`) ||
        !ownerEmail.startsWith("maestro-onb-")
      ) {
        throw new Error(
          "invite accepts only this harness's synthetic owner email address.",
        );
      }
      console.log(await getPendingInviteCode(ownerEmail));
      break;
    }
    case "cleanup":
      await cleanup(getRunId(Deno.args));
      break;
    default:
      usage();
  }
}

export { OWNER_ROLE };
