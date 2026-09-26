# Momora — updated implementation prompts and complete brief

**v2 / memory-first. Supersedes the book-first handoff.**

Use the accompanying v2 ZIP in the repository. Start with prompt 00, then run 01–05 sequentially in the same checkout. A fresh QA session must read persisted files. The complete brief, commercial guide and exact copy registry follow the prompts.

## Prompt 00 — 00-rebase-existing-work.md

```text
The Momora App Store assignment has changed. This is the authoritative v2 reset, not an additional book-first task.

Read:
- momora-listing-handoff-v2/MASTER-BRIEF.md
- momora-listing-handoff-v2/REBASE-FROM-V1.md
- momora-listing-handoff-v2/COMMERCIAL-CLARITY.md
- momora-listing-handoff-v2/approved-listing-copy.json
- Repository AGENTS.md and applicable nested instructions.

New strategy: sell the useful paid app experience—photos, stories, saved sound, easy import, revisiting and chosen-family connection. Printed books are a substantial optional extension in default slot 5, not the destination that makes everything else worthwhile.

Owner reference prices: $99/year for the app; another $99 plus shipping for an optional book. These are context, not permission to change prices or assume live/localized amounts. No included book, credits or printing requirement. Verify book-generation/review entitlement before describing it as included.

The first acceptance test is: hide the print frame and paragraph. The remaining listing must still explain why someone would subscribe and return.

Inspect the current worktree and any v1 handoff, state, copy, assets, generator, tests and upload manifests. Do not reset Git, overwrite unrelated edits, delete useful captures or rerun production seed scripts.

When prior work exists:
1. Preserve reusable source/capture/provenance/tooling after checking freshness and rights.
2. Map old artifacts to the new seven-image sequence using REBASE-FROM-V1.md.
3. Remove superseded public-copy exports and old variant manifests from the active release set without destroying rollback material.
4. Find hard-coded book-first strategy in copy registries, templates, ordering arrays, test assertions, READMEs and upload scripts. Log and replace active references during the relevant phases; do not do a blind global replace.
5. Create v2 state by safely merging relevant non-secret project paths. Preserve old state, record what was reused and reopen copy/composition/variant/QA gates. An old “complete” flag is not a v2 pass.

When no prior work exists, create v2 state and record that migration was unnecessary. Do not invent old artifacts.

Create a migration report and actual state.json under momora-listing-handoff-v2/. The supplied state.example.json is a schema example, not a replacement for existing work.

Use the new default sequence only:
01 More than photos
02 Existing photos
03 Unphotographed stories
04 Saved little voice
05 Optional printed book
06 Private family
07 Looking back

Required opener challengers are existing-photo-first and voice-first. Book-first is a deferred hypothesis, not required production or a default. Do not execute the old five prompts.

Do not publish, deploy, push, merge, order, spend money, alter pricing or redesign product flows. Finish with preserved/reopened items, exact v2 state paths and any genuine blockers. Then proceed to prompt 01 when instructed.
```

## Prompt 01 — 01-ground-truth-and-setup.md

```text
Implement the complete Momora App Store revamp in eduardoyi/newmomora. This is phase 1 of 5 after the v2 migration/reset.

Read momora-listing-handoff-v2/MASTER-BRIEF.md, COMMERCIAL-CLARITY.md, approved-listing-copy.json, state.json and the supplied customer research/revised report. Read applicable repository instructions. If migration has not run, execute prompt 00 first.

The strategy is memory-first: a useful app experience worth having without a print purchase. Do not restore book-first positioning or turn this into generic AI-journal copy. The app's $99/year and optional $99+shipping print are owner context; verify actual commercial implementation without changing it.

Inspect current code before editing. Find existing metadata conventions, screenshot source/generator, safe fixtures, native capture tools, brand assets, book renderer and current feature implementations. Detailed feature docs may be fresher than an index; separate documentation from runtime/release evidence.

Reuse existing listing directories. Only when no convention exists, use marketing/app-store/ and docs/app-store-revamp/. Record canonical paths, revision, locale, supported devices and status in v2 state.

Create actual files for:

1. Implementation inventory: exact reusable files, commands, sources, permissions and missing tools. Include already completed v1 work that can be retained.

2. Claim matrix: import grouping/drafted captions and approval; short capture/illustrations; actual saved audio; per-child revisiting; family roles; continued read/owner export; automatic books/website review/print ordering; all paid entitlements. Cite local paths and line ranges. Label code evidence, runtime observation and production confirmation distinctly.

3. Commercial expectation map: what membership provides without printing, what costs extra, and unresolved localized price/entitlement checks. Do not claim a print credit, free book or included book preparation without evidence.

4. Asset checklist for all seven new default frames and two digital-value openers. Map actual routes/states to the v2 storyboard. Maintain separate photo, story and sound paths rather than inventing a combined memory type.

5. Device/locale plan: inspect current app.json and build configuration. Include genuine iPad captures when supported; do not disable support or stretch phone UI.

6. BLOCKERS.md: only inputs that cannot be resolved from the checkout. Continue independent work rather than blocking everything behind a missing book sample.

Inspect seed/reset/generation scripts and their environment targets before running. Use safe local fixtures or approved demo material. No production mutations, customer-media copying, physical orders, billable calls or secret disclosure.

Do not modify onboarding, paywall, pricing, app identity, icon, production flags or shipping configuration. Record product-funnel problems separately.

This phase must create the workspace and evidence files, not just a plan in chat. Mark status complete only for checks actually performed; leave unavailable production checks unverified. Finish with paths, useful existing tooling, genuine blockers and updated v2 state.
```

## Prompt 02 — 02-listing-text-and-metadata.md

```text
Continue the Momora v2 revamp. Phase 2: implement all store text and metadata files.

Read momora-listing-handoff-v2/MASTER-BRIEF.md, COMMERCIAL-CLARITY.md, approved-listing-copy.json, state.json and phase-1 evidence. Use v2 proposed copy, not the old baby-book opening.

The app must be meaningful without ordering print. The description establishes useful photos/stories/recordings, easier import and revisiting before the optional book paragraph. Do not change this hierarchy to justify membership through a future print purchase.

Implement one canonical copy registry and generate real store-field files in the existing metadata convention. Reuse working v1 tooling where appropriate; do not add a deployment framework merely to write text.

Implement:
- Name: Momora: Family Memories
- Subtitle: Photos, stories & their voices
- The complete v2 promotional text and description from the registry.
- The relevance-only keyword candidate, without pretending to have volume/rank data.
- What's New appropriate to the actual submitted release. Do not announce already-released features as new in an unrelated version.
- All seven screenshot headlines/support/disclosures.
- Existing-photo-first and voice-first opener copy; optional owner-export slot kept separate. The old book/effort-first variants are not active defaults.
- Valid existing support/privacy/marketing/Terms links and required subscription wording, or explicit release blockers. No invented legal entities, URLs, trial eligibility or boilerplate.

Document evidence-based corrections without silently changing strategy. These are proposed words within an approved direction, not permission to make an unverified factual claim.

Commercial clarity is mandatory: membership and print are separate; print is optional and shipping extra. Retain the subscription qualifier and post-lapse owner-export distinction. Do not imply included book credits, guaranteed storage, unlimited AI or free new writes.

Keep exact owner reference prices in internal context rather than hard-coding them into global description/screenshots. Verify localized display amounts and book-preparation entitlement for the owner checklist. Do not alter pricing/paywall/checkout code.

Public outputs must be plain UTF-8 without Markdown bold, JSON, comments or placeholder tokens. Preserve all other locales; en-US is this pass's scope unless a documented release constraint requires another.

Implement and run exact validation against current official Apple rules:
- Name/subtitle <=30 characters.
- Promotional text <=170 characters.
- Description and What's New <=4000 characters.
- Keywords <=100 UTF-8 bytes.
Check actual exported strings including whitespace/punctuation; check registry/export equality. The included handoff validator is a useful baseline, not proof of release compliance. Correct its paths as needed without weakening checks.

Add a stale-v1 scan for active default text, layout configuration, tests and upload manifests. Historical migration notes/deferred tests are exempt; active public metadata is not.

Do not change expo.name, icons, bundle IDs, subscriptions or store account data. Do not upload.

Finish with all text files, the literal count/validation report, a substantive copy change log, unresolved release checks and updated state. Show the final description and exact paths. Chat-only copy is not completion.
```

