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
