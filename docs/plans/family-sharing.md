# Family Sharing — Implementation Plan

**Status:** planned · **Branch:** `family-sharing` (single branch, phase-per-commit checkpoints)
**Decision record:** agreed 2026-07-10 (see §2). App is pre-production (single user) — clean breaking cutover, no backward compatibility required.

---

## 1. Goal

Let a family share one memory journal. Three roles (owner / manager / viewer), word-code invites with inviter approval, email-OTP auth for everyone, per-family tenancy across DB, RLS, storage, Edge Functions, and client.

## 2. Decision record (summary)

| Area | Decision |
|---|---|
| Tenancy | Many-to-many (`family_memberships`); per-user active family; picker in Settings only if >1 membership |
| Roles | **owner**: 1/family, billing later, family dies with owner (no transfer). **manager**: full CRUD on all memories + children; add/remove/demote managers & viewers (never owner); manage invites. **viewer**: read-only timeline/calendar/children; minimal Settings; read-only member list; no invites visible |
| Attribution | `created_by` semantics on memories; "Added by X" in UI; content survives member removal/deletion |
| Invites | 3 dash-separated curated words, single-use, 7-day expiry, carries role (manager/viewer only). Redeem → pending approval. Any manager/owner approves; inviter gets the push. Approver sees name + email. Approved member gets push + email. Revoke/reshare from pending-invites screen |
| Delivery | Share sheet, two-step message. Universal links prefill the code from day one |
| Auth | Everyone on email OTP; passwords removed from UX (kept as `__DEV__`-only path for Maestro). SMTP via Bento relay |
| Storage | R2 keys stay `{userId}/...`; authorization becomes "member of the owning family" |
| Migration | Auto-create one family per existing user as owner |
| Limits | Max 50 members/family. No quotas now, but track generation with `family_id` |
| Sharing semantics | No private memories. One `illustration_style` per family (owner+manager editable). Notification prefs per-user. New-memory push to all members (debounced) |
| Lifecycle | Non-owners can leave. Removed users see graceful lockout + "no families" state. Owner soft-delete hides family immediately (restorable), members notified |

## 3. Architecture overview

New tables: `families`, `family_memberships`, `family_invites`, `invite_code_words`, `invite_redemption_attempts`, `family_activity_log` (push debounce). Ownership columns: `memories.family_id`, `family_members.family_id`. Existing `user_id` columns are reinterpreted as **creator** (attribution), become nullable with `on delete set null`.

RLS pivots from `auth.uid() = user_id` to helper functions (`security definer`, `stable`, `set search_path = public`):

- `is_family_member(fam uuid) → boolean`
- `has_family_role(fam uuid, roles text[]) → boolean`

(Cross-member profile reads go through `get_family_member_profiles` — see §6 — not through a widened `user_profiles` policy.)

Invite lifecycle: `pending → redeemed → approved | rejected`, plus `revoked`, `expired` (computed from `expires_at`; a sweep is not required — all reads filter on it).

```
create invite (RPC, manager+) ──share sheet──▶ grandma installs app
  ▶ OTP signup (name+email) ▶ enters code (or prefilled via universal link)
  ▶ redeem-family-invite EF: rate-limit, mark redeemed, push to inviter
  ▶ waiting screen  ◀─ approver sees name+email ─ resolve-family-invite EF
  ▶ approved: membership row created, active family set, push + Bento email
```

## 4. Phase 0 — external prerequisites (Eduardo, can run in parallel)

- [ ] Move `usemomora.com` DNS to Cloudflare; migrate hosting GitHub Pages → Cloudflare Pages (repo `momora-marketing` already builds a static `dist/`)
- [ ] Bento: transactional plan; register From address as an author; collect site UUID + publishable + secret keys
- [ ] Supabase dashboard: custom SMTP → `yubin.sentbybento.com:587` STARTTLS, username = site UUID, password = `publishable:secret`
- [ ] Supabase Auth: set the **Magic Link / OTP email template to include `{{ .Token }}`** (default sends a link, not a code); set OTP expiry to 10 min
- [ ] Apple Team ID + bundle identifier, Android signing SHA-256 (from EAS credentials) — needed for §11 well-known files

## 5. Phase 1 — auth: everyone to email OTP

**Client**