## Prompt 03 — 03-capture-product-proof.md

```text
Continue the Momora v2 revamp. Phase 3: capture real product proof for all seven frames.

Read MASTER-BRIEF.md, v2 state, the claim/entitlement matrix, asset checklist and canonical copy. Use recorded project paths and safe existing capture tooling. No imaginary UI.

Capture actual current components on required iPhone/iPad layouts. A local fixture may supply demo data; it may not invent controls, remove limitations or count as production rollout proof. Label native, fixture, web, renderer-export and mockup sources.

Build the asset pack for:

01 DIGITAL VALUE: a populated timeline/collection with separate real photo, story and sound memories. Use a truthful inset when they do not fit one viewport. No print object or unsupported all-in-one memory card.

02 EXISTING PHOTOS: older accessible photos in an actual suggestion with a complete grounded draft caption and Keep/Set aside controls. Capture its approved saved result for use in 01/07.

03 STORIES: a real short composer entry and its corresponding illustrated memory. Reuse cleared ladybug assets when valid. This is not an automatic illustration of imported photographs.

04 SOUND: a genuinely kept sample recording in the playback/detail view, with duration and caption. Verify playback where possible. Dictation/transcription alone is not the retained-audio feature.

05 OPTIONAL BOOK: real generated pages/cover containing saved sample material, the actual in-app book entry and truthful website preview context. Prefer a cleared photograph of the printed sample; otherwise prepare an accurate mockup from the genuine print output. Do not invent materials or a fake native editor.

06 FAMILY: actual member/invite controls with fictional safe account details and real role differences; optionally a separately captured shared-memory interaction. Never show a live invite token, real email or private customer data.

07 LOOK BACK: a genuine per-child collection or complete saved memory that revisits a previous sample. Do not require an unshipped recap/widget/search feature or manufacture a perfect calendar.

Also collect owner-export/post-lapse evidence for the description and optional separate trust-slot test.

Maintain three truthful paths:
- Photos -> suggestion -> approved saved memory -> revisiting; optional print reuse.
- Short story -> corresponding illustration.
- Kept sound -> actual playback/card.
Do not force the first three images into a photo-to-book funnel. Never combine unsupported audio/photo/illustration types to make a prettier demo.

Use consistent fictional identities/dates and approved media. Captions cannot assert unrecorded milestones, names, locations or backstories. No customer's photo/voice is cleared just because it is in the repo.

Inspect script/environment side effects. No production seed/reset, real order, billable generation or secrets in files/logs. Reuse approved outputs and local fixtures first.

Save raw captures separately. Write an asset manifest with source, semantic purpose, route/renderer, revision/device, fixture status, approval basis, source IDs and reuse destinations; no secrets.

For missing access/assets, continue independent work and issue one exact capture request per gap: route, device, state, missing input, filename and replacement action. Keep placeholder/uncaptured evidence visibly draft-only and out of final manifests.

Finish with actual assets, provenance, reproduction instructions, precise blockers and updated state—not just instructions for a future designer.
```

## Prompt 04 — 04-render-full-listing-and-variants.md

```text
Continue the Momora v2 revamp. Phase 4: implement the compositor and render the full set.

Read momora-listing-handoff-v2/MASTER-BRIEF.md, v2 state, canonical copy and verified asset manifest. Reuse existing rendering code and good captures. Replace old scene-order/strategy logic; do not rebuild working infrastructure unnecessarily.

Use current Momora typography/tokens, cream/lavender warmth, dark serif headlines, restrained pink, small wordmark and watercolor character. Give each benefit a fitting composition within a consistent system. Real useful UI is larger than device chrome; text remains editable in source.

Render ALL seven default frames using the master brief:
01 Keep more than / the photos.
   A meaningful digital collection, with real distinct photo/story/sound evidence.
02 Start with the / photos you have.
   Actual grouped suggestion, draft caption and approval choice.
03 For the things / a photo missed.
   Real short story input and matching optional illustration.
04 Keep their / little voice, too.
   Actual saved-recording playback, valuable without a book.
05 And a book / to hold, too.
   Real automatically arranged pages/physical output and genuine app context;
   “Printed books sold separately. Shipping extra.”
06 For your family. / Not a public feed.
   Actual invitations/roles and chosen-family connection.
07 Here when you want / to look back.
   A complete genuine memory or child collection, not print checkout.

Use exact registry support/disclosures with verified factual adjustments. Do not make frames 1–4 book-led. If frame 5 is hidden, the remaining set must still make a reason to subscribe and return obvious.

Follow separate photo, story and sound provenance. Reuse the photo event in 02/01/07 and optionally 05; do not force 01–03 into a book funnel or fabricate a combined memory type. Website preview remains visibly web. Never use generated imagery for UI, final text or book pages.

Reuse the existing generator or make a minimal isolated HTML/CSS/React compositor around genuine captures. Implement reusable typography, tokens, framing and truthful magnified insets, with per-slide configuration. Do not copy product controls into a fictional marketing interface.

Wait for fonts/assets, fail on missing inputs and implement reproducible render/validate/preview commands. Do not silently upscale flattened old PNGs. Keep source-only tooling outside shipping runtime behavior.

Verify current accepted sizes. Render opaque RGB PNGs with no alpha for the required 6.9-inch iPhone slot (e.g. 1320x2868) and genuine native 13-inch iPad layouts when supported (e.g. 2064x2752 or 2048x2732). Do not stretch iPhone UI or disable iPad support.

Render two isolated first-image challengers from registry copy:
A. Your camera roll. / Their stories.
B. Their little voice. / Yours to hear again.
Both explain the digital app. Keep default frames 02–07 byte-identical and demonstrate equality with hashes. Keep ordered challenger manifests separate from defaults.

The ownership frame may be rendered as a separate optional slot-7 test when evidence exists. Book-first/effort-first output is NOT required or authorized as the default; a true book-led experiment is deferred. Do not silently reuse old challenger files.

Create a local gallery, all-seven contact sheets, first-three rows, ~390px single-card previews and 120–140px-per-card legibility diagnostics. Review previews are not upload masters.

Open EVERY default and challenger full-size and reduced. Fix legibility, crop, line wraps, consistency, clutter, exaggerated mockup geometry, unclear cost separation and old strategy remnants. Re-render and inspect again.

For unavailable captures, complete independent source work and quarantine visibly marked drafts. Do not call them final. Finish with actual renders, editable source, commands actually run, previews/manifests, blockers and state. A template or three rendered frames is not completion.
```

