# Year Film render worker

The image that renders Year Films on Fly (docs/plans/year-film-p1.md
Decision 2/4, Step 6). `cloudflare/year-film-worker` starts a **one-off
machine per job** through the Machines API (`auto_destroy`, restart `no`,
name `yf-{attemptId}-{mode}`) and polls an R2 `status.json`. There is no
HTTP server: the job reads its input from R2 and writes its output there.

## Job modes (`src/job.mjs`, the image entrypoint)

| `init.cmd` | Input | Output (under `JOB_PREFIX` = `{ownerId}/year-films/{filmId}/{attemptId}/`) |
|---|---|---|
| `thumbs` | `thumbs/job.json` (claim-check candidate keys) | `thumbs/NNN.jpg` (512px), `thumbs/manifest.json`, `thumbs/status.json` |
| `prepare` | `prep/job.json` (`planPrepare` items) | stills ≤1920px (upright, HEIC via `heif-convert`), ranked clip/voice cuts, 512px check frames, 16 kHz WAVs, `prep/prep.json`, `prep/status.json` |
| `render` | `job.json` + `film.json` + `prep/**` | `film.mp4`, `poster.jpg` (1080×1920, the first scene once settled), `poster_thumb.jpg` (360×640, same frame, for lists; its key is derived from `poster_key`), `scenes.json`, `status.json` (`durationMs`) |

Env: `JOB_PREFIX`, `JOB_TIMEOUT_SECONDS` (hard stop → `failed/TIMEOUT`),
`R2_ENDPOINT`, `R2_BUCKET`, and either per-machine temporary credentials
(`R2_READ_*` for the family's source objects, `R2_WRITE_*` for the attempt
prefix) or the Fly app secrets `R2_ACCESS_KEY_ID` / `R2_SECRET_ACCESS_KEY`.
Logs carry counts and codes only.

## What's inside

- Node 22, Chrome's libraries, ffmpeg, ImageMagick + libheif, the pinned
  `hyperframes@0.8.80` CLI and its Chrome (downloaded at build time),
  telemetry disabled.
- `film-renderer/` as a named build context (never `film-data/`), plus a
  `job` context with this package and the one shared TS module it imports
  (`supabase/functions/_shared/year-film-trim.ts`) at repo-relative paths;
  Node runs it with `--experimental-strip-types`.
- `bench.sh [slug]` (F5): `docker run --rm --entrypoint /app/bench.sh year-film-renderer sample`.

## Build

Always through `build.sh`: it stages only files git tracks or would track
(every family's `film-data/` can never reach the context), refuses a dirty
tree for production (`ALLOW_DIRTY=1` for a local test image), and tags the
image with the git sha. `linux/amd64`; on Apple Silicon it builds under
emulation.

```bash
./build.sh
```

## Local end-to-end test

`e2e.ts` runs the image's three modes exactly as the Worker would, against
an S3-compatible test store, with synthetic media only (photos, a HEIC,
clips with sound, an audio memory, a reference portrait) and a real
FilmScript from the production monthly builder. Checks are resolved with
stand-in verdicts through the shared resolvers (no OpenAI).

```bash
docker network create yf-test
docker run -d --name yf-s3 --network yf-test --network-alias s3 -p 9100:9090 \
  -e COM_ADOBE_TESTING_S3MOCK_STORE_INITIAL_BUCKETS=momora-test adobe/s3mock
ALLOW_DIRTY=1 ./build.sh
deno run --allow-all --node-modules-dir=none --sloppy-imports render/year-film-renderer/e2e.ts
```

## Deploy (owner-run)

```bash
fly auth docker
docker tag year-film-renderer:<sha> registry.fly.io/momora-year-film-renderer:<sha>
docker push registry.fly.io/momora-year-film-renderer:<sha>
fly secrets set --app momora-year-film-renderer R2_ENDPOINT=… R2_BUCKET=momora-prod R2_ACCESS_KEY_ID=… R2_SECRET_ACCESS_KEY=…
```

Then set `FILM_RENDERER_IMAGE` in `cloudflare/year-film-worker/wrangler.jsonc`
to `registry.fly.io/momora-year-film-renderer:<sha>` and deploy the Worker.
Remote `fly deploy` can't supply the named build contexts — always push the
locally built image.

## Parity (P1 gate e)

Render the same synthetic sample in the same image locally and on a one-off
Fly machine (below, with `KEEP_ALIVE=1` to fetch the MP4), then compare:

```bash
ffmpeg -i fly.mp4 -i local.mp4 -lavfi psnr=stats_file=psnr.log -f null -
```

Pass: mean PSNR ≥ 45 dB, worst frame ≥ 38 dB, same duration; plus an owner
look against the laptop F3 render (different ffmpeg/Chrome builds).

## Benchmark locally

```bash
docker run --rm --entrypoint /app/bench.sh year-film-renderer sample
docker run --rm --entrypoint /app/bench.sh -e WORKERS=2 year-film-renderer sample
```

Emulated timing on a Mac is not representative of Fly; it proves the image
works end to end.

## Benchmark on Fly

One-off machines render the sample, print the JSON line to the logs, and are
destroyed (`--rm`). Nothing but the synthetic sample is in the image. The
image is pushed from the local build (the exact image that passed locally),
not rebuilt remotely:

```bash
fly apps create momora-year-film-renderer --org personal   # once
fly auth docker
docker tag year-film-renderer registry.fly.io/momora-year-film-renderer:f5
docker push registry.fly.io/momora-year-film-renderer:f5
fly machine run registry.fly.io/momora-year-film-renderer:<sha> --app momora-year-film-renderer \
  --entrypoint /app/bench.sh --vm-size performance-8x --vm-memory 16384 --region iad --rm --restart no -- sample
fly logs --app momora-year-film-renderer --no-tail | grep '"slug"'
```

To fetch the MP4, add `--env KEEP_ALIVE=1` (the machine sleeps 15 minutes
after rendering), then
`fly ssh sftp get /tmp/out.mp4 out.mp4 --app momora-year-film-renderer --machine <id>`
and `fly machine destroy <id> --force`.

## F5 results (2026-09-28)

| Machine | 63s sample | Peak memory | ≈ Cost/film |
|---|---|---|---|
| performance-8x · 16GB | **93s** | 4.4GB | ≈ $0.007 |
| performance-4x · 8GB | 264s | 2.2GB | ≈ $0.009 |
| performance-2x · 4GB | fails ("Missing manifest", Fly only) | — | — |

No GPU on Fly: Chrome renders in software. Details in
`docs/plans/year-film.md` (F5).
