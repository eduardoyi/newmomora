# Plan: Emoji reactions on memories

**Status:** in progress (2026-10-11)
**Branch:** `feature/emoji-reactions` (worktree `~/Coding/Momora2-reactions`, off local `main` 2d61786)

## Goal

Replace heart-only likes with WhatsApp-style emoji reactions.

Product decisions (agreed with the user 2026-10-11):

1. **One reaction per person per memory.** Picking a different emoji replaces your reaction; picking the same one again (or tapping your reaction) removes it.
2. **Any emoji.** A quick tray of 6 (❤️ 😂 😮 😢 🙏 👍) plus a "+" that opens a full emoji picker.
3. **Show who reacted with what.** Tapping the reaction summary opens a sheet listing each household member's reaction.
4. **All reactions count** wherever likes counted before (Memory Book best-of, counts). No change is needed there: a reaction is still one `memory_likes` row.

## Context (what exists today)

- `memory_likes (memory_id, user_id, created_at)`, PK `(memory_id, user_id)`. Household select policy, self-only insert (billing-gated) / delete. No update policy.
- Latest RPC definitions to base new code on:
  - `set_memory_like` → `supabase/migrations/20260801150000_paid_subscription_hardening.sql:226` (anonymous guard, membership check, `billing_engagement_allowed` check on like).
  - `get_memory_engagement` → `supabase/migrations/20260729130000_onboarding_anonymous_lockdown.sql:1182`.
  - `get_family_activity` → `supabase/migrations/20260930120000_year_films_p2.sql:200` (the LATEST; do not base on older copies).
- Family activity: trigger `activity_memory_liked` inserts a `memory_liked` event on `memory_likes` insert (`like_user_id` = liker); delete trigger removes it. Insert-only: a reaction *change* is an UPDATE and must not create a new event.
- `notify-memory-engagement` Edge Function: kind `'like' | 'comment'`, body `"<name> liked a memory"`, 24h debounce key per actor/memory for likes.
- `workflow-memory-book-bridge` reads `memory_likes (memory_id, user_id)` as a best-of signal. **Leave it unchanged.**
- Client: `src/services/engagement.ts` (`setMemoryLike`), `src/services/memories.ts` (`fetchEngagementForMemories` / `attachEngagement` → `likeCount`, `commentCount`, `likedByMe` on `MemoryWithTags`), `src/hooks/useMemoryEngagement.ts` (optimistic mutation via `patchMemoryInCaches`), `src/components/memory-engagement-bar.tsx` (heart + comments + share), `src/services/family-activity.ts`, `src/utils/family-activity-copy.ts`, `src/components/family-activity-sheet.tsx`. Names: `useFamilyMemberProfiles` + `resolveAttributionName` (`src/hooks/useFamilyMemberProfiles.ts`), as used by `memory-comments-drawer.tsx`.
- Old app builds stay in the field and keep calling `set_memory_like` / reading `liked_by_me`. Everything must stay backwards-compatible: **only add columns/functions, never remove or rename existing outputs.**
- Ships via OTA (runtime policy `appVersion`), so **no new native modules**. A pure-JS dependency is fine.

## Backend (Implementer A)

### A1. Migration `supabase/migrations/20261015120000_memory_reactions.sql`

1. `alter table public.memory_likes add column emoji text not null default '❤️'` plus `updated_at timestamptz not null default now()`. Check constraint `memory_likes_emoji_valid`: `char_length(emoji) between 1 and 16 and emoji !~ '[[:space:][:cntrl:]]'`. (No "is this really an emoji" check in SQL: the client only offers emoji. The constraint just bounds abuse.)
2. New `public.set_memory_reaction(target_memory_id uuid, reaction text)` → `returns table (reaction text, changed boolean, inserted boolean, like_count bigint, top_reactions text[])`, `security definer`, `set search_path = public`. Copy every guard from the latest `set_memory_like` (auth, anonymous, memory exists, membership, billing check when `reaction is not null`). Then:
   - `reaction is null` → delete the caller's row.
   - Otherwise validate it (null-safe trim; raise `22023` if invalid, same rule as the constraint) and upsert: `insert ... on conflict (memory_id, user_id) do update set emoji = excluded.emoji, updated_at = now() where memory_likes.emoji is distinct from excluded.emoji`. Determine `inserted` (true only when a new row was created; use a pre-check or `xmax = 0` via `returning`) and `changed` (any row affected).
   - Return the caller's current emoji (or null), `changed`, `inserted`, total count, and `top_reactions`.
   - Revoke from public/anon/authenticated; grant to authenticated.
