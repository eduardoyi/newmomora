# memory-book-renderer

Print-render worker for the memory book checkout & fulfillment pipeline
(memory-book-5c plan, Step 3). A Dockerized, HMAC-gated HTTP API around
`book-renderer`'s `renderBookPdfs()`/`fitBookForPrint()` (wave 1), driving
headless Chrome + R2 inside a Fly.io machine.

This worker never sees the outside world except through this API. It has
**no database credential and no Prodigi API key** — it can compute a page
count, render PDFs, and put/get objects in R2. Nothing else (Decision 2/3's
blast-radius control: a compromised render worker can never itself place a
print order).

## API

Every op except `GET /health` requires the timestamp+nonce+raw-body HMAC
scheme (`src/crypto.ts`, a verbatim mirror of
`cloudflare/memory-book-worker/src/crypto.ts`):

| Header | Value |
|---|---|
| `x-render-timestamp` | `Date.now()` as a string, must be within 5 minutes of the server's clock |
| `x-render-nonce` | a UUID |
| `x-render-signature` | `hex(HMAC-SHA256(secret, "${timestamp}.${nonce}.${rawBody}"))` |

`rawBody` is the exact request body bytes (empty string `''` for a `GET`).

### `GET /health`

Open, no auth. `200 {"ok": true}` — Fly's health check target.

### `POST /fit`

```jsonc
// request
{ "bookDocument": { "outline": {...}, "manifest": {...} }, "edits": {...}, "spineMm": 28 }
// response 200
{ "pageCount": 122 }
```

Runs `fitBookForPrint()` — pure Node, no Chrome, no R2 access at all. Returns
THE canonical submitted-interior page count (see
`book-renderer/scripts/lib/fitBookForPrint.ts`'s own header comment for what
that means and why quote/spine/Prodigi-order all key off this exact number).
`422` with `{"error":"FIT_FAILED","reason":"..."}` on a genuinely unfittable
document (ids/counts in `reason`, never memory content).

### `POST /render`

```jsonc
// request
{
  "orderId": "<uuid>", "attemptId": "<uuid>",
  "bookDocument": { "outline": {...}, "manifest": {...} },
  "edits": {...}, "spineMm": 28
}
```

- **`202`** `{"accepted": true, "orderId": "...", "attemptId": "..."}` — a
  fresh `attemptId`; the actual render (presign → manifest/edits URL
  rewrite → `renderBookPdfs()` → upload → status finalize) runs in the
  background. Poll `GET /status/:attemptId` for the outcome.
- **`200`** the `done` status body — this `attemptId` already completed;
  idempotent forever, no re-render.
- **`409`** `{"error":"RENDER_IN_PROGRESS","status":{...}}` — a concurrent
  request for the SAME `attemptId` is already `running` (checked via a real
  R2 conditional write, not the HMAC replay window — see `src/status.ts`'s
  own header comment for exactly how the atomicity works across two Fly
  machines).
- A previously `failed` `attemptId` is **not** sticky — a fresh `POST
  /render` retries it (failure recovery is refund-or-retry, never silent).

Output lands in R2 at `print-orders/<orderId>/<attemptId>/` —
`interior.pdf`, `cover.pdf`, `status.json`.

### `GET /status/:attemptId?orderId=<uuid>`

```jsonc
{ "status": "pending" }                                    // nothing written yet
{ "status": "running", "startedAt": "..." }
{ "status": "done", "pageCount": 122, "checksums": {...}, "keys": {...}, "completedAt": "..." }
{ "status": "failed", "reason": "...", "failedAt": "..." }
```

`orderId` is a required query param — a **deviation from the plan's own
shorthand route notation** (`GET /status/<attemptId>`), documented in
`src/server.ts`'s header comment: the R2 layout the task brief specifies is
nested `print-orders/<orderId>/<attemptId>/…`, so an attemptId alone isn't a
sufficient lookup key without either a second id or a DB this worker
deliberately doesn't have. The caller (the future order workflow, plan step
5) always has both ids already — it minted them.

## PII data endpoints (not part of this API)

`renderBookPdfs()`'s own internal static server — the one that serves
`/attempt/<id>/{outline,manifest,edits}.json` from the in-flight request's
payload — binds to `127.0.0.1` only, spun up/torn down per render, and is
**never** reachable from the port Fly exposes. This HTTP server never proxies
or re-serves that data; it only ever hands a `bookDocument`/`edits` value to
`renderBookPdfs()` in-process. See `book-renderer/scripts/lib/renderBookPdfs.ts`'s
own header comment (wave 1).

## Build

`book-renderer/` is a sibling package, pulled into the Docker build as a
**separate, named build context** (BuildKit `--build-context`) rather than
by making the repo root the build context — this is what lets
`book-renderer/.dockerignore` exclude `book-data/` (1.9GB of real exported
family books — child PII) at the Docker layer itself, before
`book-renderer/vite.print.config.ts`'s `publicDir: false` ever gets a chance
to matter. See `Dockerfile`'s own header comment for the full reasoning.