- `app/(auth)/login.tsx`: email-only form → `supabase.auth.signInWithOtp({ email, options: { shouldCreateUser: false } })` → route to new `app/(auth)/verify-otp.tsx` (6-digit input, `verifyOtp({ type: 'email' })`, resend with cooldown)
- `app/(auth)/signup.tsx`: name + email (+ optional pre-filled invite code, see §9) → `signInWithOtp({ options: { shouldCreateUser: true, data: { name, timezone } } })` → same verify screen. The existing `handle_new_user` trigger keeps seeding `user_profiles` from `raw_user_meta_data`
- Delete `app/(auth)/forgot-password.tsx`; strip password-reset handling from `src/hooks/use-auth-url-handler.ts`. Keep the hook for auth callbacks only (it gates on `isAuthCallbackUrl` — `src/lib/create-session-from-url.ts:31-33` — and is a useful fallback if Supabase ever sends a magic link instead of a code). It plays **no role** in invite links: `https://usemomora.com/invite?code=…` is handled entirely by Expo Router file-based linking (`app/invite.tsx`, §9)
- `src/services/auth.ts` + `src/hooks/use-auth.tsx`: replace password sign-in/sign-up with OTP request/verify; distinguish "user not found" (signup needed) from other errors
- **Dev/E2E path:** password provider stays enabled server-side; login screen renders a `__DEV__`-only "Sign in with password" toggle (same pattern as the E2E photo fixture). Maestro flows keep `TEST_EMAIL`/`TEST_PASSWORD`

**Update** `.maestro/flows/auth/login.yaml` to drive the dev toggle. Update `docs/features/auth.md`.

## 6. Phase 2 — tenancy schema, RLS, data migration

One migration `202607xx_family_sharing.sql` (+ seed migration for the word list).

**New tables**

```sql
create table public.families (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users on delete cascade,  -- family dies with owner, incl. auth-level hard delete
  name text not null,                      -- e.g. "Rosa's family"; editable
  illustration_style text not null default 'default',
  deleted_at timestamptz,                  -- mirrors owner soft-delete
  created_at/updated_at
);

create table public.family_memberships (
  id uuid primary key default gen_random_uuid(),
  family_id uuid not null references public.families on delete cascade,
  user_id uuid not null references auth.users on delete cascade,
  role text not null check (role in ('owner','manager','viewer')),
  created_at/updated_at,
  unique (family_id, user_id)
);
create unique index one_owner_per_family on family_memberships (family_id) where role = 'owner';

create table public.family_invites (
  id uuid primary key default gen_random_uuid(),
  family_id uuid not null references public.families on delete cascade,
  code text not null unique,               -- normalized "word-word-word"
  role text not null check (role in ('manager','viewer')),
  status text not null default 'pending'
    check (status in ('pending','redeemed','approved','rejected','revoked')),
  invited_by uuid not null references auth.users on delete cascade,
  redeemed_by uuid references auth.users on delete set null,
  redeemed_at timestamptz,
  resolved_by uuid,
  resolved_at timestamptz,
  expires_at timestamptz not null default now() + interval '7 days',
  created_at/updated_at
);

create table public.invite_code_words (word text primary key);        -- ~1,000 curated words (seed)
create table public.invite_redemption_attempts (
  user_id uuid not null, attempted_at timestamptz not null default now()
);
create table public.family_activity_log (                              -- push debounce (§10)
  family_id uuid not null references public.families on delete cascade,
  actor_id uuid not null,
  kind text not null,                       -- 'new_memory'
  created_at timestamptz not null default now()
);
```