## Prompt 05 — 05-independent-qa-and-release-pack.md

```text
Perform independent final acceptance for the complete Momora v2 listing. This is phase 5. Prefer a fresh session in the SAME checkout. Read files and inspect images rather than trusting prior completion messages.

Read MASTER-BRIEF.md, COMMERCIAL-CLARITY.md, REBASE-FROM-V1.md, v2 state, current copy, evidence matrix, asset manifest, renderer and all output files. Fix listing-scope failures you can repair locally.

Verify:

1. APP VALUE WITHOUT PRINT
Hide frame 5 and the print paragraph. Does the listing still explain a useful paid app for photos, stories, sound, easier import, revisiting and chosen-family connection? The first three frames must not depend on a future printed result. Record your assessment as a review, not a customer-research finding.

2. COMMERCIAL UNDERSTANDING
Print is optional and separately charged with shipping extra. No included book/credits, annual print plan, free ongoing writes or implicit print deposit. Exact dollar reference amounts are not frozen into global copy. Generation/review entitlement and live/localized terms are verified or clearly unresolved. No tiny disclaimer rescuing an otherwise misleading promise.

3. COPY AND FACTS
Natural parent language; no guilt manufacture, fictional reviews, false privacy or unmeasured speed/permanence. Validate literal character/byte limits, registry/export equality, version-appropriate notes and required real links. Check retained audio versus dictation, audience roles, owner export and post-lapse reading.

4. VISUAL TRUTH AND QUALITY
Open each image at full and reduced size. Check genuine native UI, source provenance, complete readable sample text, correct picture/story/recording relationships, truthful website handoff, actual book output, legible disclosure, margins, crops and device framing. No unsupported all-in-one card or invented search/recap.

5. TECHNICAL COMPLETENESS
All seven defaults and both digital-value opener challengers for required device families, genuine native iPad where supported, accepted dimensions, opaque RGB/no alpha, loaded fonts/assets and working commands/previews. Do not label missing images complete.

6. MIGRATION AND EXPERIMENT INTEGRITY
No active old book-led title/subtitle/description, order, hero or effort-first variant survives in default templates, tests or manifests. Historical/deferred references may remain only when clearly labeled. Required opener treatments change only frame 1; hashes of 02–07 match. Ownership/sequence/book-first tests stay separate and optional/deferred.

7. SAFETY AND SCOPE
No credentials, active invite codes, private customer data, unapproved spending or production changes. Review the diff for unrelated runtime/onboarding/paywall/pricing changes. Run relevant safe checks for code touched; never run paid/live-network tests merely to claim coverage.

Repair failures, rerun validation and re-open repaired images. Log unavailable live checks as unverified, not passed. Cosmetic quality is not proof of working production flow or willingness to pay.

Package using an explicit allowlist manifest, never a wildcard over every PNG. Deliver:
- Final proposed metadata text and count report; required-link/release-note gate status.
- Seven ordered default images per required device family.
- Separate opener challenger manifests and optional ownership treatment, never mixed into default upload files.
- Editable source, exact commands actually tested and review-gallery paths.
- App Store Connect field/locale/device/order mapping and hashes.
- QA report: checks actually run, images actually seen, repairs, failures/unverified items.
- Owner sign-off checklist: live features, membership/print separation, localized offer, preparation entitlement, shipping/rights/legal info and final visual approval.
- Review-note guidance for reviewers to find import, audio and book online review/order; no credentials in tracked files.
- An experiment plan centered on understood paid membership, useful activation, repeat app use and retention; print orders are additional. Do not assume a PPO-to-user join or description-test controls. No invented uplift or fixed stop-after-one-week rule.
- Product-funnel observations about access to the promised digital features and separate print charge; no unapproved product redesign.

Release status must be one of locally validated, awaiting owner/live checks, or blocked. Keep original material for rollback. Exclude drafts, placeholder media, contact sheets, raw private data, fonts, secrets, stale exports and unselected experiments from release archives.

Do not upload, publish, submit, push, merge, change prices or order a book. Finish with exact deliverable paths, a short v1-to-v2 summary, commands run and only genuinely unresolved owner actions. Update state based on work actually completed.
```


---

# Momora — complete App Store listing revamp, v2

**Version:** 2.0-memory-first • **Prepared:** 20 September 2026 • **Repository:** `eduardoyi/newmomora` • **Default locale:** en-US

## Binding revision: the app has value before and without printing

This document supersedes the book-first positioning, description, metadata, screenshot order, challenger definitions and acceptance tests in the previous handoff. Do not blend the two strategies. The old six PNGs remain visual references, not the new storyboard.

**Core promise:** Keep and enjoy their photos, stories and little voice together, without another demanding task.

**Default headline:** Keep more than the photos.

**Decision test:** Hide the book paragraph and the book screenshot. The remaining listing must still explain a meaningful reason to subscribe to, use and return to Momora.

The app is not a paid waiting room for a printed book. Gallery import provides a useful digital collection now. Stories, saved sound, optional illustrations, revisiting and family connection are outcomes in their own right. A printed book is a substantial optional extension, shown in default slot 5. Do not hide printing, make it seem included, or position it as the only payoff.

The owner says the app is **$99/year** and an optional printed book is **another $99 plus shipping**. These are owner-supplied reference amounts, not verified storefront prices or permission to change prices. Do not silently substitute an older repository price, assume a currency code, call the app a print deposit, invent book credits, or bundle a book into membership. Record exact localized price/entitlement questions for owner checks. The membership entitlement for generating/reviewing a book still needs verification before calling it included or free.

The customer research supports remembering the ordinary stories/sounds and removing work; it does not validate the annual price or prove that either the app or the printed book is the “real product.” Its recommendation to monetize the artifact remains source material, not an instruction to alter this business model. Tinybeans/BackThen provide examples of broader app positioning with print inside it, not proof of superior conversion. Book-first stays a deferred test hypothesis.

## Scope and authority

Produce actual implementation files for the complete listing: all store text, seven new default screenshot compositions, native iPhone and iPad exports when supported, two digital-value opening challengers, editable source/render tooling, local previews, validation and a manual release handoff.

Do not publish to App Store Connect, submit a build, push/merge changes, change subscriptions, create physical orders, spend money on AI generation, or mutate production customer data. Work on the user's task branch/worktree and preserve unrelated edits. Do not redesign onboarding/paywalls, change the icon/wordmark, modify bundle IDs, disable iPad support or rewrite app functionality to make the listing truthful. Report product-funnel gaps separately.

