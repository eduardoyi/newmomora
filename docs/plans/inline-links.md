# Inline links in memory text — implementation plan

Status: planned · Owner: Eduardo · Plan date: 2026-07-12

## 1. Goal & UX spec

When a memory's text contains a pasted URL, the app renders it as an on-brand inline
link instead of the raw URL:

- Rendered form: `(Page Title)` — parentheses + title, where the whole parenthesized
  span is tappable. Example: `https://www.youtube.com/watch?v=44Cgkd3WtU8` renders as
  `(Alexisonfire - We Are The End - YouTube)`.
- Titles are fetched server-side after save (async). Until a title exists — or if the
  fetch fails — the link renders with the domain as fallback label: `(youtube.com)`.
- Tapping opens the phone's **default browser** (`Linking.openURL`), never an in-app
  browser.
- **The editor stays plain text.** In `new-memory` / `edit` the user sees and edits the
  raw URL. Pretty links appear only in rendered views. (RN `TextInput` is plain text;
  rich editing is out of scope.)
- Card previews (timeline, calendar, family list) substitute `(Title)` /`(domain)` as
  plain styled text but are **not** tappable there — the whole card is already a
  Pressable and nested tap targets inside truncated text would conflict.
- Capture-first is preserved: memory text saves immediately; title fetching is
  fire-and-forget and never blocks or fails a save.

### Link styling (rendered views)

- Link span inherits the surrounding font family/size/line-height (serif display in
  editorial view, sans in framed view) — it must sit inside flowing text without
  looking bolted on.
- Color: `colors.sea` (`#3FA8A1`) for the title text; parentheses included in the
  tappable span, same color. No underline — parentheses + accent color are the
  affordance. `suppressHighlighting` on iOS; `accessibilityRole="link"`.
- In card excerpts the substituted `(Title)` is plain `colors.ink2` (not sea) so
  truncated previews stay quiet.

## 2. Design decisions (and why)

| Decision | Choice | Rationale |
|---|---|---|
| Where the URL lives | Raw URL stays in `memories.content`, untouched | Non-destructive: edit shows what the user typed; failed fetches degrade to domain label; titles refreshable later |
| Where titles live | New `memories.link_previews jsonb` column, `{ [url]: { title: string \| null, fetchedAt: string } }` | All memory queries use `select('*')` so it flows to every screen with zero query changes; per-memory metadata doesn't warrant a table + attach step |
| Who fetches titles | New Edge Function `fetch-link-previews` (memoryId-based, JWT), which fetches titles **and** writes the column | Mirrors `analyze-emotion` (memoryId in, family-role check, service-client write); keeps user IP away from third-party sites; consistent UA handling; single place for SSRF defenses |
| When it runs | Fire-and-forget from `useMemories` mutation `onSuccess`: on create when content contains a URL, on update whenever content changed (prunes stale entries); invalidate memory queries when it resolves | Same slot where `notifyFamilyActivityFireAndForget` already runs; no polling needed |
| Rendering | Render-time substitution via a new `MemoryContentText` component; `formatMemoryExcerpt` gains preview substitution for cards | No stored markup format to migrate or escape |
| AI prompts | Strip URLs from content before every OpenAI prompt call site | URLs pollute emotion/illustration/safety prompts; titles are untrusted page content and must **never** be fed to prompts |

`null` title in the map = fetch attempted and failed → client renders domain. The Edge
Function re-attempts `null`-title URLs on subsequent invocations (i.e. next edit/save),
no background retry loop.

## 3. Data model

New migration `supabase/migrations/20260712T_memory_link_previews.sql` (use real
timestamp, `YYYYMMDDHHMMSS` format):

```sql
alter table public.memories
  add column link_previews jsonb not null default '{}'::jsonb;
```

No RLS changes (column rides existing `memories` policies). Then regenerate
`src/types/database.ts` via `npx supabase gen types typescript --local` (requires
`supabase start`; see §10 env notes for fallback).

