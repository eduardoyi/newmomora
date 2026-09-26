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
