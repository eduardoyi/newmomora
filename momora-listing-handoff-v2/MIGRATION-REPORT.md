# v1 → v2 migration report

**Scope:** WP-A, Phase 0 (`prompts/00-rebase-existing-work.md`). Produced 2026-09-20 on
branch `listing/v2-memory-first`, HEAD `93620da9b66d08b9c36e4f6be625e81ed3cb9af3`.

## 1. There was no prior v1 handoff folder

Checked with:

```
git log --all --diff-filter=A --name-only --format="" -- "momora-listing-handoff*"
```

This returns **zero results** — no directory matching `momora-listing-handoff*` was ever
added in the history of this repository. `git status` at session start also shows
`momora-listing-handoff-v2/` as untracked (`??`), i.e. it was copied into this checkout for
this task and has never been committed. There is therefore no prior `state.json`, prior
copy registry, or prior QA/upload manifest to merge from at the handoff-folder level.

**Conclusion:** prompt 00's "when no prior work exists, create v2 state and record that
migration was unnecessary" clause applies to the handoff folder itself. It does **not**
apply to the underlying listing assets — see §2.

## 2. Pre-existing listing work does exist, outside any handoff folder

`store-assets/` was added in commit `4381f0ed83ffeb99f712899aa5083dbb472550c7`
("assets: add store-listing asset pipeline and marketing screenshots", 2026-07-19) and has
not been touched since (`git log --oneline -- store-assets/manifest.json` shows only that
one commit). It is a complete, self-contained Playwright rendering pipeline plus a
6-slide + feature-graphic "round-1" storyboard, entirely independent of any
`momora-listing-handoff*` folder. This is the "substantial pre-existing listing work" the
task description points to, and it is what REBASE-FROM-V1.md's preservation table is
modeled on even though it predates any handoff.

## 3. Mapping the six round-1 slides to the v2 seven-frame sequence

Source: `store-assets/manifest.json` (only version that has ever existed). All six
`store-assets/manifest.json` headlines are effort-first / art-first framing and are
**all superseded** by the memory-first v2 registry (`approved-listing-copy.json`). None of
the six may be reused as public copy in v2.

| Slide id | Headline (superseded) | What it is | Copy status | Underlying capture reusable in v2? |
|---|---|---|---|---|
| `s1-hook` | "You don't have to remember it all." | Hero/art layout, no device screenshot — decorative watercolor (`art/hero-family.png`, generated) + script accent. | Superseded — effort-relief framing ("we'll keep the little things"), not the memory-first promise. | The generated hero art is decorative brand texture, not product evidence; it is allowed under PLAN.md §6 rules but is not itself a genuine capture. No direct reuse as a default frame; could resurface only as a labelled decorative accent, not as slide 01. |
| `s2-transformation` | "Say it.\nWatch it become art." | Device screenshot of `store-assets/source/IMG_0912.PNG` (ladybug watercolor illustration memory detail) + iPad `s2-memory-detail.png`. | Superseded — "watch it become art" over-frames illustration as the product's core loop; art-first, not story-first. | **Yes.** `IMG_0912.PNG` and the iPad memory-detail capture are genuine illustrated-memory evidence. Reusable in v2 frame **03 "For the things a photo missed."** (see `approved-listing-copy.json` screenshot id `03-unphotographed-stories`) as the illustration-output half of that proof; the composer-input half (the actual short text/voice entry that produced it) is not on disk — see ASSET-CHECKLIST.md. |
| `s3-no-homework` | "No blank pages. No homework." | Device screenshot of `store-assets/source/IMG_0908.PNG` (timeline: text-only story card + photo card) + iPad `s3-timeline.png`. | Superseded — "no homework" is effort-relief framing; v2 leads with what the app keeps, not with the absence of labor. | **Yes.** `IMG_0908.PNG` and the iPad timeline capture are genuine timeline evidence, reusable in v2 frame **01 "Keep more than the photos."** (`01-more-than-photos`) as the photo + story half of the digital-collection proof. |
| `s4-family-cast` | "Everyone becomes a character." | Device screenshot of `store-assets/source/IMG_0909.PNG` (character portrait roster) + iPad `s4-family.png`. | Superseded — frames the family roster purely as an illustration-generator cast list, not as a private, permissioned family space. | **Partially.** The roster capture shows the character cast (who has a portrait), which is a different concept from family **roles**/invitations. It may support v2 frame **06 "For your family. Not a public feed."** (`06-private-family`) only as secondary visual context, not as proof of the role/invite controls the frame's `proof` field actually asks for (see ASSET-CHECKLIST.md — 06 is `partial`/`blocked` on that basis). |
| `s5-look-back` | "Made for the 2 a.m. scroll." | Device screenshot of `store-assets/source/IMG_0910.PNG` (reverse-chronological day list, Calendar tab) + iPad `s5-calendar.png`. | Superseded — "2 a.m. scroll" plus the phrase "look back" as a slide id both risk implying the unreleased Looking Back recap feature; must not be reused verbatim. | **Yes, the capture.** `IMG_0910.PNG` and the iPad day-list capture are genuine, real calendar/day-list evidence (not the Looking Back feature — that is a separate, unreleased rail per `docs/features/looking-back.md:1-9`). Reusable in v2 frame **07 "Here when you want to look back."** (`07-look-back`) — the v2 headline text itself is generic "come back to the app" language and is **not** a claim about the Looking Back feature; PLAN.md §2.4 requires keeping the two conceptually separate in the actual composition. |
| `s6-closing` | "Start where you are." | Hero/art layout — decorative watercolor (`art/evening-moment.png`, generated) + script accent, no device screenshot. | Superseded — generic closing sentiment, not tied to any v2 frame job. | Decorative art only, same status as `s1-hook`: allowed as brand texture if labelled, not a default frame on its own. |