## 4. Edge Function: `fetch-link-previews`

`supabase/functions/fetch-link-previews/index.ts`, exported handler
`handleFetchLinkPreviews(req)` for tests, `Deno.serve` under `import.meta.main` —
copy the `analyze-emotion` skeleton (CORS → method guard → `getAuthenticatedUser` →
user client read → family-role check → service client write → in-memory cooldown map,
5s per memory → `jsonResponse` / `errorResponse`).

**Request:** `POST { memoryId: string }` (JWT in Authorization header)
**Response:** `{ linkPreviews: Record<string, { title: string | null, fetchedAt: string }> }`
**Errors:** standard `{ error, code }` — 401 unauthenticated, 403 not a family member,
404 memory not found, 405 method, 429 cooldown.

Behavior:
1. Load memory (`id, family_id, content, link_previews`), authorize via
   `getCallerFamilyRole`.
2. `extractUrls(content)` (shared util, §5). Deduplicate in first-seen order,
   then cap at the **first 5 unique URLs**; ignore the rest.
3. Diff against stored `link_previews`: fetch URLs that are new or have `title: null`;
   keep existing non-null entries; **prune entries whose URL no longer appears in
   content** (handles edits, including edits that remove all URLs — see §7).
4. Fetch each title (parallel, `Promise.allSettled`), then write the merged map with
   the service client, **guarded against clobbering a concurrent content edit by
   comparing `content`, NOT `updated_at`**: make the update conditional on both the
   memory id and the exact `content` snapshot from step 1, then verify that a row was
   updated. The comparison and write must be one atomic database statement.

   > Why not `updated_at`: `set_memories_updated_at` (initial_schema migration) bumps
   > `updated_at` on **every** column update, and the memory's own AI pipeline
   > (emotion write at analyze-emotion :278, `illustration_status` writes in
   > generate-illustration) runs concurrently with this function on the create path
   > and almost always lands first. An `updated_at` guard would silently discard the
   > fetched titles on virtually every new memory, with no follow-up invocation to
   > redo the work. Only a change to `content` itself invalidates our fetch.

### Title fetching rules (in `_shared/link-preview.ts`)

- Scheme allowlist: `http:`/`https:` only. Ports 80/443/default only. Reject URLs
  with userinfo (`@`).
- **SSRF guard — two layers, applied to the initial URL and every redirect hop:**
  1. *Hostname rules.* Extract the host via `new URL(url).hostname` — never a string
     regex (the WHATWG URL parser normalizes decimal/octal/hex IPv4 encodings like
     `2130706433` / `0x7f000001` to dotted-quad, so the literal check below actually
     sees them). Reject IP-literal hosts entirely (v4 and v6, including bracketed
     forms), plus hostnames `localhost`, `*.local`, `*.internal`.
  2. *DNS resolution check.* Hostname rules alone don't stop the standard bypass: an
     innocuous-looking domain whose A/AAAA record points at a private or metadata IP.
     Before fetching, resolve the hostname (`Deno.resolveDns(host, 'A')` and
     `'AAAA'`, tolerating per-type failures) and reject if **any** resolved address
     is loopback (`127/8`, `::1`), private (`10/8`, `172.16/12`, `192.168/16`,
     `fc00::/7`), link-local/metadata (`169.254/16` incl. `169.254.169.254`,
     `fe80::/10`), unspecified (`0.0.0.0`, `::`), or an IPv4-mapped IPv6 form of any
     of these. Then fetch by hostname as usual. The residual TOCTOU/DNS-rebinding
     window between resolve and fetch is accepted and documented as a known
     limitation (single fetch, no attacker-observable timing loop; Supabase Edge
     runtime is isolated).
- Follow redirects manually (`redirect: 'manual'`, max 3 hops), re-running **both**
  layers on each hop's URL.
- Per-fetch timeout 5s (`AbortController`); only proceed if response
  `content-type` includes `text/html`; read at most 128 KB of the body.
