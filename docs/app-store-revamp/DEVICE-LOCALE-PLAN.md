# Device and locale plan

## The four buckets

Per PLAN.md §2.1, corrected against Apple's live specification (portrait 6.9" iPhone is
1260×2736, not 1320×2868; required 6.5" iPhone is 1284×2778; required 13" iPad is
2064×2752):

| Bucket | Dimensions | Requirement | Why |
|---|---|---|---|
| `appstore` | 1260×2736 | Accepted | Current Apple 6.9" portrait spec; already rendered by the v1 pipeline (`store-assets/out/appstore/`, confirmed present on disk). |
| `appstore-alt` | 1320×2868 | Accepted | Documented in PLAN.md as an "insurance size" for older/alternate 6.9"-class device variants; already rendered (`store-assets/out/appstore-alt/`, confirmed present). Kept as a belt-and-suspenders upload option, not because it is the current primary spec. |
| `appstore-65` | 1284×2778 | **Required** | Apple's required 6.5" iPhone screenshot size. **New bucket — not present anywhere in `store-assets/render.mjs` or `store-assets/templates/screenshot.html`'s `SIZES` maps as of this pass.** Must be added to both files together (see INVENTORY.md's "SIZES duplication trap"). |
| `ipad` | 2064×2752 | **Required** | Apple's required 13" iPad screenshot size; already rendered by the v1 pipeline (`store-assets/out/ipad/`, confirmed present) using genuine iPad captures (`store-assets/source/ipad/*.png`). |

App Store screenshot rules confirmed against PLAN.md §2: 1–10 screenshots per localization,
no alpha channel. This pass did not independently re-verify Apple's live documentation
(no network browsing was performed) — it re-states PLAN.md §2's already-verified correction
and treats it as ground truth per the task's instruction not to re-derive §1/§2 facts.

## iPad stance

`app.json:11` — `"supportsTablet": true` — **confirmed** by direct read of the file in this
pass. Per PLAN.md §2.1/§4 and the master brief ("The earlier app.json enabled iPad support.
Verify current device families, then include genuine iPad layouts when still supported. Do
not switch off tablet support to reduce production work."), this pass:

- Does **not** modify `app.json`, `ios.supportsTablet`, or any device-family/build setting
  (out of scope per PLAN.md §6 standing rules).
- Confirms genuine iPad captures already exist for four of the seven default-frame concepts
  (`store-assets/source/ipad/{s2-memory-detail,s3-timeline,s4-family,s5-calendar,
  spare-person-detail}.png`) — five files, four already wired into the v1 manifest plus one
  spare (`spare-person-detail.png`, now the frame-07 `ready` asset per ASSET-CHECKLIST.md).
- Requires that any new capture requested for a blocked frame (02, 04, 05's in-app shelf,
  06's sharing screens, the optional slot-7 test) include a genuine iPad layout alongside
  the iPhone one — never a stretched iPhone screenshot standing in for iPad, per the
  standing rule.

## Locale scope

**en-US only this pass.** `momora-listing-handoff-v2/approved-listing-copy.json` sets
`"locale": "en-US"` and `momora-listing-handoff-v2/state.json` (this pass's output) mirrors
that. No other locale's copy, screenshots, or metadata is touched, read for modification, or
regenerated. `momora-listing-handoff-v2/copy/en-US/` exists on disk as the copy-export
target directory for phase 2; no other locale directory was found or is expected to exist
yet.

## What is genuinely new vs. already rendered

Confirmed by listing `store-assets/out/`: the v1 pipeline already produces `appstore`,
`appstore-alt`, `ipad`, plus three Android/Play buckets (`play`, `play-tablet7`,
`play-tablet10`) that are outside this pass's App-Store-only scope. Of the **four required
buckets for this pass**, three (`appstore`, `appstore-alt`, `ipad`) already have a working
render path; only `appstore-65` (1284×2778) is new and requires the `SIZES` map extension
described in INVENTORY.md before phase 4 can render it.