3. `top_reactions` everywhere = up to 3 distinct emojis for the memory ordered by count desc, then most recent `max(updated_at)` desc. Put this in a small `stable` SQL helper, `public.memory_top_reactions(uuid) returns text[]`. It is internal: revoke execute from public/anon/authenticated, and call it only from the security-definer functions.
4. Recreate `get_memory_engagement` by drop + create (the return shape changes): keep `memory_id, like_count, comment_count, liked_by_me` exactly as they are, and append `my_reaction text, top_reactions text[]`. Keep the anonymous and membership guards and the grants.
5. Keep `set_memory_like` working for old clients, with unchanged semantics. `should_like = true` on an existing row with any emoji does nothing (on conflict do nothing); a new row gets the default ❤️. No change should be needed, but verify.
6. Recreate `get_family_activity` (drop + create, based on the **year_films_p2** version) with one extra trailing column, `reaction_emoji text`: a left join to `memory_likes ml on e.kind = 'memory_liked' and ml.memory_id = e.memory_id and ml.user_id = e.like_user_id`. Keep everything else byte-identical, including the grants.
7. Reactions need no new RLS policy. Changes go through the security-definer RPC, so no update policy is required; keep it that way. The existing household select policy already lets the who-reacted sheet read `memory_likes` directly.

### A2. pgTAP `supabase/tests/memory_reactions.sql`

Follow the style of `supabase/tests/family_activity.sql`. Cover:
- Default ❤️ backfill.
- Set: `inserted` / `changed` flags for new, same, different, and null.
- One row per user.
- Constraint rejects `''`, `'   '`, `'a b'`, and a 17-char string.
- Anonymous and non-member get `42501`.
- Billing gate.
- `get_memory_engagement` returns `my_reaction` / `top_reactions` in the right order.
- Old `set_memory_like` still works and doesn't overwrite a 😂.
- A reaction change produces no second activity event, and `get_family_activity.reaction_emoji` reflects the current emoji.

Also update `supabase/tests/family_activity.sql` / `onboarding_anonymous_lockdown.sql` / `paid_subscriptions.sql` only if their plans/assertions break (for example, a column-count or signature check).

### A3. Types

Docker is usually down, so hand-edit `src/types/database.ts` to match:
- the `memory_likes` Row/Insert/Update (`emoji`, `updated_at`);
- the new `get_memory_engagement` Returns columns;
- the `set_memory_reaction` function;
- `get_family_activity` with `reaction_emoji`.

Match the file's existing formatting exactly. If `npx supabase gen types` works locally, use it instead.

### A4. `notify-memory-engagement`

Keep kind `'like'` (for wire compatibility with old clients). In `verifyEngagement`, also select `emoji` for likes, and build the body as `${actorName} reacted ${emoji} to a memory`. If there is no emoji, fall back to `"liked a memory"`. Debounce key unchanged. Update `index.test.ts`.

### A5. Docs

TECH_SPEC (§2 schema and §4.14 / wherever `set_memory_like` and `get_memory_engagement` are documented): add the new column, RPC, and outputs.

## App (Implementer B)

### B1. Service and data