`invite_code_words`, `invite_redemption_attempts`, and `family_activity_log` get `enable row level security` with **no policies** — they are only touched by definer RPCs and service-role Edge Functions; direct PostgREST access must be denied (otherwise clients could read other families' activity or delete rate-limit rows).

**Existing table changes**

- `memories`: add `family_id uuid not null references families on delete cascade` (backfill first, then `set not null`); `user_id` → nullable, FK `on delete set null` (attribution survives as "A former member"); new index `(family_id, memory_date desc)`; drop **both** `idx_memories_user_id` and `idx_memories_memory_date` (the existing hot-path index leads with `user_id` — `initial_schema.sql:66` — and becomes dead weight once timeline/calendar filter by `family_id`)
- `family_members` (children): same treatment — add `family_id`, relax `user_id`
- `user_profiles`: add `active_family_id uuid references families on delete set null`, `notify_new_memories boolean not null default true`; **drop** `illustration_style` (value moves to `families` in backfill)
- `handle_new_user` trigger: unchanged (profiles only — **no** auto-family; new users land in the "no family" state and either create one or redeem a code)

**Backfill (same migration)**: for each `user_profiles` row — insert `families` (owner_id = user, name = `<name>'s family`, illustration_style copied), insert owner membership, set `active_family_id`, stamp `family_id` on that user's `memories` and `family_members`.

**RLS rewrite** (drop all `auth.uid() = user_id` policies; every helper is `security definer` so membership lookups don't recurse):

| Table | select | insert | update | delete |
|---|---|---|---|---|
| `families` | member | via signup flow: authenticated user creates family + own owner-membership through definer RPC `create_family(name)` | owner/manager (name, style) | owner only |
| `family_memberships` | member of same family | **none** (RPC-only: `create_family`, approval EF) | manager+ may change `role` where target ≠ owner and new role ≠ owner | manager+ where target ≠ owner; self-delete (leave) where own role ≠ owner |
| `family_invites` | manager+ of family | manager+ via RPC `create_family_invite` only | manager+ (revoke: `status = 'revoked'`) | — |
| `memories` | member (family not deleted) | manager+, `with check (user_id = auth.uid() and has_family_role(family_id, ...))` | manager+ | manager+ |
| `family_members` | member | manager+ | manager+ | manager+ |
| `memory_family_members`, `memory_media` | member via memory's family | manager+ **and, for tags, `with check` that the tagged child's `family_members.family_id` equals the memory's `family_id`** — without this, a user who manages two families could tag Family B's child on a Family A memory, and `generate-illustration` would pull that child's portrait into another family's illustration (cross-tenant leak via `illustration-references.ts:74-128`). Media writes flow through reworked `replace_memory_media_assets`, see below | manager+ | manager+ |
| `user_profiles` | own row only (unchanged) | own | own | — |

- **Member names for attribution/member list:** do **not** widen `user_profiles` RLS (it holds `expo_push_token`, notification prefs). Add definer function `get_family_member_profiles(fam uuid) → table(user_id, name, role, is_active_member, created_at)` that checks `is_family_member(fam)` internally. It must cover **two populations**: current members (via `family_memberships`) *and* former members who still appear as creators of the family's `memories`/`family_members` rows — a removed-but-not-deleted user keeps their `auth.users` row, so the `user_id is null` fallback never fires for them; without this their attribution would silently resolve to nothing. Fallback "a former member" applies only when `user_id` is null (hard-deleted account)
- `families.deleted_at is not null` must make the family invisible to non-owners: fold the check into `is_family_member`/`has_family_role` **with an owner exemption** — `f.deleted_at is null or f.owner_id = auth.uid()`. A uniform fold would lock the owner out too: `cancel-account-deletion` runs with the *user* JWT (`index.ts:30-38`), so its UPDATE clearing `families.deleted_at` would match zero rows under RLS and silently no-op, making the family unrestorable for the whole grace window
- `replace_memory_media_assets`: authorize by `has_family_role(memory.family_id, {owner,manager})` instead of `user_id = auth.uid()`; key validation becomes *"key already belongs to this memory's `memory_media` rows OR starts with `auth.uid()/memories/<memoryId>/`"* (managers editing another member's memory keep old assets, add new ones under their own prefix). **Also fix the closing `update public.memories … where id = target_memory_id and user_id = current_user_id`** (`20260605141803…sql:104-110`): drop the `user_id` predicate — when a manager edits another member's memory it currently matches zero rows, silently leaving the cover fields (`media_key`/`media_content_type`) stale. **Ordering caveat:** the function deletes all existing `memory_media` rows *before* the validation loop (`…sql:50-51`), so "key already belongs to this memory" must be checked against a **snapshot of the existing `object_key` set taken before the delete** (e.g. into an array variable) — validating against the table mid-transaction would find nothing and collapse back to the caller-prefix-only rule
- `create_family_invite(fam uuid, invite_role text)`: definer RPC — assert manager+, assert `role in ('manager','viewer')`, pick 3 random words from `invite_code_words`, retry on unique collision, insert, return row
- Max-members trigger: before insert on `family_memberships`, count ≥ 50 → raise
- **`family_id` is immutable once set:** RLS `with check` can't compare old vs new rows, so a manager of two families could otherwise `update memories set family_id = B where id = <memory in A>` and silently relocate content (and stranded tags/media) across tenants — the same isolation bug the insert-time tag check closes, reopened via UPDATE. Add a `before update` trigger on `memories` and `family_members` raising when `old.family_id is not null and new.family_id is distinct from old.family_id` — the `old is not null` guard keeps the same-migration null→value backfill (and any future seeding) order-independent; a bare `is distinct from` check would abort the backfill UPDATE if the trigger is created first
- `create_family(name)`: cap owned families per user (raise at 5) — otherwise a client retry loop or abuse can create unbounded families; there's no legitimate MVP case for more

**After migration:** regenerate `src/types/database.ts` (`supabase gen types`), update `docs/TECH_SPEC.md` schema section.

## 7. Phase 3 — storage authorization (Edge Functions)

Keys keep the `{creatorUserId}/...` shape. Authorization changes from "prefix = caller" to "caller is member/manager of the owning family", resolved through the DB (service-role client):

| Function | Today | New rule |
|---|---|---|
| `get-upload-url`, `upload-media` | key prefix = caller uid | keep the prefix rule (uploads are always written under the *caller's* uid). Memory-row lookup is **not** possible at upload time — the client uploads assets *before* inserting the `memories` row (`useMemories.ts:312-341` → `createMediaMemory`). Instead: request gains a `familyId` field; assert caller is manager+ in that (non-deleted) family. Cross-family binding integrity is enforced later at insert/RPC time (memories RLS + `replace_memory_media_assets` key validation) |
| `get-media-url` | `assertUserOwnedKey` | parse each key (`_shared/storage-keys.ts` patterns already extract `familyMemberId`/`memoryId`): look up owning row → `family_id` → assert caller is member. Batch: one query per key-type per request |
| `delete-storage-object` | `isDeletableUserObjectKey` | same lookup, assert manager+ |
| `generate-illustration`, `generate-portrait-illustration` | top-level auth `memory.user_id = caller`, **and internal lookups also caller-scoped** | authorize manager+ of the row's family, **and** re-scope the internals: `generate-illustration` resolves tagged members via `family_members.user_id = caller` (`index.ts:143-161`) — must become `family_id = memory.family_id`, else a manager's memory tagging children added by the owner finds zero portraits and fails (`NO_PORTRAITS`); `generate-portrait-illustration` looks up the member by `id + user_id = caller` (`index.ts:65-69`) and calls `assertUserOwnedKey(profile_picture_key, caller)` (`:86`) — becomes member lookup by `id` + manager+ check on its `family_id`, key ownership check dropped (key comes from the DB row, trusted). `illustration_style` now read from `families`. Portrait output key derives its `{uid}` prefix from the member's current `profile_picture_key`, not from the caller |
| `process-voice-memory` | stateless (transcribe + match against client-passed `familyMembers`; no DB writes) | no server-side change; the client now passes the *active family's* members (Phase 4). Memory creation stays client-side under the new RLS |
| `analyze-emotion` | memory lookup `.eq('user_id', user.id)` (`index.ts:255`) and `assertUserOwnedKey` on media keys (`index.ts:131,160`); emotion UPDATE runs on the **user client** (`index.ts:249,286`) | re-scope like the illustration functions: memory lookup by id + *member* check on its family; drop caller-prefix key assertions (keys come from the DB row). **The emotion write must move to the service-role client**: the client auto-triggers backfill for any visible memory regardless of role (`useMemories.ts:221-259`), and a viewer's user-client UPDATE would match zero rows under the manager+ memories policy — 200 with `skipped: true`, emotion never persists, `isEmotionAnalyzable` stays true, permanent 5s re-trigger loop. Membership check authorizes; the enrichment write is a system write. Relatedly, gate the client-side illustration recovery (`useMemories.ts:188-214` → `retryMemoryIllustration`, `memories.ts:757`) to `role !== 'viewer'` — both its status UPDATE and `generate-illustration` call are rejected for viewers |
| `delete-user-account` | soft-delete own data | + if caller owns families: set `families.deleted_at`, push heads-up to members. Restore (`cancel-account-deletion`) clears it |
| `hard-delete-expired-accounts` | manually deletes the user's `memories`/`family_members`/`user_profiles` rows, deletes **all R2 objects under `{userId}/`** (`index.ts:46-60`), then `auth.admin.deleteUser` | **Owner:** collect R2 keys from `memory_media`, `memories.illustration_key`, `family_members` photo/portrait keys **across all creators in each owned family** (keys live under other members' prefixes) *before* deleting rows; delete family rows explicitly (plus `owner_id on delete cascade` as backstop so `auth.admin.deleteUser` can never FK-fail and silently skip the purge). **Non-owner:** memberships cascade; created content stays (`user_id → null`) — so the blanket "delete everything under `{userId}/`" sweep is **wrong** here: it would orphan media still referenced by surviving family rows. Delete only objects under the prefix that no surviving row references |

`_shared/storage-keys.ts`: add parsers returning `{ kind, ownerUserId, entityId }`; keep key-shape validation as-is.

**Child photo replacement by non-creators:** managers can edit children (decision), but the upload prefix rule means a manager can't overwrite `{creatorUid}/family/{memberId}/photo.webp`. Fix: photo replacement always uploads to `{editorUid}/family/{memberId}/photo.webp` and updates `profile_picture_key` to point at the new key (keys are already resolved from DB columns, not convention); portrait regeneration writes alongside the new photo prefix and updates `illustrated_profile_key`. Old objects cleaned up via `delete-storage-object`.

## 8. Phase 4 — client tenancy adoption

- **`FamilyProvider`** (new, in `src/components/app-providers.tsx` tree): loads memberships + `active_family_id`, exposes `{ family, role, memberships, setActiveFamily }`. Guards:
  - no membership → route to new `app/(app)/no-family.tsx` ("Start your family journal" → `create_family` RPC; "Enter an invite code" → redeem screen; also shown when kicked: provider detects memberships going empty and routes here with a "you no longer have access" notice)
  - stale/removed `active_family_id` → fall back to first membership
- `src/services/memories.ts`, `family-members.ts`: filter/insert by `family_id` (from provider) instead of `user_id`; stamp `user_id` (creator) on insert
- `src/hooks/queryKeys.ts` + query hooks (`useMemories`, `useCalendarMemories`, `useFamilyMembers`): key by `familyId`; invalidate on family switch. (`useAutoMemoryTags` has no query of its own — pure local state; it just needs its callers to pass family-scoped members)
- **Role gating** (`role === 'viewer'`): hide create FAB (`app/(app)/(tabs)/_layout.tsx` / timeline), hide edit/delete on memory detail + children, timeline "add your child first" CTA becomes a passive empty state for viewers
- **Attribution:** memory detail (and card, space permitting) shows "Added by {name}" via `get_family_member_profiles`; fallback "a former member" when `user_id` is null
- Settings: new Family section with editable family name (owner/manager only — note: no illustration-style picker exists today, TECH_SPEC.md:762; the style stays `'default'` on `families` with no UI, so nothing "moves"); family picker appears when memberships > 1

## 9. Phase 5 — invites, redemption, approval

**New Edge Functions**

| Function | Auth | Behavior |
|---|---|---|
| `redeem-family-invite` `{ code }` | JWT | normalize (lowercase, collapse spaces/dashes); rate-limit: ≤10 attempts/hour/user **and** ≤30/hour/IP (`invite_redemption_attempts` gains an `ip` column) — per-user limits alone are farmable via fresh OTP signups. IP must come from the platform-appended hop of `x-forwarded-for` (the **last** entry, added by Supabase's proxy), never the client-suppliable prefix — otherwise the IP limit is spoofable per-request and adds nothing; treat it as best-effort defense in depth. Defense in depth: with ≥1,000 words, the code space is 10⁹ against a handful of live invites, so blind guessing is uneconomical even for a botnet; the approval gate backstops a lucky hit; reject if redeemer is already a member; then claim the invite **atomically** — a single `update … set status='redeemed', redeemed_by=…, redeemed_at=now() where code=… and status='pending' and expires_at > now() and exists (select 1 from families f where f.id = family_id and f.deleted_at is null) returning *` (without the family check, a code shared before an owner soft-delete redeems into a dead family: the push fires but no one can approve — `resolve-family-invite` requires a role in the now-hidden family — stranding the redeemer on the waiting screen forever) (a check-then-write pair would let two concurrent redemptions both "succeed" with one silently overwritten); zero rows returned → invalid/expired/already-redeemed; push to inviter ("Rosa wants to join — approve?"); return `{ familyName, role }`. Prune attempt rows >24h old opportunistically |
| `resolve-family-invite` `{ inviteId, action: 'approve'\|'reject' }` | JWT | assert caller manager+ of the invite's family and invite `status='redeemed'`; approve → insert membership (role from invite; 50-cap trigger enforces limit), **always** set redeemer's `active_family_id` to this family (redeeming an invite is the strongest possible signal of intent — "if null" would leave an existing multi-family user staring at their old family's timeline after approval), push + Bento email ("You're in!"); reject → status |

**Client screens** — new group **`app/(app)/sharing/`**. Do **not** nest under `app/(app)/family/`: that group already means *children* (`family/[id]/index.tsx`, `[id]/edit.tsx`, the `family` tab). The children-vs-household naming hazard runs through the whole feature (`family_members` = children roster, `family_memberships` = household roster — one word apart); keep "sharing" as the household term in routes/components to stay unambiguous. Screens:

- **Invite create** (manager+): pick role → `create_family_invite` → share sheet with two-step message:
  > Hi! I'm journaling our family's memories with Momora and I'd love you to join.
  > 1. Get the app: `https://usemomora.com/invite?code=sunny-tiger-lake`
  > 2. Open it and enter code: **sunny-tiger-lake**
  > The code expires in 7 days.
- **Pending invites** (manager+): list with status/expiry; reshare (same code, share sheet); revoke
- **Pending approvals** (manager+): redeemed invites → name + email of redeemer (needs redeemer name: definer function `get_invite_redeemer(invite_id)` — the guard must be manager+ **of that invite's `family_id`**, not "manager anywhere": resolve the invite's family inside the function before checking, or a Family A manager could probe Family B invite ids for names + emails) → approve/reject
- **Redeem code**: dash-formatted 3-word input; entry points: (a) signed-in Settings "Join a family", (b) signup flow when a pending code exists, (c) `no-family` screen
- **Waiting screen**: post-redeem, "Ana will confirm it's you shortly"; poll invite status (definer function `get_my_redeemed_invite_status()`); on approve → refetch memberships → timeline; on reject → message + back to no-family/current state; terminal "family no longer available" branch when the invite's family gets soft-deleted *while* the redemption is pending (the status function surfaces this case)

**Universal link / pending-code plumbing**

- `app.json`: `associatedDomains: ["applinks:usemomora.com"]` (iOS), Android `intentFilters` for `https://usemomora.com/invite` with `autoVerify` → **new EAS dev build required**
- Route `app/invite.tsx`: reads `?code=`, stores to AsyncStorage `pendingInviteCode`, routes: signed-in → redeem screen (prefilled); signed-out → signup with code carried through OTP; consumed after redemption attempt
- **Guard precedence:** a signed-in user with zero memberships opening an invite link triggers both this route *and* FamilyProvider's no-membership redirect (§8). Rule: a stored `pendingInviteCode` wins — the provider must not clobber the redeem route, and `no-family.tsx` itself checks AsyncStorage on mount and forwards to the redeem screen prefilled, so the code survives whichever guard fires first

## 10. Phase 6 — notifications & email

- **New-memory push:** after successful memory create, client fire-and-forgets EF `notify-family-activity { memoryId }`: assert creator is manager+ of the memory's family; debounce — skip if `family_activity_log` has a `new_memory` row for same (family, actor) within 15 min, else log + push to all members except actor where `notify_new_memories` and `expo_push_token` present ("Rosa added a memory to Enzo's journal"). Reuses `sendExpoPushNotification` from `send-daily-reminder`
- **Settings toggle:** "New memory alerts" → `user_profiles.notify_new_memories`
- **Bento email:** `_shared/bento.ts` — `sendTransactionalEmail` via Bento HTTP API (secrets `BENTO_SITE_UUID`, `BENTO_PUBLISHABLE_KEY`, `BENTO_SECRET_KEY`); used by `resolve-family-invite` approval. OTP emails ride Supabase SMTP (Phase 0), no code
- Push copy/deep links: invite-redeemed push opens pending approvals; approval push opens timeline

## 11. Phase 7 — marketing site (`/Users/eduardoyi/Coding/momora-marketing`)

- `/invite` page (static, fits the existing `build.js` + `src/pages` system): parse `?code`, UA-based store links (App Store / Play), big code display + copy button, plain-language steps. No backend
- `/.well-known/apple-app-site-association` (appID `TEAMID.bundleId`, path `/invite*`) and `/.well-known/assetlinks.json` (package name + SHA-256) — served with correct content-type on Cloudflare Pages (`_headers` file). **`build.js` must be extended:** its `copyStaticFiles()` only emits `src/css`, `src/js`, `src/pages/*.html` (filtered on `.endsWith('.html')` — an extensionless AASA can't ride that path), `assets/`, and `CNAME`. Add explicit copy steps producing `dist/.well-known/apple-app-site-association`, `dist/.well-known/assetlinks.json`, and `dist/_headers` (`Content-Type: application/json` for the AASA path); without this the files never reach the deploy output and every universal link silently falls back to the marketing page. (`CNAME` is GitHub-Pages-only — dead weight on CF Pages, harmless)
- Verify AASA via Apple CDN check + `adb shell pm verify-app-links` once the EAS build exists

## 12. Phase 8 — docs, tests, cleanup

- `docs/features/family-sharing.md` (new, from template) — full feature doc incl. extension guide
- Update: `docs/TECH_SPEC.md` (schema, EF contracts), `docs/features/auth.md` (OTP), `family-profiles.md`, `memories.md`, `media-memories.md` (family authorization), root `AGENTS.md` high-risk list (invite/RLS surface)
- Remove dead code: password screens, `illustration_style` on profile settings

## 13. Testing strategy

| Layer | Coverage |
|---|---|
| Unit (Jest) | code normalization/formatting; role-gating helpers; share-message builder; FamilyProvider reducer logic; attribution fallback |
| Integration (Jest + local Supabase) | **RLS matrix** — for each table × role (owner/manager/viewer/non-member/removed): select/insert/update/delete expectations; invite RPC permission checks; backfill migration assertions; owner-uniqueness + 50-cap triggers; `replace_memory_media_assets` as a manager on another member's memory (cover fields must update, kept assets under the original creator's prefix must validate); cross-family tag rejection (manager of two families tagging family B's child on a family A memory); `family_id` reparent rejection on update (memories + family_members); owned-families cap |
| Edge (Deno) | redeem: happy path, expired, revoked, reused, rate-limited (user + IP), already-member, **family soft-deleted** (rejected); resolve: approve/reject, non-manager rejection; storage functions: member vs non-member vs viewer-write-attempt; illustration generation for a memory whose tagged children were created by a *different* member; `analyze-emotion` triggered by a **viewer** (emotion must persist via service-role write); hard-delete: owner (cross-creator R2 key collection) and non-owner (referenced objects survive); soft-delete → restore round-trip (owner can still clear `deleted_at` under RLS) |
| Maestro E2E | (a) OTP dev-path login; (b) full invite loop with two dev accounts: owner creates invite → read code from pending-invites screen → sign out → sign in as second account → redeem → sign back in as owner → approve → verify member sees timeline; (c) viewer sees no FAB/edit affordances |
| Manual QA | universal link cold-start (app not installed → store → install → manual code), share sheet on iOS/Android, Bento OTP deliverability, push notifications on device |

Run: `npm test`, `npm run test:edge`, `tsc`/lint (Node 20 via nvm — known env quirk), Maestro flows.

## 14. Risks & watch-outs

1. **RLS recursion/perf** — helper functions must be `security definer` + `stable`; add membership index `(user_id, family_id)`. Test policies with `explain` on timeline query
2. **`user_id` going nullable** ripples through generated types and client code — do types regen immediately after migration and fix compile errors in the same commit
3. **Supabase OTP template** silently sends magic links if `{{ .Token }}` isn't in the template — verify before building UI
4. **AASA propagation** is CDN-cached by Apple (up to ~24h); ship well-known files early
5. **`__DEV__` password path** must be compile-time gated (pattern exists) so production builds carry no password UI
6. **Debounce table growth** — prune `family_activity_log`/`invite_redemption_attempts` opportunistically in the EFs that write them
7. **Word list quality** — curate for: no offensive words, no homophones ("their/there"), no ambiguous spellings; all lowercase ASCII

## 15. Out of scope (explicitly)

Billing/quotas (only `family_id` stamping on generation), likes/comments, relationship labels, owner transfer, per-memory privacy, invite emails (share sheet only), family switcher beyond the Settings picker, web app for viewers.