`feature-graphic` (Play Store 1024×500) is out of the v2 seven-frame default sequence
entirely; the v2 brief and PLAN.md scope this pass to the App Store iPhone/iPad buckets
only, so it is left untouched and unmapped here.

### What is preserved

- **Renderer:** `store-assets/render.mjs` (Playwright, IHDR-dimension-asserting render
  loop) — reusable as-is, extended with the new `appstore-65` bucket in phase 4.
- **Template:** `store-assets/templates/screenshot.html` (device/hero layouts, iPhone/iPad
  frame skins, 9:41 status bar) — reusable as-is, same extension needed.
- **Fonts:** `store-assets/fonts/{Newsreader,PlusJakartaSans,Caveat}/*.ttf` — reusable,
  local, no network dependency.
- **Native captures:** all four iPhone (`IMG_0908/0909/0910/0912.PNG`) and five iPad
  (`ipad/s2-s5-*.png`, `ipad/spare-person-detail.png`) source images — reusable per the
  per-slide mapping above and ASSET-CHECKLIST.md.
- **Tokens:** `src/constants/theme.ts` remains the source of truth; the template's
  hand-mirrored copy of the palette should be diffed against it before phase 4 (not done in
  this pass — recorded as a `needs_revalidation` item in `state.json`).
- **Device mappings:** the existing bucket→pixel-size table (`appstore`, `appstore-alt`,
  `ipad`, plus the Play buckets which are out of this pass's scope) is preserved unchanged;
  only `appstore-65` is new.

### What is archived (not yet executed — recorded here as the plan for phase 3/4)

`store-assets/manifest.json` and `store-assets/out/**` are the v1 artifact and **stay in
place**; they are not deleted or moved by this pass. Per PLAN.md §3, v2 renders from a new,
separate `store-assets/manifest.v2.json` (not yet created — phase 4), and phase 3 is
responsible for copying the current `store-assets/out/**` into
`store-assets/archive/v1-2026-08/` before any v2 render run, so the v1 outputs remain
available for rollback. Neither the archive move nor `manifest.v2.json` has been created by
this WP-A pass; they are explicitly out of WP-A's scope (owned by WP-C/WP-D).

### Which gates are reopened

Per REBASE-FROM-V1.md's state-migration rule, no prior "complete" flag exists to reopen
(there was no v1 state.json). The gates that matter going forward, all currently
`not_started` in `state.json`:

- **Copy (phase 2):** every headline above must be regenerated from
  `approved-listing-copy.json`; none of the six round-1 headlines may reach a public field.
- **Composition (phase 4):** `manifest.v2.json` must reference the *v2* headline/support
  text for each reused capture, not `store-assets/manifest.json`'s params.
- **Variants/manifests (phase 4/5):** the two opener challengers
  (`existing-photo-first`, `voice-first`) and the optional `07-ownership-alternative` slot
  are new work with no v1 equivalent to migrate.
- **QA (phase 5):** a fresh reviewer must check the seven default frames plus challengers
  against the brief's acceptance tests; no v1 QA record exists to inherit a pass from.

## 4. Stale-v1 string scan

Requested scan: grep the repository for the five strings in `approved-listing-copy.json`
`superseded_active_strings`:

1. `Momora: Baby Book & Memories`
2. `From camera roll to real pages`
3. `A baby book from the photos you already have.`
4. `A baby book.\nNot another project.`
5. `A book for\neach of them.`

**Scoped to active/public listing paths** (`store-assets/`, `docs/app-store-revamp/`,
`momora-listing-handoff-v2/copy/`) — the paths that would actually reach a store field, a
render manifest, or a generated export — the scan returns **zero hits**, confirming the
owner's prior "I already ran it: zero hits" claim for those paths:

```
grep -rn --exclude-dir=node_modules --exclude-dir=.git -F \
  -e "Momora: Baby Book & Memories" -e "From camera roll to real pages" \
  -e "A baby book from the photos you already have." -e "A baby book." -e "A book for" \
  store-assets docs/app-store-revamp momora-listing-handoff-v2/copy
# (no output; exit code 1)
```

**Unscoped, whole-repository grep** finds **2 hits**, both outside any active/public path
and both exempted by REBASE-FROM-V1.md's stale-content gate ("Exempt explicitly labeled
change logs and deferred-test specifications, not public upload files"):

- `momora-listing-handoff-v2/documents/momora-listing-implementation-prompts-v2.md:811-815`
  — this is the source document that itself defines the `superseded_active_strings` list
  (i.e. it is quoting the strings *in order to name them as superseded*, the same list that
  ended up copied into `approved-listing-copy.json`). Not a live usage.
- `momora-listing-handoff-v2/reference/momora-app-store-conversion-review.md:164` — a
  labelled historical comparison row ("v1: 'A baby book from the photos you already
  have.'") inside a revised human report, explicitly discussing it as a superseded v1
  example. Exempted as a labelled change/history reference, not public copy.

**Conclusion:** the "zero hits" claim is accurate for every path that could reach a
customer-facing surface. It is not literally zero hits across the whole repository, and
this report records that distinction rather than silently repeating the stronger claim.

## 5. `manifest.json` headline provenance note

`store-assets/manifest.json` has only ever had one set of headlines (verified via
`git log --oneline -- store-assets/manifest.json`, one commit). Those headlines are the
same six listed in §3 above (`s1-hook` … `s6-closing`) — there is no second, separate
"manifest.json era" of copy distinct from the round-1 storyboard; the round-1 storyboard
**is** `manifest.json`. Both are superseded by the v2 registry. `manifest.json` is kept in
place unmodified as the v1 artifact (still renderable, still useful for rollback/comparison
in phase 5 QA); v2 rendering targets a new `store-assets/manifest.v2.json`, not yet created.

## 6. Deviations / things this report cannot resolve

- No book-first backlog file (`old effort-first and book-led opener` per REBASE-FROM-V1.md's
  table) was found as a *separate* artifact from the six slides above — the "effort-first"
  and "art-first" openers referenced by that row are `s1-hook`/`s6-closing` (effort-first)
  and `s2-transformation`/`s4-family-cast` (art-first) respectively, not additional files.
  Recorded here rather than inventing extra artifacts to match the table's generic language.
- No hard-coded book-first strategy was found inside test fixtures, validator assertions,
  or upload-manifest scripts, because none of those exist yet in this checkout (phase 2/3/4
  tooling — `build-copy.mjs`, `validate-copy.mjs`, `UPLOAD-MANIFEST.md` — has not been
  created). There is nothing to find-and-replace yet; this is noted as a forward-looking
  non-issue, not a completed check.