- `src/services/engagement.ts`:
  - add `setMemoryReaction(memoryId, reaction: string | null)` → `{ reaction, changed, inserted, likeCount, topReactions }`;
  - add `fetchMemoryReactions(memoryId)` → `[{ userId, emoji, updatedAt }]` via `supabase.from('memory_likes').select('user_id, emoji, updated_at').eq('memory_id', id).order('updated_at', { ascending: false })`;
  - add `isValidReaction(s)` (trimmed, 1–16 code points via `Array.from`, no whitespace).
  - Keep `setMemoryLike` exported (it's harmless), but the UI stops using it.
- `src/services/memories.ts`: map `my_reaction` → `myReaction: string | null` and `top_reactions` → `topReactions: string[]` on `MemoryWithTags`. Keep `likedByMe` (= `myReaction != null`) and `likeCount` so other readers keep working.

### B2. Hook `useMemoryEngagement`

- Replace `toggleLike` with `setReaction(emoji | null)`. Keep a `toggleLike` alias meaning: no reaction → ❤️, otherwise remove.
- Optimistic patch of `myReaction` / `likedByMe` / `likeCount` (+1 only when going from none to some, −1 when removing) / `topReactions`: best-effort locally; the server result reconciles it.
- Roll back on error.
- Notify (`notifyMemoryEngagementFireAndForget(memory.id, 'like')`) only when `result.inserted`.
- Invalidate the reactions-list query (key in `src/hooks/queryKeys.ts`, keyed by family + memory, like comments) on success.

### B3. UI

- **`memory-engagement-bar.tsx`**
  - Reaction button: shows the outline heart when I haven't reacted; shows my emoji (Text, about `iconSize`) when I have. Keep the pop animation and haptic on set.
  - Tap: toggles ❤️ / remove. Long-press (about 300ms): opens the reaction tray.
  - Keep `testID memory-like-<id>` on the button, and update accessibility labels ("React to memory" / "Remove reaction 😂").
  - Next to it, when `likeCount > 0`: a summary pressable showing `topReactions` joined plus the count (`testID memory-reactions-<id>`). It opens the who-reacted sheet.
  - Zero stays hidden (`count > 0`, never `{count && ...}`).
- **New `src/components/reaction-tray.tsx`**: a transparent `Modal`, positioned above (or below, if there isn't room) the button using `measureInWindow`, so it never clips inside the FlatList.
  - Contents: 6 quick emojis, a "+" button, and my current emoji highlighted.
  - Picking an emoji calls `setReaction` (same emoji = remove). Tapping outside closes it.
  - "+" opens the full picker.
- **Full picker**: use a pure-JS library (preferred: `rn-emoji-keyboard`; before installing, confirm it has no native code and supports our React Native version; if not, stop and report back). Fall back to a small in-repo picker only if no suitable pure-JS lib exists. Theme it with `@/constants/theme` colors.
- **New `src/components/memory-reactions-sheet.tsx`**: bottom-sheet `Modal` in the same style as `memory-comments-drawer.tsx` (its own `GestureHandlerRootView`, safe areas). It needs no TextInput.
  - Header: total count, plus filter chips "All", then one chip per emoji with its count.
  - Rows: avatar initial, name (`resolveAttributionName`), and emoji. My row says "You" with "Tap to remove".
  - Loading, empty, and error states.
- **Mount points**: wherever `MemoryEngagementBar` is used (timeline card, memory detail). The bar can own the sheet and tray itself, which is simplest and avoids touching parents. Check the call sites.

### B4. Family activity

- `src/services/family-activity.ts`: map `reaction_emoji` → `reactionEmoji?: string | null` on events.
- `src/utils/family-activity-copy.ts`, `memory_liked`:
  - 1 actor: "**Grandma** reacted 😂 to a memory" (no emoji → "liked a memory").
  - 2 or more actors: "**A** and **B** reacted ❤️😂 to a memory", with up to 3 distinct emojis in event order. If none have emojis, keep the current "liked" copy.
- Check `family-activity-sheet.tsx:220` for anything like-specific (icon). Update its tests.

### B5. Tests and docs

- **Unit/integration**: `engagement.integration.test.ts`, `useMemoryEngagement.integration.test.tsx`, `memory-engagement-bar.test.tsx`, a new `reaction-tray.test.tsx` and `memory-reactions-sheet.test.tsx`, `memories.integration.test.ts` mapping, and the family-activity copy/service tests.
- **Maestro**: extend `.maestro/flows/engagement/like-and-comment.yaml`: tap heart (❤️ reaction), long-press, pick 😂, open the reactions sheet, see "You 😂".
- **Docs**:
  - `docs/features/likes-and-comments.md`: rename the section/title to "Reactions & comments", and update behavior, data model, API, extension guide, tests, and changelog.
  - `docs/features/family-activity.md`: copy change.
  - `docs/PRD.md` §6.8: a one-line mention.

## Risks / edge cases

- **Old clients**: an old build shows a filled heart for any reaction, and tapping it removes it. That's acceptable.
- **Emoji string length**: ZWJ family/flag sequences are several code points. 16 code points covers real emoji; validate the same way on the client and the server.
- **Optimistic `topReactions`** can briefly be wrong; the server reply wins.
- **Activity**: changing a reaction must not create a second event; the feed shows the current emoji.
- **Push copy** contains the emoji only, never memory content.
- **Long-press vs scroll**: the long-press must not fire while the timeline is scrolling. Use `Pressable`'s `onLongPress` with `delayLongPress`, which cancels on scroll.
- **Tray positioning** near the top or bottom of the screen and with the notch: clamp to the safe area.

## Verification

- `npm test`, `npx tsc --noEmit`, and lint.
- Deno tests for the notify function.
- pgTAP if `supabase start` works; otherwise CI.
- Device QA by the user before commit (the usual workflow).

## 2026-10-11 revision: option C (merged pill)

After device testing, the separate my-reaction button beside the summary looked like a duplicate action. The bar now has one pill (up to 3 top emoji, each its own `<Text>`, plus count; pink "mine" style when you reacted) and a smiley-plus button shown only when you haven't reacted. Tap-to-heart is removed; `memory-like-<id>` is replaced by `memory-react-<id>` (smiley, opens the tray) and `memory-reactions-<id>` (pill: tap = who-reacted sheet, long-press = tray). `toggleLike` stays in the hook but the bar no longer uses it.

Follow-up (split pill): while you haven't reacted, the pill is one rounded shape with a left emoji+count segment and a hairline-divided Plus segment (`memory-react-<id>`) that opens the tray; the standalone smiley now shows only when there are no reactions.