Read AGENTS.md and applicable nested development/security instructions. Use current code and runtime evidence for product facts. Use this v2 brief for listing strategy and the v2 copy registry for proposed wording. A conflict about factual behavior must be logged and corrected; a stale “planned” index entry is not conclusive release evidence. “Approved direction” does not mean the exact new wording or runtime behavior has been individually signed off.

### Start or migrate

Run `prompts/00-rebase-existing-work.md` first, even on a fresh checkout; it is a short no-op migration when no v1 work exists. Then run 01–05 in the same checkout. A fresh phase-5 reviewer must read the persisted evidence, not rely on chat memory.

Do not overwrite an existing project state with `state.example.json`. Merge safe non-secret paths and provenance into a new v2 state, and re-open affected completion gates. Preserve good captures, renderer code and metadata conventions; recheck their relevance and freshness. Archive old public-copy exports and final-image manifests from the active release set without destroying source work. `REBASE-FROM-V1.md` specifies the mapping.

## Included materials and precedence

- `approved-listing-copy.json`: v2 source of truth for proposed public metadata, seven frames, disclosures, challenger copy and deferred tests. The legacy filename is retained for tooling compatibility; read its status/version.
- `copy/en-US/`: literal text exports of that registry. They are proposed, not already released; release notes and keyword selection have their own verification gates.
- `reference/momora-app-store-conversion-review.md`: fully revised human report; no old book-first report is an active authority.
- `reference/voice-of-customer.md`: unchanged supplied research. Preserve its evidence caveats and terminology; do not turn its quotes into Momora endorsements.
- `reference/current-screenshots/`: six unchanged original PNGs for visual comparison.
- `COMMERCIAL-CLARITY.md`, `REBASE-FROM-V1.md`, `prompts/` and `tools/validate_handoff.py`: implementation instructions and local handoff checks.

Do not restart market research or invent a new strategy during implementation. Resolve missing details from the checkout, then ask only for genuinely unavailable inputs. This is a full text/images revamp, not a request for another high-level plan.

## Why someone subscribes — the explanation to make visible

| Experience | Value before a printed book |
|---|---|
| Import suggestions and drafted captions | Existing photos become reviewable, meaningful memories without manually starting an empty journal. |
| Short notes and dictation | Keep what happened or what they said without writing a polished entry. |
| Saved audio | Hear the actual little voice again. A transcript is a different output. |
| Optional illustrations | Give a remembered story an image, including moments without a photograph. |
| Per-child collections and revisiting | Return to photos, words and sounds in the app. Do not promise unsupported search or recap features. |
| Family invitations and sharing | Let chosen people participate within actual permissions. |
| Automatic book arrangement | When desired, turn saved material into a separately purchased physical copy without designing every page. |

Do not replace this with a long “we have many features” list or a justification based on the company's AI costs. Show what the parent can enjoy. A book that never gets ordered must not make the subscription look unfinished.

## Copy and brand rules

Use short, ordinary sentences. Recognize a situation, then explain the help. Use photos, camera roll, stories, their little voice, when you have a minute, and baby book specifically for the print benefit. “Family memories” is acceptable category language; “AI memory journal” and “legacy product” are not the lead.

Avoid “Enter Momora,” “everyday magic,” “Why Parents Love Momora,” “The Result,” guarantees of remembering everything, permanent storage, instant processing, one-tap completion, guilt countdowns, sibling comparisons, fake ratings and invented user counts. Do not imply every moment must be documented. Demo anecdotes are examples, not testimonials or AI-recovered facts.

Keep the current cream/lavender warmth, dark serif headlines, pink accent, small wordmark and watercolor identity. Inspect actual tokens and assets; use the repository's licensed font setup rather than approximations. The previous checkout declared Newsreader, Plus Jakarta Sans and Caveat; confirm present roles. Handwriting is decoration, not the sole explanation of a benefit.

Meaningful product evidence should dominate. Do not simply paste new captions on the old paintings. Avoid a giant device surrounding tiny unreadable content, seven identical templates, abstract icon grids or a new generic visual identity. A flexible starting point is an upper message area with one dominant result underneath; it is not a rigid layout percentage or a proven conversion rule.

## Known paths to inspect, not assumed release facts

Read `AGENTS.md`, nested instructions, `package.json`, `app.json`, any existing store/screenshot tooling and the relevant implementations behind:

- `docs/features/gallery-import.md`
- `docs/features/memories.md`, `media-memories.md` where present
- `docs/features/voice-journaling.md`, `audio-memories.md`
- `docs/features/family-profiles.md`, `family-sharing.md`, `calendar.md`
- `docs/features/data-export.md`, `subscriptions.md`
- `docs/features/memory-book-generation.md`, `memory-book-orders.md`
- `book-renderer/`, `.maestro/`, design tokens and safe demo assets

These references were inspected in the earlier review, not live-tested by this handoff. Follow current implementation references and label code evidence, runtime observation and production confirmation separately. Do not introduce a dependency on a possibly unshipped Looking Back/widget feature just to make slide 7 more impressive.

The earlier app.json enabled iPad support. Verify current device families, then include genuine iPad layouts when still supported. Do not switch off tablet support to reduce production work.

### Product boundaries

| Area | Truthful scope | Do not imply |
|---|---|---|
| Gallery | Permission-based accessible-photo review; suggested events/captions; parent approval. | Automatic approval, camera-roll cleanup, every cloud photo covered, instant unlimited processing or continuous work with the app closed. |
| Gallery privacy | Original camera roll unchanged; documented small previews uploaded for AI before review. | Entirely on-device processing, zero third parties, no upload before approval, or end-to-end encryption. |
| Input/output types | Photos remain photos; text can have an optional illustration; a kept sound is a separate memory type. | One unsupported card combining imported photos, saved audio and an illustration; automatic photo-to-illustration import. |
| Stories and milestones | Save user-provided facts and use correct sample context. | AI recovers unrecorded words, locations, relationships or a first-ever milestone from a picture alone. |
| Audio | Keep the actual clip through the retained-audio flow. | Every dictated note retains sound; a physical book plays audio or contains audio QR codes. |
| Family | Actual role-based invitations/approval and per-child memories. | Every invitee can edit/export/order; private means cryptographic guarantees; photos never leave the device. |
| Return visits | Real collections, timeline, calendar or saved detail views. | An invented global search, filter, recap or audio grouping not supported by the build. |
| Read/export | Documented saved-content access after lapse; family-owner export. | Forever availability, unlimited exports, all members' export rights, or new writes/AI remaining free. |
| Print | User chooses child/time, reviews generated pages online and purchases print separately. | Included print credits/book, automatic purchase/shipping, imaginary native editor, unverified delivery times/materials or worldwide shipping. |

A feature not captured yet is a blocker for that proof, not permission to invent it. Continue independent work. If the code changes a claim, make the smallest evidence-supported copy correction and explain it. Do not remove the app-first strategy to work around missing captures.

## Store metadata

Use the v2 JSON and regenerate all public-field outputs from one canonical registry:

