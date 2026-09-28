# Year Film render worker

The image that renders Year Films on Fly (docs/plans/year-film.md §7.4). F5
builds and benchmarks it with a **synthetic sample film** only — no real
family data leaves the laptop before P1. The HTTP shell (HMAC `/render`, R2
in/out, status), modeled on `render/memory-book-renderer`, comes in P1.

## What's inside

- Node 22, Chrome's libraries, ffmpeg, the pinned `hyperframes@0.8.80` CLI and
  its Chrome (downloaded at build time — a scale-to-zero machine never
  downloads at render time), telemetry disabled.
- `film-renderer/` as a named build context. `film-renderer/.dockerignore`
  keeps every family's `film-data/`, renders and Studio caches out of the
  image; the sample film is generated inside it by
  `film-renderer/sample/make-sample.mjs`.
- `bench.sh [slug]`: assembles and renders a film, then prints one JSON line
  (render seconds, peak memory, CPUs, output size, a hash).

## Build

Always through `build.sh` — it stages only files git tracks or would track, so
every family's `film-data/` (GBs of real media) can never reach the Docker
context. The image is `linux/amd64`; on Apple Silicon it builds under
emulation.

```bash
./build.sh
```

## Benchmark locally

```bash
docker run --rm year-film-renderer              # renders the sample
docker run --rm -e WORKERS=2 year-film-renderer
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
fly machine run registry.fly.io/momora-year-film-renderer:f5 --app momora-year-film-renderer \
  --vm-size performance-8x --vm-memory 16384 --region iad --rm --restart no
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
