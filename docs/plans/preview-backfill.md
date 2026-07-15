# Preview Image Backfill Plan

**Status:** Executed against production 2026-07-15 — 613 previews written, 38
skipped (small), 1 legacy-key row permanently skipped (`memory_media`
`5c64b8a7-227c-43e4-8acc-430bb3fd4953`, pre-carousel `media.jpg` key shape; falls
back to original by design). 2.11 GB → 99 MB (95.3% reduction). Verified: rerun
found 0 pending; 15/15 sampled previews served smaller than originals.
**Date:** 2026-07-15
**Depends on:** docs/plans/performance-optimizations.md Workstream C (shipped:
migration `20260715140000_memory_media_preview_key.sql`, edge functions deployed
2026-07-15)

## 1. Context

Workstream C added `memory_media.preview_object_key` and client-side preview
generation (longest edge ≤1280, JPEG q0.8) for NEW photo uploads. Existing photos
have `preview_object_key = null` and fall back to full-resolution originals in the
timeline, calendar stamps, and member-profile thumbs — the exact bandwidth cost the
preview feature exists to remove. This plan backfills previews for those rows.

**Decision: resize runs locally on the developer's machine** via a Deno script,
mirroring the established pattern in `supabase/scripts/backfill-media-aspect-ratios.ts`
(dry-run default, `--apply` flag, service-role + R2 credentials from
`.env.local` + `supabase/.env.local`, presigned GETs from
`supabase/functions/_shared/r2.ts`). That precedent already runs local binaries
(ffprobe) against production media, so a local resize dependency is consistent.
Rejected alternatives: an Edge Function batch job (CPU/time limits, no image
library benefit) and Cloudflare image transforms (out of scope per the perf plan's
non-goals).

## 2. Script: `supabase/scripts/backfill-media-previews.ts`

### Invocation

```
# Dry run (default) — reports what would be done, touches nothing:
deno run --allow-all --env-file=.env.local --env-file=supabase/.env.local \
  supabase/scripts/backfill-media-previews.ts

# Apply:
... backfill-media-previews.ts --apply

# Optional flags: --limit N (first N candidates), --memory-id <uuid> (single
# memory, for a pilot run), --concurrency N (default 4)
```

Add `"backfill:previews"` to package.json mirroring the `eval:illustration`
invocation style (`npx --yes deno run --allow-all --env-file=...`).