- **Name:** Momora: Family Memories
- **Subtitle:** Photos, stories & their voices
- **Promotional text:** the digital-value copy in the registry; printing does not lead this field.
- **Description:** the complete v2 description; it establishes photos/stories/sound/revisiting before the optional print paragraph.
- **Keywords:** relevant candidate terms, not validated volume/ranking claims. “Baby book” language is not banned from relevant query coverage; it simply does not define the default offer. Preserve other locales and do not add competitor brands.
- **What’s New:** use the proposal only in a release to which those changes belong. Do not call already released features new in an unrelated release.

Preserve verified existing support/privacy/marketing/Terms links and required subscription/legal wording. Discover the actual links and requirements; do not invent them. Missing required release information is a gate, not a placeholder to hide in public text.

Count actual exported strings with a script: app name and subtitle ≤30 characters, promotional text ≤170, description and What's New ≤4000, keywords ≤100 UTF-8 bytes. Verify current official rules before implementation. The marketing overview and field specification describe keywords differently; the byte validator is the conservative field-specific check. No HTML/Markdown delimiters, comments or internal research notes belong in public fields.

Exact dollar figures stay in internal commercial context and appropriate verified/localized pricing explanations, not frozen across global screenshots or the description. Apple advises against specific description prices. Keep clear subscription/separate-print language in public copy. Do not add long boilerplate to every image or label post-lapse reading as requiring an active subscription.

## Seven default screenshots — exact jobs and compositions

Use the v2 registry headlines/support/disclosures. Natural device-specific line reflow is permitted; substantive changes require a documented reason. Each image stands alone. Default frames 1–4 have no physical book as their dominant subject; slot 5 is the only dedicated print frame.

### 01 — Keep more than the photos.

**Support:** Their stories, funny words and little voice.

**Question answered:** What will this app give me even when I never order a book?

Use a genuine populated Momora timeline/collection with a real photograph memory and a complete short story, plus a genuine sound card or a clearly labeled cropped detail. One strong app view is better than three tiny overlapping phones. If the real viewport cannot contain all types, prioritize the readable photo/story collection and use a separate honest inset for the saved sound; do not manufacture an all-in-one memory card.

The digital collection is the finished result here. No physical book, checkout, “pages ready” badge or arrows ending in print. Portraits/illustrations can add Momora character, but should not dominate as if this were an art generator. Use demo content that looks like ordinary life, not a feature test grid.

Acceptance: a parent can explain that Momora keeps their pictures, what happened and actual recordings together. The screenshot should not require a future print order to make sense.

### 02 — Start with the photos you have.

**Support:** Moments grouped. Captions drafted. You choose what to keep.

**Question answered:** Do I need to begin an empty journal and label everything myself?

Use the actual gallery suggestion deck: related older photos, one complete grounded draft caption and current Keep/Set aside controls. A source-photo strip is optional; hundreds of thumbnails are not useful. The earlier documented deck is read-only until Keep opens the composer; do not draw a fictional editable field into it.

Show the same source event already saved in frame 1 or revisited in frame 7. This is a useful collection now, not “step 1 of buying a book.” Do not auto-approve, claim phone storage cleanup, invent identifying context or show gallery import converting photographs into watercolor.

### 03 — For the things a photo missed.

**Support:** Say what happened. Add an illustration.

**Question answered:** What about the little thing they said when I did not take a picture?

Show a real short typed/dictated composer entry and the corresponding illustrated memory. Reuse the ladybug input/output when available and cleared. A shorter demo line is “She asked if the ladybug had a mommy looking for it.” It is not a customer testimonial. Text and output must genuinely correspond; keep the sample's underlying facts consistent.

Use a main result with a readable input crop, not two full phones. The illustration is optional visualization, not evidence the event occurred or a photo reconstruction. Do not claim a ten-second complete process. This is a separate story path from the photo-import example in frame 2.

### 04 — Keep their little voice, too.

**Support:** Save the recording, not just the words.

**Question answered:** Can I actually hear the sound again?

Use the actual saved sound-memory player with a visible duration and a short caption. A mic symbol, recording modal or transcript alone does not prove saved playback. Use a legitimate cleared sample clip and verify playback when the environment permits.

The digital recording is already the valuable result. Distinguish retained sound from dictation that discards audio. Do not imitate an identifiable child's voice, expose customer audio, imply an unsupported audio/illustration combination or connect playback to the printed book.

### 05 — And a book to hold, too.

**Support:** Momora selects the memories and lays out the pages.

**Disclosure:** Printed books sold separately. Shipping extra.

**Question answered:** Can I also get these memories off my phone without designing the pages?

Give this benefit a strong, substantial frame: an actual generated cover/open spread paired with the genuine in-app book entry. Prefer a cleared photo of the real printed sample. Otherwise use an accurate presentation mockup with real print-file pages and verified geometry. Do not invent binding, paper thickness, lay-flat construction or a delivered specimen. Label the mockup in production records.

The spread should show useful selection/grouping and readable words, not a grid of tiny pages. Use the same saved event from frames 1/2/7 where feasible. A milestone must be supported by the saved material. When browser review is visible, show its true browser context; never draw a fake native editor.

The parent chooses scope, reviews online, makes permitted edits, orders and pays. No included book or credits, no automatic purchase, no fabricated delivery promise. Keep the print purchase disclosure readable. Do not call generation/review included in membership until the entitlement is verified.

This frame is not the grand finale of a mandatory funnel. Frames 6–7 deliberately return to ongoing value inside the app.

### 06 — For your family. Not a public feed.

**Support:** Invite only the people you choose.

**Question answered:** Can the people I choose share in this without making it public?

Use genuine member/invite controls with fictional names and actual roles, plus an optional separately captured shared memory if it clarifies the benefit. A recognizable family interaction is better than a padlock icon or a security marketing badge. Do not use active invite secrets, real email addresses or private customer data.

Do not imply everyone can edit/order/export. In the documented product, owner/manager and viewer permissions differ. Avoid invented push/email recaps and unverified free seats. Audience control does not mean on-device or end-to-end encrypted processing.

### 07 — Here when you want to look back.

**Support:** Photos, stories and sounds, together for each child.

**Question answered:** Why will I return to the app after the first import?

Use an actual per-child collection or a complete saved-memory view, with a supported sound tile/player only where it really exists. Revisit a moment seen earlier in the set. Make a short complete story readable; a page of truncated rows or an empty calendar date does not establish the value.

Do not invent search, recaps, reminders or widgets. If the best production view has a habit indicator, choose another honest view or crop context; do not erase meaningful controls or manufacture perfect attendance. End on recognition and enjoyment, not a print checkout or a warning about running out of time.

Owner-only export and post-lapse read access remain in the description and trust evidence. They can be a separate seventh-slot experiment, not the default ending.

## Evidence continuity without a fake single workflow

Reuse one cleared demo family and consistent dates, names and record scopes. Maintain separate valid paths:

- **Photo path:** frame 2's accessible photos → approved saved memory in frame 1 → revisiting in frame 7 → optional appearance in frame 5's book.
- **Story path:** frame 3's real note → its corresponding illustration, optionally also present in the collection.
- **Sound path:** frame 4's kept recording → an actual sound card/tile in the collection where supported.

