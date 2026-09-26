# Momora listing handoff — v2, memory-first

**Use this package instead of the previous handoff.** The app's digital value now leads. Import is an easier start; stories, saved sound, revisiting and family connection are valuable without a print order. Automatic books remain a substantial optional benefit in screenshot 5.

This is an updated implementation brief, proposed text and prompts—not newly rendered store screenshots or live store changes. The six images in reference/ are unchanged originals.

## Start here

Unzip into your local repository root as `momora-listing-handoff-v2/`. Keep any old handoff alongside it rather than overwriting its state. Attach this ZIP or place the folder in the coding agent's accessible workspace. The old DOCX is not needed; the revised report and unchanged customer research are included.

Paste:

```text
The previous book-first Momora listing brief is superseded.
Read momora-listing-handoff-v2/MASTER-BRIEF.md and execute
momora-listing-handoff-v2/prompts/00-rebase-existing-work.md.
Preserve reusable source and captures, but adopt the v2 strategy, copy,
screenshot order and acceptance tests. Do not publish or change pricing.
```

Then run prompt files 01 through 05, in order, in the same checkout. To invoke a phase, ask the agent to execute its file and create the requested outputs, not merely summarize the instructions. Phase 05 may use a fresh reviewer session with the same files. Do not run dependent phases in separate parallel worktrees.

## Included

MASTER-BRIEF.md is the implementation authority. approved-listing-copy.json holds all proposed store/slide/variant copy. copy/en-US contains matching plain-text fields. COMMERCIAL-CLARITY.md separates the app membership from optional printing. REBASE-FROM-V1.md maps ongoing work. prompts/ contains the reset plus five full implementation prompts. The reference folder includes the revised review, unchanged customer research and six original screenshots. state.example.json is a template, not existing project state. tools/validate_handoff.py checks this handoff's consistency, not live product behavior.

Run the local handoff check with:

```bash
python3 momora-listing-handoff-v2/tools/validate_handoff.py
```

The `documents/` folder also contains the revised Word report and the complete prompts/brief as one Markdown file. `HANDOFF-QA.md` records checks on this delivered package; it is not a release approval. `PACKAGE-MANIFEST.json` lists the packaged files and checksums.

## Completion expected from the coding agent

All metadata, all seven default screenshot compositions for required iPhone/iPad families, two digital-value opener challengers, editable rendering source, previews, actual QA and a manual upload mapping. Print-first is only a deferred hypothesis. A missing device/cleared asset should become a precise blocker, never fictional UI.

The owner reference prices are $99/year for the app and $99 plus shipping for optional printing. Do not change them, imply print is included or freeze reference amounts into global public fields. Verify live/localized offers and generation/review entitlement before publication.

No production mutations, real orders, unapproved costs or automatic store publishing are authorized. The package contains no font files or credentials. Do not commit the supplied research/media to a public repository unless you intend and are permitted to publish them.