- Send a desktop-browser-ish `User-Agent` (many sites, incl. YouTube, serve junk or
  403 to unknown agents).
- Parse `og:title` meta first, then `<title>`. Decode basic HTML entities
  (`&amp; &lt; &gt; &quot; &#39;` + numeric). Collapse whitespace, strip ASCII
  control chars **and Unicode bidi/format control chars** (U+202A–U+202E,
  U+2066–U+2069 — a hostile page title could otherwise visually reorder the rendered
  span), trim, cap at 200 chars. **No suffix stripping** — titles kept verbatim
  (spec example intentionally keeps “- YouTube”).
- Any failure → `title: null` for that URL. Never throw for one bad URL.
- **Privacy/logging:** never log URLs, titles, or content — ids and status codes only
  (repo rule).

### Client wrapper

`src/services/ai.ts`: add `fetchLinkPreviews(memoryId: string)` via the existing
`invokeEdgeFunction` helper.

## 5. Shared URL utilities

Two small mirrored modules (Deno functions can't import from `src/`):

**`supabase/functions/_shared/link-preview.ts`** — `extractUrls(text)`,
`isFetchableUrl(url)` (SSRF rules), `parseHtmlTitle(html)`, `cleanTitle(raw)`,
`stripUrls(text)` (for AI prompts: remove URLs, collapse doubled whitespace).

**`src/utils/links.ts`** — client mirror:
- `extractUrls(text: string): string[]`
- `splitContentIntoSegments(text): Array<{ type: 'text', text } | { type: 'link', url }>`
- `linkLabel(url, previews): string` — preview title if non-null, else hostname
  without `www.` prefix.

URL regex (both sides, keep identical): match `https?://` + non-whitespace, then trim
trailing punctuation `.,;:!?)]}"'` and a trailing `…`. Only http/https. Deliberately
conservative — a missed exotic URL just stays plain text.

Known accepted edge case: a URL the user already wrapped in parens renders as
`((Title))`. Optional nicety (low priority): skip adding parens when the raw text
already has them immediately around the URL.

## 6. Client rendering changes

1. **New `src/components/memory-content-text.tsx`** — `MemoryContentText`:

   ```tsx
   <MemoryContentText
     content={memory.content}
     linkPreviews={memory.link_previews}
     style={styles.detailText}     // parent text style, inherited by all segments
   />
   ```

   Splits content into segments; link segments render as nested
   `<Text accessibilityRole="link" suppressHighlighting onPress={() => openLink(url)}
   onLongPress={() => revealUrl(url)}>` containing `(` + label + `)`, colored
   `colors.sea`. `openLink` validates the scheme is http/https again and calls
   `Linking.openURL(url)` (import from `react-native`; no new dependency); on
   rejection show `Alert.alert('Could not open link')` — never fail silently.

   **Spoofing mitigation:** the title is third-party-controlled and the rendered
   label hides the destination, so `revealUrl` (long-press) shows an Alert with the
   full URL and Open/Cancel actions — the user can always inspect where a link
   really goes before opening it. Document this tradeoff (title-only label by
   product choice, long-press to inspect) in the feature doc.

2. **Detail screen** [app/(app)/memory/[id]/index.tsx]: replace the two raw
   `<Text>{memory.content}</Text>` renders (framed :288-289, editorial :357) with
   `MemoryContentText`, preserving the existing styles.

3. **Card previews**: extract the substitution step into
   `substituteLinkLabels(content, linkPreviews)` in `src/utils/links.ts` (replace
   each URL with `(label)`), then:
   - `formatMemoryExcerpt(content, maxLength, linkPreviews?)` in
     `src/utils/memories.ts` applies it before truncation — covers both
     `memory-card.tsx` call sites (:173, :220).
   - `app/(app)/(tabs)/calendar.tsx` (:147-148) and
     `app/(app)/family/[id]/index.tsx` (:232-233) do **not** use
     `formatMemoryExcerpt` — they render `content` raw inside `numberOfLines` Text.
     Wrap those two renders in `substituteLinkLabels(...)` directly (the rows'
     queries already `select('*')`, so `link_previews` is available on the objects).
   None of these preview renders are tappable.

4. **Types:** `link_previews` lands on `Memory` via regenerated `database.ts`. Define
   `LinkPreviewMap` type in `src/utils/links.ts` and cast/narrow the jsonb at the
   service boundary (`Json` → `LinkPreviewMap`) defensively — treat malformed entries
   as absent.

## 7. Trigger wiring

In `src/hooks/useMemories.ts`:

- `createMutation.onSuccess`: fire when the created content contains a URL
  (`extractUrls(content).length > 0`; `onSuccess(data, variables)` exposes the input).
- `updateMutation.onSuccess`: fire whenever **content was part of the update** —
  not only when the new content contains a URL. An edit that *removes* the last URL
  must still invoke the function so its prune step (§4.3) clears the stale
  `link_previews` entries; the no-URL invocation is cheap (prunes to `{}`, fetches
  nothing).

  ```ts
  void fetchLinkPreviews(memoryId)
    .then(() => invalidateMemoryQueries(queryClient))
    .catch(() => {});
  ```

- **Media memories created via the background upload queue:** the queue completes
  creation outside these mutations. The post-create completion point is
  `src/hooks/use-pending-memory-uploads.tsx`, `runUpload` (the block around :98-103
  that fires `runMediaPhotoEmotionAnalysis(memory.id)` after `createMediaMemory` —
  note this is a hook, not a `src/services/` module). Add the same fire-and-forget
  there when the caption contains a URL, reusing that block's existing invalidation.

Never await these in the save path; a failure must be silent (previews degrade to
domain labels).

## 8. AI pipeline: strip URLs from prompts

Apply `stripUrls` from `_shared/link-preview.ts` at every content→prompt call site:

- `analyze-emotion/index.ts` :277 (`analyzeTextIllustrationEmotion(row.content)`) and
  :315 (`analyzeMediaPhotoEmotion({ content: row.content, … })`) — strip inside these
  call sites (or at the top of the helpers, whichever is the smaller diff).
- `generate-illustration/index.ts` :213-216 (safety rewrite user prompt) and :218
  (fallback `memory.content.slice(0, 280)` — strip **before** slicing).
- `generate-illustration/index.ts` :160 name-matching against content: strip there too
  for consistency (URLs can't match member names, but keep one rule).

Empty-after-strip guard (a URL-only memory passes today's raw-content checks but
would produce an empty prompt) — **note neither function has a reusable branch at
the right point; this is explicit new/moved logic:**

- `analyze-emotion`: the existing empty-content branch (:269,
  `if (!row.content?.trim())`) runs on **raw** content. Change it (or add a second
  check) to test `stripUrls(row.content)` so URL-only memories take the existing
  skip path instead of prompting with an empty string.
- `generate-illustration`: the only empty check (:109) is on raw content at the top
  of the handler; nothing downstream detects an empty `safeDescription`. Add a new
  guard after stripping (before the safety-rewrite call at :213, also covering the
  :218 fallback slice) that marks `illustration_status: 'failed'` / returns a 400
  consistent with the :109 behavior — do not let an empty scene description reach
  the image API.

Fetched titles are **never** used in prompts (untrusted third-party content —
prompt-injection surface).

## 9. Testing

| Layer | File | Covers |
|---|---|---|
| Unit (Jest) | `src/utils/links.test.ts` | URL extraction incl. trailing punctuation, multiple URLs, no-URL text; segment splitting; `linkLabel` fallback to domain; `substituteLinkLabels`; malformed preview map handling |
| Unit (Jest) | `src/utils/memories.test.ts` (extend) | `formatMemoryExcerpt` with previews: substitution + truncation interplay |
| Component (Jest) | `src/components/memory-content-text.test.tsx` | renders text+link segments, parens present, `Linking.openURL` called with the raw URL on press (mock), non-http URL not opened, long-press reveals full URL (Alert mock), openURL rejection shows Alert |
| Integration (Jest) | `src/hooks/useMemories.integration.test.tsx` (extend) | create/update with URL in content triggers `fetchLinkPreviews` (mocked service) + invalidation; save succeeds when the preview call rejects |
| Edge (Deno) | `supabase/functions/_shared/link-preview.test.ts` | extraction parity, SSRF rejections (IP literals incl. bracketed IPv6 + normalized decimal/hex forms, localhost/*.local, DNS resolving to private/metadata ranges via mocked `Deno.resolveDns`, redirect to rejected host, bad scheme/port/userinfo), title parsing (og:title precedence, entities, bidi-char stripping, 200-char cap), `stripUrls` |
| Edge (Deno) | `supabase/functions/fetch-link-previews/index.test.ts` | 401 unauth, 403 family authorization, 404 not found, 405 method, 429 cooldown, viewer-triggered service-role write, prune-removed-URLs + keep-existing-titles merge logic, null-title on fetch failure (mock `globalThis.fetch`), first-5-unique URL cap, atomic write skipped when `content` changed mid-flight, null-content predicate |
| E2E (Maestro, best-effort) | `.maestro/flows/memories/inline-link.yaml` | create memory containing `https://example.com`, open detail, assert “Example Domain” or `(example.com)` visible; tolerate either (network-dependent) |

Run `npm test`, `npm run test:edge`, `npm run typecheck`, `npm run lint`.

## 10. Docs & repo hygiene

- New `docs/features/inline-links.md` from `_template.md` (overview, data flow,
  `link_previews` shape, Edge Function contract, extension guide: how to add
  favicons/embeds later, gotchas: SSRF rules, no titles in prompts, editor stays raw).
  Add row to `docs/features/README.md`.
- TECH_SPEC §4: add `fetch-link-previews` contract; §schema: `link_previews` column.
- AGENTS.md product constraint line “Plain text memories — no rich text in MVP”:
  amend to note pasted URLs render as fetched-title links (display-level only; storage
  stays plain text).
- Migration + regenerated types + TECH_SPEC in the same change (repo rule).

### Environment notes (for the implementer)

- Use Node 20 (`nvm use 20`) for `npm test` / `typecheck` / `lint`. Some tsc errors
  pre-exist on main — compare against a baseline run before blaming your diff.
- Edge tests: `npm run test:edge` (deno with `--allow-env --allow-net --allow-read`).
- Types regen needs local Supabase (`supabase start` then
  `npx supabase gen types typescript --local > src/types/database.ts`). If local
  Supabase can't run in your environment, hand-add the `link_previews` field to the
  `memories` Row/Insert/Update types **exactly matching generator formatting**
  (`link_previews: Json`), note it in your summary, and flag that regen should be
  rerun. Do not reformat the rest of the file.

## 11. Implementation order

1. `_shared/link-preview.ts` + Deno tests (pure logic first).
2. Migration + types (regen or careful manual per §10).
3. `fetch-link-previews` function + Deno tests.
4. URL stripping at the four AI call sites (+ extend existing Deno tests minimally).
5. `src/utils/links.ts` + tests; `formatMemoryExcerpt` change + tests.
6. `MemoryContentText` + tests; wire into detail screen + card call sites.
7. `fetchLinkPreviews` service wrapper; hook + upload-queue trigger wiring +
   integration tests.
8. Docs (feature doc, README index, TECH_SPEC, AGENTS.md line).
9. Maestro flow. Full verification pass (`npm test`, `test:edge`, `typecheck`, `lint`).

## 12. Out of scope

- Rich text editing / live link chips inside `TextInput`.
- Link cards/embeds, favicons, image previews (extension guide covers the path).
- Stripping tracking params from URLs; title refresh UI; search improvements
  (`searchMemories` still matches raw URLs in content — acceptable).
