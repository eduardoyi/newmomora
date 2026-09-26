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