The old instruction to make frames 1–3 an uninterrupted photo-to-book chain is withdrawn. Do not conflate all these media into one unsupported card. Maintain semantic source IDs and provenance across reused assets.

## Capture, tooling and output standards

Inspect and reuse existing screenshot tooling, native captures, fixtures and renderer. Demo scripts may call production, reset data or spend money; inspect environment targets and side effects first. Never run a script just because the name contains “demo.”

Native fixtures can supply data to production components without inventing UI. Record whether a source is a native runtime capture, local fixture, website capture, generated book export or presentation mockup. A fixture does not prove a feature is available in the live app. Do not repurpose real customer media or assume repository presence grants marketing permission.

A minimal isolated HTML/CSS or React tool may compose real assets, typography, backgrounds and device framing. It must not render invented product functionality. Never use an image generator for final UI, book pages or text. Keep editable copy/configuration separate from captured pixels. Re-render masters from source instead of upscaling flattened old screenshots.

Use actual required iPhone device slots and, when supported, native iPad layouts. Initial portrait targets: an accepted 6.9-inch iPhone set such as 1320×2868, and an accepted 13-inch iPad set such as 2064×2752 or 2048×2732. Recheck Apple's live specifications. Do not stretch phone UI to fill tablet dimensions. No need to export every historical size without a real slot requirement.

Finals: opaque RGB PNGs, no alpha, correct dimensions/color profile, loaded fonts/assets and no stray environment overlays. Reuse repo-licensed fonts locally; never bundle unrelated system font files. Keep raw captures, source, review previews, drafts, masters and upload packages separate.

Create a local preview gallery, all-seven contact sheets, first-three rows, roughly 390 CSS-pixel single-card views and 120–140-pixel-per-card legibility diagnostics. These are review aids, not claims about universal App Store layouts. Open every exported frame at full and reduced size and fix defects. A contact sheet alone is insufficient.

Implement and actually run render/validate/preview commands. Await fonts/images, check for source errors and fail clearly rather than write blank finals. Keep tooling isolated from shipping app behavior; do not add a second pipeline unnecessarily.

When native access or cleared assets are missing, finish independent work and provide exact capture requests: route, device, demo state, missing input, expected file and replacement step. Draft placeholders must be visible and excluded from any upload manifest. Do not certify blocked frames as done.

## Challengers and deferred tests

**Produce two opener challengers**, each replacing only frame 1:

1. **Existing-photo-first:** Your camera roll. / Their stories. Support: Moments grouped, captions drafted. You choose what to keep.
2. **Voice-first:** Their little voice. / Yours to hear again. Support: Keep photos, stories and recordings together.

Both sell a digital outcome, preserve the actual subscription offer and use the same brand/source family. Keep frames 2–7 byte-identical across these sets and prove it with file hashes. Interpret as opener tests, not complete business-model comparisons.

**Optional separate frame-7 challenger:** Your memories / stay yours. Support: Read and export, even after your subscription ends. Qualify family-owner export and verify the behavior. Do not combine with opener changes in the first test.

**Deferred, not required for production:** Move the unchanged book frame to slot 3 to test prominence (order 1,2,5,3,4,6,7). This is a sequence test, not a one-frame test. A truly book-first concept is also a hypothesis, not the default or a presumed winner; obtain an owner decision before producing/running it. Explain both purchases in the same real offer and check expectation accuracy. Do not automatically restore the old effort-first/book-first treatment files.

Use the same verified/localized pricing context in comparisons. A price-free concept interview cannot resolve the owner's concern about paying for the app and then paying for printing. Test “What does membership give you without printing?” and “Is a printed book included?” separately from preferences.

## Metrics, release gates and non-goals

The primary business question is understood, useful paid app membership—not simply installs or first book orders. Recommend first kept memory, time to useful collection, saved-sound playback, return to memories, invited-family participation, subscription conversion/retention and expectation-related support/refunds. Print purchases are an additional outcome. Book buyers versus non-buyers are observational groups, not automatically causal evidence.

Do not fabricate analytics instrumentation, a PPO treatment-to-user join or completed tests. Verify current native experiment controls before promising description testing, attribution or segmentation. Record experiment scope, source, locale, denominator, uncertainty and simultaneous releases. Inconclusive is a valid result; do not stop at the first positive point estimate or promise 10×.

Use a manual positive upload manifest: exact locale, device, sequence, filenames, variant and hashes. Exclude drafts, original assets, contact sheets, raw media, fonts, credentials and unselected experiments. No submission is authorized.

Final acceptance:
1. Frames 1–3 explain meaningful digital value and an easier start without depending on printing.
2. Removing frame 5 and the print paragraph leaves a coherent reason to subscribe and return.
3. Frame 5 demonstrates automatic book creation and plainly separates printing/shipping charges.
4. All seven default frames and two opener challengers exist for each required device family, or have precise blockers; only verified complete assets reach a release candidate.
5. Copy matches current behavior and fits real field limits; exact price/entitlement/legal checks are honest.
6. Source media paths do not imply unsupported combinations, AI facts or a fake native book editor.
7. UI is genuine, demo data cleared, fonts/images load, native tablet layouts are respected, and every frame is inspected at usable sizes.
8. v1 headline/order/variant/acceptance logic is absent from active default registries, tests and manifests. Historical migration notes are clearly labeled.
9. Editable sources re-render using commands actually run. No made-up performance, runtime verification or store approval.
10. Nothing was published, ordered, charged, deployed or changed in product pricing/identity as a side effect.

## Official rules to verify at implementation time

- Product page: https://developer.apple.com/app-store/product-page/
- Field definitions: https://developer.apple.com/help/app-store-connect/reference/app-information/platform-version-information/
- Screenshot specifications: https://developer.apple.com/help/app-store-connect/reference/app-information/screenshot-specifications/
- Review guidelines (especially 2.3.2, 2.3.3, 2.3.9): https://developer.apple.com/app-store/review/guidelines/

The revised report preserves prior practitioner findings and clearly separates them from this pricing-aware strategy revision. No new customer test or Momora conversion result is asserted.


---

# Commercial clarity — v2

## Owner-supplied context, not a verified live price feed

The owner states: app membership **$99/year**; an optional printed book **$99 plus shipping**. A first-year customer purchasing one book would therefore spend **$198 plus shipping**, using those reference amounts. Do not treat this arithmetic as a global quote, a promise about taxes, a universal print specification or evidence that the price is too high.

The concern to solve is expectation: a print-led page could make membership seem like a fee to unlock a second purchase. This is a risk hypothesis, not measured customer behavior. The app must have a clear useful experience even if no book is ever ordered.

## What the listing must distinguish

**App membership:** keeping new photos/stories/sound, import suggestions and applicable AI features, and a collection parents can enjoy and share under actual family permissions. Map precise entitlements from the build. Do not claim unlimited usage or free invited seats without evidence.

**Optional physical purchase:** a printed book and shipping. No included copy, book credits, print deposit or mandatory print commitment.

**Book preparation:** verify whether generation and online review/editing are included in membership before saying so. Do not invent free PDF downloads or an included digital book product.

**After membership ends:** the previously documented archive remains readable; the family owner can export. Verify scope and operational limits. This is not forever storage or free new writes/AI.