```bash
# from render/memory-book-renderer/
docker build --build-context bookrenderer=../../book-renderer -t memory-book-renderer .
```

The `Dockerfile` pins `FROM --platform=linux/amd64 …` explicitly (matching
Fly Machines, which are x86_64) — Chrome for Testing (what Puppeteer's own
postinstall downloads) has no official `linux/arm64` build at all, so
building natively on an Apple Silicon host without this pin produces an
arm64 image whose Chrome binary can't run (`rosetta error: failed to open
elf at /lib64/ld-linux-x86-64.so.2` at container start, not at build time —
found by actually booting the image during this work, not by inspection).
On an Apple Silicon dev machine this build runs under Docker Desktop's
bundled QEMU emulation (slower — several minutes even with warm layer
caches — but correct); a real Fly deploy needs no emulation at all.

### Verify the image carries zero `book-data` files (PII safety)

```bash
docker run --rm memory-book-renderer \
  find /app/book-renderer -type d -iname 'book-data'
docker run --rm memory-book-renderer \
  find /app -not -path '*/node_modules/*' \( -name manifest.json -o -name book.outline.json \)
```

Both commands must print nothing. `test/pii-image.test.ts` runs exactly this
check as part of the test suite (a real `docker build` + `docker run`, not a
config-level assertion).

### Parity proof

`scripts/parity-proof.mts` runs the plan's Step 3 acceptance check for real:
builds the image, runs a container against **real R2 credentials**, POSTs a
real `/render` for the `enzo-year-one` fixture book plus a synthetic edits
object (imageReplace + coverPhoto + text + focalPoint), and compares the
result against `renderBookPdfs()` invoked directly on the host with the same
inputs (page count, checksums/raster). See that script's own header comment
for exactly what it checks and why it uploads the fixture's local asset
bytes to a scoped R2 test prefix first (the checked-in fixture's manifest
keys are anonymized basenames, not real object keys — see
`supabase/scripts/eval-memory-book-assets.ts`'s own `objectKeyBasename`
comment).

```bash
npm run parity-proof
```

## Deploy (owner-run — never run by an agent)

Fly.io deploys stay owner-run per the plan's recorded decision ("Fly org:
created. Deploys stay owner-run, with a scoped deploy token as the fallback
if iteration demands it"). `fly.toml` is committed here; it has never been
deployed as part of building this worker.

```bash
# One-time app creation (owner):
fly apps create momora-memory-book-renderer

# Secrets (owner — never commit these, never put them in fly.toml):
fly secrets set \
  --app momora-memory-book-renderer \
  R2_ACCOUNT_ID=... \
  R2_ACCESS_KEY_ID=... \
  R2_SECRET_ACCESS_KEY=... \
  R2_ENDPOINT=https://<account-id>.r2.cloudflarestorage.com \
  R2_BUCKET=... \
  RENDER_WORKER_HMAC_SECRET="$(openssl rand -hex 32)"
# NOTE: no Prodigi key, ever — this worker is not allowed to hold one
# (Decision 2/3's blast-radius control).

# Deploy — from render/memory-book-renderer/, same named-context mechanism
# as the local `docker build` above (flyctl's remote builder proxies
# BuildKit, which supports `--build-context`):
fly deploy --build-context bookrenderer=../../book-renderer
```

The `RENDER_WORKER_HMAC_SECRET` value must also be handed to whatever calls
this worker (the future order workflow, plan step 5) as its own matching
secret — this worker only ever verifies, it has no way to distribute the
secret itself.

### A note on the deploy-time build context (UNVERIFIED — flag it before the first real deploy)

The build/PII/parity evidence for this step all used the LOCAL `docker
build --build-context ...` command above, run directly against the Docker
daemon in this environment (flyctl itself is not installed here, and deploys
are owner-gated — an agent never runs `fly deploy`). `fly deploy` also
accepts `--build-context` as of a reasonably recent flyctl, but that path
was **not itself exercised** as part of this work. Before the owner's first
real deploy: run `fly deploy --build-context bookrenderer=../../book-renderer
--build-only` (or equivalent dry-run) once to confirm the flag reaches
flyctl's remote builder on whatever flyctl version is installed; if it
doesn't, the fallback is to build+push the image locally
(`docker build --build-context ... && docker tag ... && fly deploy --image ...`)
rather than relying on flyctl's own build step.

## Tests

```bash
npm test          # unit/contract suite, incl. a real docker build+run (PII check)
npm run parity-proof   # separate, slower, real-R2 acceptance script (not part of `npm test`)
```

`test/pii-image.test.ts` and `scripts/parity-proof.mts` both shell out to a
real `docker build`/`docker run` — expect the first run to take several
minutes (Chrome for Testing download + two `npm ci`s with no layer cache
yet); subsequent runs are fast (Docker layer cache).
