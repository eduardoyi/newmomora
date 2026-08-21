# Family Activity Sheet (Plan)

**Status:** Implemented on `main` 2026-08-21 (uncommitted; awaiting device verification + migration deploy)
**Date:** 2026-08-21
**Owner:** Eduardo + Claude
**Feature-doc target:** `docs/features/family-activity.md` (create when implementation starts)
**Branch:** built on `main` directly; `codex/gallery-import` stays separate (see §11)
**PRD areas:** Post-MVP household capability, extends §6.8 Likes & Comments and family sharing

## 1. Outcome

A bell in the timeline header opens a bottom sheet listing what the rest of the
household has been doing: *Ana added 3 memories*, *Grandma liked your
memory*, *Luis commented on "First swim"*, *Marta joined the family*. Tapping a
row opens the memory (or the comments drawer). An unread dot on the bell shows
there's something new since you last looked.

Why: the point of family sharing is "someone saw it." Today that signal exists
only as a creator-only, debounced push that disappears once dismissed. A
persistent in-app feed makes the journal feel alive for every member,
including those with push off, and gives owner/managers a standing nudge when
someone is waiting for approval.

## 2. Locked product decisions

1. **Likes are no longer private-identity.** The household can see who liked a
   memory. This reverses the 2026-07-13 decision recorded in
   [likes-and-comments.md](../features/likes-and-comments.md) ("there is no
   liker list"; like rows readable only by author). Rationale: in a 2–5 person
   household, anonymity buys nothing and "Grandma liked it" *is* the feature.
   Scope of the flip here is the activity feed only — no liker list UI is
   added to the engagement bar (safe to add later).
2. **Surface: bottom sheet over the timeline**, not a tab or screen. Same
   construction as `MemoryCommentsDrawer` (RN `Modal`, ~80% height, drag
   handle + explicit close button, own `GestureHandlerRootView`).
3. **Household feed, own actions excluded.** Everyone sees the same family
   events minus their own. Solo families see an empty state that nudges
   inviting.
4. **Bounded, not infinite.** The sheet shows at most **100 events**; older
   ones are simply gone. No "load more" past that, no archive. Enforced on
   read (RPC limit) and on storage (per-family retention, §5.4).
5. **Social only in v1.** No system events (illustration ready, Looking Back
   ready, import digests). Those already have their own surfaces.
6. **No Realtime.** Refetch on focus, on pull-to-refresh, and on sheet open —
   same policy as engagement.
7. **Unread is a dot, not a count.** Calmer; matches the no-visible-credits
   ethos. Opening the sheet clears it.
8. **Pushes are unchanged.** The feed is the persistent record; push
   preferences (`notify_new_memories`, `notify_engagement`) keep controlling
   push only and never filter the feed.

## 3. Event catalogue

| Kind | Trigger source | Row copy (actor ≠ viewer) | Tap target |
|---|---|---|---|
| `memory_added` | `memories` insert | **Ana** added a memory · *N grouped:* **Ana** added 4 memories · `creation_source='gallery_import'`: **Ana** added 12 memories from their gallery | memory detail (group: most recent memory) |
| `memory_commented` | `memory_comments` insert | **Luis** commented on a memory — one-line comment snippet | memory detail `?comments=1` |
| `memory_liked` | `memory_likes` insert | **Grandma** liked a memory · *grouped per memory:* **Grandma** and **Luis** liked a memory | memory detail |

**Copy rule (owner decision 2026-08-21):** like/comment rows reference the
memory itself — thumbnail plus a short memory excerpt (`memory_excerpt`, first
≤80 chars of `content`, falling back to `audio_transcript`) rendered under the
sentence — and never the person who created it. No "your memory", no "Ana's
memory", no former-member fallback for the creator.
| `member_joined` | `family_memberships` insert (approval path) | **Marta** joined the family | family members screen (owner/manager) or no-op |
| `member_pending` | `family_invites` update to redeemed | **Marta** is waiting for your approval — inline **Review** | approvals screen; owner/manager only |

Deliberately excluded: edits, deletes, un-likes (no "unliked" row — the
original like event is removed instead, see §5.1), comment deletions, settings,
billing, child profile changes (candidate for v2: `child_added`).

Audio memories are `memory_added` like any other (`memory_type='audio'`); copy
does not distinguish them in v1.

## 4. UX spec

### Entry point

- Bell glyph (`lucide-react-native` `Bell`) in the timeline header
  (`testID="timeline-title-section"` in
  [timeline.tsx](../../app/(app)/(tabs)/timeline.tsx)). On `main` the header
  is a plain column (eyebrow + "Your moments."); wrap it in a
  `headerTitleRow` (`flexDirection: 'row'`, `justifyContent: 'space-between'`,
  `alignItems: 'flex-start'`) with the bell on the right, vertically aligned
  with the title. The bell is its own component (`TimelineActivityBell`) so the
  later gallery-import merge — which adds a `TimelineImportGlyph` in the same
  row — is a one-line conflict. Hit-slop ≥ 12; `testID="timeline-activity-bell"`.
- Unread dot: 8px lavender-accent circle at the bell's top-right. Shown when
  `unread = true` from `get_family_activity_unread` (§6).
- Rendered for every role. Solo families still get the bell (empty state is
  an invite prompt).

### Sheet

- `FamilyActivitySheet` component, `visible` prop, mounted once on the
  timeline screen. Visual language copied from `MemoryCommentsDrawer`:
  handle, header "Family activity" + close button, bottom safe-area padding.
- Body: sectioned `FlatList` — **Today · Yesterday · This week · Earlier**.
- Row anatomy (left → right):
  text block (name in `fonts.semibold`,
  sentence in body, then one muted line: comment snippet for
  `memory_commented`, otherwise the memory excerpt; timestamp in caption
  using the existing `formatEngagementTimestamp`) · 44px memory thumbnail
  (illustration key → media key via `useMediaUrl` → placeholder) when the
  event has a memory.
- Grouped rows show up to 3 stacked thumbnails.
- `member_pending` rows carry a small **Review** pill that routes to
  `sharingApprovalsRoute`; non-managers never receive these rows (filtered in
  the RPC, not the client).
- States: loading skeleton (3 rows), error with retry, empty:
  > Quiet for now. When someone adds a moment or leaves a comment, it'll show
  > up here.
  > [Invite a family member] — shown only when active members == 1.
- Opening the sheet: refetch feed, then call `mark_family_activity_seen`
  (fire-and-forget) and optimistically clear the dot.
- Tap row → close sheet, then `router.push(...)` (avoid routing under a
  modal on Android).
- Accessibility: each row is one `accessibilityRole="button"` with the full
  sentence as label; the bell announces "Family activity, new" when the dot is
  on.

### Grouping (client-side, over the ≤100 fetched rows)

Applied in display order after fetching:

1. Consecutive `memory_added` by the same actor within **30 min** → one group.
2. `memory_liked` on the same memory within **24 h** → one group listing up to
   2 names + "and N others".
3. Everything else is 1:1.

Grouped rows use the newest member's timestamp. Grouping never crosses day
sections.

## 5. Data model

### 5.1 Table

```sql
create table public.family_activity_events (
  id            uuid primary key default gen_random_uuid(),
  family_id     uuid not null references public.families on delete cascade,
  actor_id      uuid not null references auth.users on delete cascade,
  kind          text not null check (kind in (
                  'memory_added','memory_commented','memory_liked',
                  'member_joined','member_pending')),
  memory_id     uuid references public.memories on delete cascade,
  comment_id    uuid references public.memory_comments on delete cascade,
  like_user_id  uuid,  -- set for memory_liked; with memory_id identifies the like row
  invite_id     uuid references public.family_invites on delete cascade,
  created_at    timestamptz not null default now()
);
create index idx_family_activity_events_family_created
  on public.family_activity_events (family_id, created_at desc, id desc);
create index idx_family_activity_events_actor
  on public.family_activity_events (actor_id);
```

Ids only — never memory text, comment text, or names. Content is joined at
read time through the RPC (security definer, but scoped to the caller's
family), so deleting a memory/comment/invite cascades the event and there is
nothing to scrub.

Un-liking: the `memory_likes` row has no id, so the like event is removed by a
delete trigger on `memory_likes` (`delete ... where kind='memory_liked' and
memory_id = old.memory_id and like_user_id = old.user_id`). This keeps "X liked
your memory" honest after a mis-tap.

`family_memberships` gets `activity_seen_at timestamptz` (nullable; null =
never opened → everything is unread).

### 5.2 Triggers (all `security definer`, `set search_path = public`)

| Trigger | On | Writes |
|---|---|---|
| `trg_activity_memory_added` | `memories` after insert | `memory_added`, actor = `new.user_id` (skip when null) |
| `trg_activity_memory_commented` | `memory_comments` after insert | `memory_commented`, actor = `new.user_id`, family via memory |
| `trg_activity_memory_liked` | `memory_likes` after insert | `memory_liked`, actor = `new.user_id`, `like_user_id = new.user_id` |
| `trg_activity_memory_unliked` | `memory_likes` after delete | deletes matching `memory_liked` |
| `trg_activity_member_joined` | `family_memberships` after insert | `member_joined` **only when the family already has ≥1 other membership** — suppresses the founder's own solo-family row and the backfill/no-family bootstrap inserts in `20260729130000` / `20260801120000` |
| `trg_activity_member_pending` | `family_invites` after update of `status` | `status` → `'redeemed'`: insert `member_pending`, actor = `new.redeemed_by`; `status` leaves `'redeemed'` (approved / rejected / revoked): delete that invite's `member_pending` event. Invite rows are updated, never deleted, on decision (`family_invites.status` lifecycle), so cascade alone is not enough |

Gallery import inserts memories with the service role through
`finalize-gallery-import-candidate`; the insert trigger fires identically, and
`creation_source='gallery_import'` is read at render time for the copy
variant. No import-specific plumbing.

Backfill in the same migration: one `insert ... select` each from `memories`
(last 90 days), `memory_comments`, `memory_likes`, and `family_memberships`
(excluding the oldest membership per family). Then apply §5.4 retention once
so no family starts over the cap.

### 5.3 RLS

- `family_activity_events`: RLS enabled, **no client policies**. Reads go
  through the RPC; writes only via triggers. Same posture as
  `family_activity_log`.
- `memory_likes`: replace `"Memory likes: select own"` with a household-read
  policy mirroring `"Memory comments: select"` (active member of the memory's
  family). Insert/delete stay self-only. Update
  [likes-and-comments.md](../features/likes-and-comments.md) §Data model and
  the "do not change" list in the same PR.

### 5.4 Retention

Two guards:

- **Read cap:** `get_family_activity` returns at most 100 rows, newest first.
- **Storage cap:** a daily job deletes, per family, rows beyond the newest 200
  **or** older than 90 days. Implemented as a SQL function
  `prune_family_activity_events()` called by the existing
  `cleanup-abandoned-anonymous-users` 04:00 UTC cron sibling pattern — new
  `pg_cron` job `invoke-prune-family-activity` at 04:30 UTC, or folded into
  an Edge Function only if it needs secrets (it doesn't; a pure
  `select cron.schedule(..., $$select public.prune_family_activity_events()$$)`
  is enough and avoids Vault/pg_net).

200 > 100 so that client-side grouping and the hidden-own-events filter still
leave a full sheet.

## 6. API (RPCs, all JWT, `security definer`, `stable` where applicable)

| Function | Input | Output | Notes |
|---|---|---|---|
| `get_family_activity(target_family_id uuid)` | — | up to 100 rows, newest first: `id, kind, created_at, actor_id, actor_name, actor_is_former, memory_id, memory_creation_source, memory_excerpt (≤80 chars), memory_illustration_key, memory_media_key, memory_media_content_type, comment_id, comment_snippet (≤120 chars), invite_id` | Requires active membership (`is_family_member`); excludes `actor_id = auth.uid()`; excludes `member_pending` unless caller has role owner/manager (`has_family_role`); actor name from `user_profiles.name` with `actor_is_former = not exists(active membership)` and the client rendering "A former member" |
| `get_family_activity_unread(target_family_id uuid)` | — | `boolean` | `exists(... created_at > coalesce(activity_seen_at, '-infinity') and actor_id <> auth.uid())` with the same role filter for `member_pending` |
| `mark_family_activity_seen(target_family_id uuid)` | — | `void` | sets caller's membership `activity_seen_at = now()` |

Both read RPCs also exclude events whose actor the caller has blocked
(`blocked_family_accounts`, family-scoped), matching the push-delivery rule
in [content-reporting.md](../features/content-reporting.md).

Implementation note (WP-DB finding): `family_memberships` carried a
table-level `UPDATE` grant to `authenticated`; the migration narrows it to
`update (role)` so clients cannot write `activity_seen_at` directly.

Thumbnails reuse the existing signed-URL path (`get-media-url` / illustration
key resolution already used by timeline cards) — no new media endpoint.

No Edge Function changes. `notify-family-activity` and
`notify-memory-engagement` keep using `family_activity_log` for debounce; they
are unrelated to this table.

## 7. Client

| Piece | Location | Notes |
|---|---|---|
| service | `src/services/family-activity.ts` | RPC wrappers + row → `FamilyActivityEvent` mapping, `groupFamilyActivity()` pure function |
| hooks | `src/hooks/useFamilyActivity.ts` | `useFamilyActivity(familyId, { enabled })` (`staleTime` 30 s), `useFamilyActivityUnread(familyId)` (refetch on focus + on timeline pull-to-refresh), `useMarkFamilyActivitySeen()` (optimistic `unread=false`) |
| query keys | `src/hooks/queryKeys.ts` | keyed by family id; invalidate on family switch like engagement keys |
| components | `src/components/family-activity-sheet.tsx`, `family-activity-row.tsx`, `timeline-activity-bell.tsx` | |
| screen | `app/(app)/(tabs)/timeline.tsx` | bell in header, sheet mounted once, `onPressRow` routing |
| invalidation | `useMemoryEngagement`, memory create/finalize paths | after a successful like/comment/create, invalidate the **other** members' feeds is impossible client-side — rely on refetch-on-open; only invalidate the local unread query when the family switches |
| routes | `src/lib/routes.ts` | reuse `memoryDetailRoute`, `memoryDetailCommentsRoute`, `sharingApprovalsRoute`, `sharingMembersRoute` |
| copy | `src/utils/family-activity-copy.ts` | sentence builder (actor name(s) + verb + "a memory" / "N memories" / "N memories from their gallery" / "joined the family" / "is waiting for your approval"); never references the memory creator |

## 8. Delivery: dependencies & EAS Update

- **No new dependencies.** Everything needed is already in `package.json`:
  `lucide-react-native` (bell), RN `Modal` + `react-native-gesture-handler`
  (sheet, same as the comments drawer), `@tanstack/react-query`, `expo-image`,
  `expo-haptics`. No native module, permission, entitlement, or config-plugin
  change.
- **Ships as an EAS Update.** The client change is JS/asset-only and runtime
  compatible with the current binary, so it can go out via the
  preview → production channel flow in
  [eas-update.md](../features/eas-update.md).
- **Order of operations matters:** deploy the migration (table, triggers,
  RPCs, like-policy change, backfill, cron) **before** publishing the update.
  The migration is backward compatible — old clients never call the new RPCs
  and the widened like-select policy is harmless to them. Publishing the
  update first would make the bell error on every open.

## 9. Tests

| Layer | File | Covers |
|---|---|---|
| DB (pgTAP, `supabase/tests/family_activity.sql`) | triggers write the right rows; own-family-only reads; own events excluded; `member_pending` hidden from viewers; un-like removes event; solo-founder membership produces no `member_joined`; cascade on memory delete; prune keeps newest 200/90 d; like-select policy now household-wide but insert/delete still self-only |
| unit | `src/services/family-activity.test.ts` | row mapping, `groupFamilyActivity` (30 min / 24 h windows, no cross-day grouping), copy builder incl. possessives and gallery-import variant |
| unit | `src/components/family-activity-sheet.test.tsx` | sections, empty/loading/error, invite CTA only for solo, Review pill gating, close-then-route order |
| unit | `src/components/timeline-activity-bell.test.tsx` | dot visibility + a11y label |
| integration | `src/hooks/useFamilyActivity.integration.test.tsx` | enabled gating, refetch on open, mark-seen optimistic clear + rollback |
| Maestro | `.maestro/flows/engagement/family-activity.yaml` | two-account flow: B likes + comments on A's memory; A opens timeline, sees dot, opens sheet, sees both rows, taps comment row → comments drawer |

## 10. Work packages

1. **WP-DB** — migration `20260822100000_family_activity.sql`: table,
   triggers, RPCs, `activity_seen_at`, like-policy flip, backfill, prune fn +
   cron; regenerate `src/types/database.ts`; TECH_SPEC section; pgTAP.
2. **WP-SVC** — service + hooks + grouping + copy + unit/integration tests.
3. **WP-UI** — bell, sheet, row, timeline wiring, empty/solo states, a11y;
   component tests; keyboard rule n/a (no `TextInput` in this sheet).
4. **WP-DOCS** — `docs/features/family-activity.md` (from `_template.md`),
   update `likes-and-comments.md` (privacy flip, liker visibility),
   `family-sharing.md` (seen-at column, member events), `docs/features/README.md`.
5. **WP-VERIFY** — `npm test`, `tsc`, pgTAP run, Maestro flow on device;
   deploy migration; publish preview update; confirm on device; promote.

Subagent drill applies (Sonnet implements WP-SVC/WP-UI, review before commit,
commit only after device confirmation).

## 11. Branching

Built on `main`. `codex/gallery-import` keeps its three commits and the
stashed marketing-slideshow rename (`git stash list` →
"marketing slideshow output rename"). Known merge hotspot when gallery import
lands later: the timeline header title row in `app/(app)/(tabs)/timeline.tsx`
— both branches add a glyph there. Keep the bell as its own component with a
one-line insertion to make that merge trivial.

## 12. Resolved questions

- Like/comment copy references the memory, not its creator (§3 copy rule).
- No v2 roadmap items are planned; the feature is complete as specified here.

## 13. Outcome (2026-08-21)

Implemented via the subagent drill (two Sonnet implementers, one fix round
each). Feature doc: [family-activity.md](../features/family-activity.md).

Deviations from this plan, all accepted:

- Empty-state invite link routes to `sharingInviteRoute` (household invite),
  not `addFamilyMemberRoute` (that route is the children roster).
- `member_joined` tap is a no-op (close only); no members-screen callback.
- Pull-down-dismiss thresholds moved to `src/utils/bottom-sheet-dismiss.ts`
  (shared by the comments drawer and the activity sheet) so the sheet does
  not pull in the drawer's hook chain.
- Sheet data hooks live in an inner body rendered inside the `Modal`, so
  nothing fetches until the sheet opens; row taps defer navigation until the
  sheet has re-rendered closed.
- Actor avatar dropped after the first device look (owner call): rows are
  text + thumbnail only.
- Maestro flow is a single-account approximation (bell → sheet → empty copy
  → close); the unread dot / rows / Review pill need a second account and
  are covered by pgTAP + component tests instead.