## Public wording

Description: “An active subscription is required to add memories and use AI features. A printed book is not included in the subscription. Book prices and shipping charges are shown at checkout.”

Book screenshot: “Printed books sold separately. Shipping extra.”

Use a proportionate subscription qualifier on featured paid app actions. Do not label read-only post-subscription views as paywalled. Preserve actual required legal disclosures.

Do not freeze exact dollar amounts into global store screenshots, name/subtitle or the description. Apple's product-page guidance advises avoiding specific description prices because they may differ by region. Verify localized amounts, cadence, tax and print scope on the actual pricing/paywall/checkout surfaces; do not modify those surfaces in this listing task.

## What to ask in comprehension checks

Show the same actual localized commercial context with each concept. The owner's reference wording is “App membership: $99/year. Optional printed book: $99 plus shipping.” Verify before using it as an offer. Ask what membership gives them when no book is purchased, whether print is included, what work remains, and what they would return to in the app.

Do not lead respondents toward printing or hide the separate charge until after preference selection. A book-first winner must win with informed expectations, not only more downloads.

## Owner gates before publication

Confirm the exact annual SKU/offer and eligible trial, currency/locale, whether $99 print is fixed or varies by book/page count, taxes, supported shipping territories, print-generation/review entitlement, active paid-feature scope and post-lapse access. Record unresolved details; do not fill gaps with repository defaults.

No pricing, subscription, checkout, shipping, legal, product or business-model change is authorized by this document.


---

# Migrating ongoing work from the book-first handoff

**v2 supersedes v1 strategy and active listing specifications.** It does not require throwing away correctly captured assets or a working compositor. Preserve unrelated edits and keep original files available for rollback.

## Safe starting point

Keep this folder named `momora-listing-handoff-v2` next to any old folder. Do not unzip over the old folder/state. Run `prompts/00-rebase-existing-work.md` first. On a fresh checkout, establish v2 state and continue; do not invent prior work.

If old instructions were pasted into an ongoing agent session, explicitly tell it to discard that book-first assignment and read this brief. Do not execute both prompt sequences or send them to dependent parallel worktrees.

## Preserve after inspection

Native captures, demo media with valid approval, product evidence paths, actual generated book pages, renderer code, tokens, dependency setup, device mappings and working preview/validation infrastructure can be reused. Recheck build freshness, media rights and provenance. Do not trust an old pass flag as a current acceptance result.

## Replace or revalidate

| Old item | v2 action |
|---|---|
| “Your photos. Their baby book.” default hero | Replace with the digital collection and “Keep more than the photos.” |
| Book-led app name/subtitle/promo/description | Regenerate every public field from the v2 registry; title/subtitle no longer define the app through print. |
| Old 01 book output + old 03 layout | Reuse genuine book material in new 05, not as two opening frames. |
| Old 02 import | Reuse in new 02; its outcome is a useful in-app memory, not a mandatory print step. |
| Old 04 story illustration | Reuse as new 03 after checking input/output correspondence. |
| Old 05 saved voice | Reuse as new 04; show independent replay value. |
| Old 06 per-child books | Reuse relevant child collection assets in new 07; do not make another print frame. |
| Old 07 export | Keep evidence and description reassurance; optional new 07 ownership challenger. |
| Old optional privacy image | Upgrade to default 06 after checking actual permissions and safe demo data. |
| Old effort-first and book-led backlog openers | Exclude from active default/required challenger manifests; label historical, not authorized treatments. |
| First-three photo-to-book continuity | Replace with photo→saved/revisited memory, separate story→illustration, separate recording→playback. |
| Book-order-centered metrics | Lead with paid app understanding, activation, revisiting and retention; printing is additional. |

Find hard-coded old titles, order arrays, scene IDs, crop assumptions, captions, test fixtures, validator assertions, README links and upload globs. Matching a filename is not enough: verify each source's actual semantic use.

Do not do a destructive global replace or rename shared product files. Use the chosen existing listing paths and explicitly replace the active registry/export/manifest outputs. Archive only listing artifacts identified as superseded. Update references and tests along with the copy.

## State migration

Create `momora-listing-handoff-v2/state.json` by merging relevant non-secret project paths from old state. Record v2 version and a migration history. Keep original state unchanged. Mark copied implementation evidence “requires v2 review” until rechecked. Reopen copy, final compositions, variants, manifests and QA gates. New v2 acceptance is not satisfied by old “complete” fields.

## Stale-content gate

Scan only active public-copy/default-layout/required-test/manifest paths for the v1 strategy and old slide IDs. Exempt explicitly labeled change logs and deferred-test specifications, not public upload files. The old vocabulary can appear as documented history, never as a restored default.

The full original research synthesis stays unchanged; it is evidence, not an authority to overwrite the owner's revised business-model decision.


---

# Exact v2 copy registry

