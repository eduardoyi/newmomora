# v1 archive (2026-08 book-first listing renders)

This directory holds the **superseded v1 rendered App Store / Play Store listing
outputs**, moved here (not deleted) on 2026-09-20 as part of WP-C of the v2
memory-first listing revamp (`docs/app-store-revamp/PLAN.md`, `momora-listing-handoff-v2/`).

## What this is

The book-first v1 listing positioned Momora primarily around the printed memory
book ("s5-look-back" etc. naming reflects that framing). `MASTER-BRIEF.md`
supersedes that positioning entirely with a memory-first strategy: the app has
value before and without printing. The v1 renders below no longer match the
approved v2 story, copy, or frame order, so they were moved out of the active
`store-assets/out/` tree.

## What is here

Moved verbatim from `store-assets/out/<bucket>/*.png`, preserving bucket
subdirectory structure:

- `appstore/` — 6 slides, iPhone 6.9" bucket (`s1-hook.png` … `s6-closing.png`)
- `appstore-alt/` — same 6 slides, alternate iPhone size bucket
- `play/` — same 6 slides, Google Play phone bucket
- `ipad/` — same 6 slides, iPad bucket
- `play-tablet7/` — same 6 slides, Play 7" tablet bucket
- `play-tablet10/` — same 6 slides, Play 10" tablet bucket
- `feature/` — `feature-graphic.png`, the Play Store feature graphic

`store-assets/out/` is `.gitignore`d, so this move is **local-disk only** — it
has no effect on git history or any other checkout. This README exists so the
move is recorded even though it produces no diff.

## What this is NOT

This is **rollback material**, not an active release set. Do not upload these
files to App Store Connect or Google Play Console. The active v2 work lives
under `store-assets/v2/` (prepared assets, manifest) and will render into
`store-assets/out/v2/<bucket>/` per `docs/app-store-revamp/PLAN.md` §3 (owned
by WP-D, not this work package).

## What was explicitly NOT touched by this archive step

Per WP-C scope, none of the following were moved or modified:

- `store-assets/source/**` — genuine device captures, reused by v2
- `store-assets/fonts/**` — repo-licensed fonts, reused by v2
- `store-assets/art/**` — decorative watercolor art, reused by v2
- `store-assets/manifest.json` — preserved as a v1 artifact for reference
- `store-assets/templates/**` — compositor templates, extended in place by WP-D
- `store-assets/render.mjs` — the render pipeline, extended in place by WP-D

## To roll back

If v2 needs to be abandoned, copy the bucket directories under this folder
back to `store-assets/out/` and re-point any listing tooling at
`store-assets/manifest.json` (the v1 registry).