Env required (all names already used by existing scripts — no new secrets):
`SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `R2_ACCESS_KEY_ID`,
`R2_SECRET_ACCESS_KEY`, `R2_ENDPOINT`, `R2_BUCKET`.

### Candidate selection

Page through `memory_media` (service role, `DATABASE_PAGE_SIZE`-batched like the
aspect-ratio script) where:
- `preview_object_key IS NULL`, and
- `content_type` is an image type (match the client's image set in
  `src/utils/media-validation.ts`; originals are already re-encoded to
  jpeg/png/webp by the EXIF-strip step, so no HEIC handling is needed).

Videos are excluded by construction (they have their own thumbnail path).

### Per-asset pipeline

1. **Download** the original via a presigned GET (`createPresignedGetUrls` from
   `_shared/r2.ts`, batched like the aspect-ratio script).
2. **Decide**: read dimensions; if longest edge ≤ 1280 → **skip permanently**
   (leave `preview_object_key = null`) — this matches the client's no-upscale
   guard in `src/utils/create-image-preview.ts`, and the null-fallback rendering
   path is the intended behavior for small images. Count these separately in the
   report so reruns don't keep reporting them as "pending".
3. **Resize** to longest edge 1280, JPEG quality 80 — **identical parameters to
   the client util; if the constants ever change there, change them here** (put a
   cross-reference comment in both files). Library: `npm:sharp` (works under
   `--allow-all` in Deno 2; if its FFI setup misbehaves on this machine, fall back
   to shelling out to ImageMagick `magick` the way the aspect script shells out to
   ffprobe — same output parameters). Do not call `withMetadata()` — output stays
   metadata-free like the client's (originals were already EXIF-stripped at
   upload, so there is no orientation tag to honor).
4. **Derive the preview key** from `object_key`: replace the asset filename's
   extension — `{prefix}/media/{assetId}.{ext}` → `{prefix}/media/{assetId}-preview.jpg`.
   MUST produce byte-identical keys to the client's derivation in
   `src/services/memory-posting.ts` (verify against it at implementation time) and
   MUST validate against `MEMORY_MEDIA_ASSET_EXTENSION_PATTERN`
   (`supabase/functions/_shared/storage-keys.ts`) before upload. Assert
   `previewKey !== object_key` (belt-and-braces: never overwrite an original).
5. **Upload** via `PutObject` with the S3 client from `createR2Client`
   (`content-type: image/jpeg`). Upload FIRST, then
6. **Update the row**: `update memory_media set preview_object_key = <key> where
   id = <id> and preview_object_key is null` (the `is null` guard makes concurrent
   or repeated runs safe).

Ordering note: a crash between 5 and 6 leaves an unreferenced preview object under
a live user's prefix. That is harmless — the hard-delete orphan sweep only scans
prefixes of deleted accounts — and the rerun re-uploads (idempotent overwrite,
same key) and completes the row.

### Concurrency, failures, reporting

- Concurrency 4 (flag-overridable); one retry per asset on transient
  download/upload failure, then log and continue — a failed asset stays
  `preview_object_key = null`, i.e. exactly the safe fallback state.
- Final report: candidates found / previews written / skipped-small / failed
  (with ids), plus total original vs preview bytes so the bandwidth win is
  quantified. Dry run prints the same report with zero writes (dimensions are
  still probed — dry run downloads but never uploads/updates).

## 3. Safety properties (summary)

- Dry-run by default; `--apply` required to write anything. Pilot with
  `--memory-id`/`--limit` before the full run.
- Originals are never written, moved, or deleted; the only writes are new
  `-preview.jpg` objects and the nullable column.
- Idempotent + resumable: presence of `preview_object_key` is the done-marker;
  the `where ... is null` update guard prevents double-processing.
- Deletion/authorization coverage for preview keys already shipped in Workstream
  C2 (edge functions deployed 2026-07-15) — backfilled previews are admitted by
  `get-media-url` and cleaned up by every deletion path from day one. **Do not
  run this script against a project whose functions predate that deploy.**

## 4. Verification (post-apply)

1. Re-run the script without `--apply`: candidates found should equal the
   skipped-small count (nothing pending).
2. Sample check (script flag `--verify N`, default 10): presigned GET of each
   sampled preview returns 200 and is smaller than its original.
3. In the dev client against prod: timeline/calendar cards for old memories now
   load the preview (network inspector or R2 access logs); full-screen viewer
   still loads the original.

## 5. Tests

Extract the pure helpers — preview-key derivation and the resize/skip decision —
as exported functions and cover them with colocated Deno tests
(`backfill-media-previews.test.ts`), wired into whatever glob `npm run test:edge`
uses (extend the task if it only covers `supabase/functions/`). Key-derivation
cases: each allowed extension, `-preview` idempotence guard (never derive from an
existing `-preview` key), pattern validation rejection.

## 6. Out of scope

Video thumbnails (already exist), re-generating previews if size constants change
later (would need a `--force` mode; not planned), any Cloudflare read-time
transforms.

## 7. Video-poster extension (added 2026-07-15)

The upload-time preview feature this plan backfills was extended to videos:
new video uploads now generate a first-frame poster JPEG at upload time,
stored in the same `memory_media.preview_object_key` column and same
`{mediaAssetId}-preview.jpg` key pattern as photo previews (see
`docs/features/media-memories.md`'s "Video posters" architecture bullet). No
schema change was needed — neither the column nor the
`replace_memory_media_assets` RPC was ever gated to a content type.

Legacy video rows (created before this shipped) get their own backfill
script, `supabase/scripts/backfill-video-posters.ts` — same conventions as
`backfill-media-previews.ts` (dry-run default, `--apply`/`--limit`/
`--memory-id`/`--concurrency`/`--verify`, `IS NULL` update guard, one retry,
byte report), reusing `deriveMediaPreviewKey` from that script directly
(imported, not copied) so a backfilled key is byte-identical to what the
client would have produced. It differs from the photo script in two ways:

1. **No image-processing library** — Deno has no equivalent to `sharp` for
   video. The script shells out to a local `ffmpeg` binary instead (mirrors
   `backfill-media-aspect-ratios.ts`'s existing `ffprobe` shell-out
   precedent), reading the presigned R2 GET URL directly as ffmpeg's input
   (no download step) and piping a single scaled JPEG frame to stdout in one
   command (`-vframes 1`, autorotate default, `scale='min(iw,1280)':'min(ih,1280)':force_original_aspect_ratio=decrease`,
   `-q:v 3`, `-f image2pipe -vcodec mjpeg`). The `min(iw,N)`/`min(ih,N)` box
   (rather than a fixed `N:N` box) is deliberate: a fixed box with
   `force_original_aspect_ratio=decrease` still upscales a source smaller
   than the box, verified empirically while building the script.
2. **No skip-small decision** — unlike `decidePreviewResize`, there is no
   "leave `preview_object_key` null because the source is already small"
   case. A video has no acceptable full-quality fallback for a list
   thumbnail the way a photo original does; skipping would just mean
   permanently paying the runtime `useVideoThumbnail` extraction cost for
   every small video. Every candidate row gets a poster whenever ffmpeg can
   extract one.

Local testing used a synthetic `ffmpeg -f lavfi -i testsrc=...` video served
over a local HTTP server (no production data touched) to validate the exact
`ffmpeg` invocation the script builds — confirmed it (a) never upscales a
source already under 1280px, (b) correctly downscales larger sources
preserving aspect ratio, and (c) reads a remote HTTP(S) URL directly the same
way it will read a presigned R2 URL in production.

**Status:** written and unit-tested; **not yet run against production** (no
dry-run/apply pass has been executed — that is a separate, deliberate step
for whoever operates the backfill, same as the photo pass was before its
2026-07-15 production run documented above).