```json
{
  "schema_version": 2,
  "brief_version": "2.0-memory-first",
  "date": "2026-09-20",
  "strategy": "memory-first",
  "status": "proposed_copy_under_approved_direction_pending_product_and_release_checks",
  "locale": "en-US",
  "note": "Supersedes the book-first v1 copy. These are proposed implementation inputs, not live metadata, individually approved wording, or proof of conversion performance.",
  "core_promise": "Keep and enjoy their photos, stories and little voice together, without another demanding task.",
  "independent_value_test": "Hide the optional book section and frame: the app must still have an understandable reason to subscribe and return.",
  "name": "Momora: Family Memories",
  "subtitle": "Photos, stories & their voices",
  "promotional_text": "Start with the photos you have. Keep the stories and little sounds, too. Momora groups photos and drafts captions for you to review.",
  "description": "The photos are on your phone. The little things are harder to keep.\n\nThe question from the back seat. The word they say their own way. What was happening just before everyone started laughing.\n\nMomora brings your photos, stories and recordings together, so there’s more to look back on than a camera roll.\n\nSTART WITH THE PHOTOS YOU HAVE\nYou don’t have to fill an empty journal from scratch. With your permission, Momora looks through your photos, groups them into suggested memories and drafts captions. Keep the ones you like, change a few words, or leave them out. Your camera roll stays as it is.\n\nFOR THE THINGS A PHOTO MISSED\nWrite a few words or say what happened while it’s still fresh. No need to make it sound special. “He packed crackers in case the playground got hungry” is already worth keeping.\n\nYou can turn a story into an AI illustration, too, using your family’s character portraits.\n\nKEEP THEIR LITTLE VOICE\nThe way they say “banana.” Their laugh. The song they keep making up. Save the recording itself and listen again—not just a transcript of the words.\n\nSOMETHING TO COME BACK TO\nKeep memories together for each child. Look back through the photos and stories, play a familiar recording, and invite family members to share in it. You choose who joins your family journal.\n\nAND A BOOK TO HOLD, TOO\nWhen you’d like a printed baby book, choose a child and a time period. Momora selects saved memories, groups related moments and lays out the pages with your photos and stories. Review the book online, make changes and order a printed copy delivered to your door. Printed books are optional and purchased separately, with shipping extra.\n\nYOUR MEMORIES STAY YOURS\nYour saved memories remain available to read after your subscription ends. The family owner can export the archive, too.\n\nStart with what you already have. Add the little things when you have a minute.\n\nAn active subscription is required to add memories and use AI features. A printed book is not included in the subscription. Book prices and shipping charges are shown at checkout.",
  "keywords_candidate": "baby,book,album,journal,milestones,child,parenting,recording,print",
  "keywords_status": "relevance_hypothesis_no_volume_or_ranking_data",
  "whats_new_proposed": "Start with the photos already on your phone. Momora groups them into suggested memories and drafts captions for you to review and keep.\n\nYou can also turn saved memories into a baby book, with the photos and stories arranged for you. Review it online and order a printed copy when you’re ready.\n\nPrinted books are optional, purchased separately and subject to shipping charges.",
  "whats_new_status": "use_only_if_these_changes_belong_to_target_release",
  "commercial_context": {
    "source": "Owner statement in this conversation; not a live store or checkout verification",
    "annual_app_membership_amount": 99,
    "printed_book_amount": 99,
    "currency_symbol_as_supplied": "$",
    "currency_code_verified": false,
    "shipping": "extra",
    "print_optional": true,
    "print_included_in_subscription": false,
    "book_generation_and_online_review_entitlement": "verify_before_claiming_included_or_free",
    "public_exact_prices": "Do not hard-code the owner reference amounts into global App Store copy/screenshots. Verify localized display prices, tax and print scope for appropriate pricing surfaces.",
    "price_changes_authorized": false
  },
  "screenshots": [
    {
      "id": "01-more-than-photos",
      "position": 1,
      "headline": "Keep more than\nthe photos.",
      "support": "Their stories, funny words and little voice.",
      "disclosure": "Subscription required to add memories.",
      "job": "Make the digital experience valuable without a print purchase.",
      "proof": "A genuine populated Momora timeline or collection with separate photo, story and sound memories; use truthful labeled insets when the real layout cannot show every type at once."
    },
    {
      "id": "02-existing-photos",
      "position": 2,
      "headline": "Start with the\nphotos you have.",
      "support": "Moments grouped. Captions drafted. You choose what to keep.",
      "disclosure": "Subscription required.",
      "job": "Show an easier start and immediate value inside the app.",
      "proof": "The actual gallery suggestion deck, a complete grounded draft caption and the current Keep / Set aside controls; a saved version appears in slide 01 or 07."
    },
    {
      "id": "03-unphotographed-stories",
      "position": 3,
      "headline": "For the things\na photo missed.",
      "support": "Say what happened. Add an illustration.",
      "disclosure": "Subscription required.",
      "job": "Demonstrate short capture and the illustrated-story difference.",
      "proof": "An actual short composer input and its matching generated illustration. Do not imply gallery import creates illustrated photos."
    },
    {
      "id": "04-little-voice",
      "position": 4,
      "headline": "Keep their\nlittle voice, too.",
      "support": "Save the recording, not just the words.",
      "disclosure": "Subscription required to save new recordings.",
      "job": "Show a valuable digital outcome that a printed book cannot provide.",
      "proof": "The real saved sound-memory player with a legitimate demo clip, duration and a short description."
    },
    {
      "id": "05-optional-book",
      "position": 5,
      "headline": "And a book\nto hold, too.",
      "support": "Momora selects the memories and lays out the pages.",
      "disclosure": "Printed books sold separately. Shipping extra.",
      "job": "Give automatic book creation a substantial, clearly optional role.",
      "proof": "A real generated spread/cover plus the actual in-app book entry; retain website context for online review and an accurate physical mockup or cleared print sample."
    },
    {
      "id": "06-private-family",
      "position": 6,
      "headline": "For your family.\nNot a public feed.",
      "support": "Invite only the people you choose.",
      "disclosure": null,
      "job": "Show connection and audience control inside the app.",
      "proof": "Actual invitation/member controls and, when useful, a separately captured meaningful shared memory. Respect viewer/manager roles."
    },
    {
      "id": "07-look-back",
      "position": 7,
      "headline": "Here when you want\nto look back.",
      "support": "Photos, stories and sounds, together for each child.",
      "disclosure": null,
      "job": "End with returning to a useful digital collection, not buying something else.",
      "proof": "A genuine per-child collection or complete saved-memory view. Show sound only in a supported view, not a fabricated filter or combined card."
    }
  ],
  "opener_challengers": [
    {
      "id": "existing-photo-first",
      "status": "prepare_isolated_first_image_challenger",
      "replace_screen": "01-more-than-photos",
      "headline": "Your camera roll.\nTheir stories.",
      "support": "Moments grouped, captions drafted. You choose what to keep.",
      "disclosure": "Subscription required.",
      "proof": "Actual gallery suggestions connected to a saved digital memory; no printed object required.",
      "unchanged_positions": [
        2,
        3,
        4,
        5,
        6,
        7
      ]
    },
    {
      "id": "voice-first",
      "status": "prepare_isolated_first_image_challenger",
      "replace_screen": "01-more-than-photos",
      "headline": "Their little voice.\nYours to hear again.",
      "support": "Keep photos, stories and recordings together.",
      "disclosure": "Subscription required to save new memories.",
      "proof": "A genuine saved player with a real collection as supporting context; do not make Momora look like only a voice recorder.",
      "unchanged_positions": [
        2,
        3,
        4,
        5,
        6,
        7
      ]
    }
  ],
  "optional_ownership_replacement": {
    "id": "07-ownership-alternative",
    "replace_screen": "07-look-back",
    "headline": "Your memories\nstay yours.",
    "support": "Read and export, even after your subscription ends.",
    "disclosure": "Archive export is available to the family owner.",
    "status": "separate_optional_slot_test_if_verified",
    "proof": "Actual owner export and post-lapse readable archive; not a promise of forever storage or ongoing free creation."
  },
  "deferred_tests": [
    {
      "id": "earlier-book-slot",
      "status": "specification_only_not_default",
      "sequence_positions": [
        1,
        2,
        5,
        3,
        4,
        6,
        7
      ],
      "hypothesis": "A more visible optional print benefit may add value without changing the app-led opening.",
      "requirements": "Reuse unchanged assets, retain separate purchase disclosure, measure subscription understanding; never bundle with an opener test."
    },
    {
      "id": "book-first",
      "status": "hypothesis_only_requires_owner_decision_before_production_or_testing",
      "headline_candidate": "Your photos.\nTheir baby book.",
      "requirements": "Explain that the app membership and physical book are separate purchases. Use the same actual localized offer in comparisons. Judge paid app value and misunderstanding, not just installs. Not required for the v2 package."
    }
  ],
  "superseded_active_strings": [
    "Momora: Baby Book & Memories",
    "From camera roll to real pages",
    "A baby book from the photos you already have.",
    "A baby book.\nNot another project.",
    "A book for\neach of them."
  ],
  "counts": {
    "name_characters": 23,
    "subtitle_characters": 30,
    "promotional_text_characters": 132,
    "description_characters": 2067,
    "keywords_utf8_bytes": 66,
    "whats_new_characters": 377
  }
}
```
