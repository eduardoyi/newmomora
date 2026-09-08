# syntax=docker/dockerfile:1.7
#
# Memory book render worker (memory-book-5c plan, Step 3). Node 22 +
# puppeteer-compatible Chrome deps; book-renderer's `dist-print/` (the print
# entry, PII-safe build — see vite.print.config.ts) is built HERE, at IMAGE
# BUILD TIME, never at request time (Decision 3: "no vite build/preview
# spawn at runtime" — renderBookPdfs() serves this prebuilt dist itself, no
# vite dev/preview server is ever spawned per render, wave 1).
#
# ── book-renderer as a SEPARATE, PII-excluded build context ────────────────
# book-renderer/ lives one level up from this directory (a sibling package,
# same monorepo) and Docker COPY can't reach outside its own build context —
# so book-renderer/ is brought in as an ADDITIONAL NAMED build context
# (BuildKit feature, Docker >=23), not by making the repo root the context.
# This is the mechanism behind the plan's "use a build context/dockerignore
# that excludes [book-data/]": book-renderer/.dockerignore governs exactly
# that named context, the SAME way this file's own .dockerignore governs
# THIS directory's context — so book-data/ (1.9GB of real exported family
# books, child PII) is excluded at the Docker layer itself, before
# vite.print.config.ts's `publicDir: false` ever gets a chance to matter.
# Build accordingly (see README.md's "Build" section for the full command):
#
#   docker build \
#     --build-context bookrenderer=../book-renderer \
#     -t memory-book-renderer \
#     .
#
# (run from render/memory-book-renderer/ — this directory is the DEFAULT
# build context, governed by this directory's own .dockerignore).
#
# ── Platform: pinned to linux/amd64 ─────────────────────────────────────
# Fly Machines run x86_64 — and, separately but for the SAME reason, Chrome
# for Testing (what Puppeteer's own postinstall below downloads) has no
# official linux/arm64 build at all, only linux64 (x64). Building this image
# on an Apple Silicon host WITHOUT pinning the platform silently produces an
# arm64 image whose downloaded Chrome binary is the x64 one — it fails at
# container start with "rosetta error: failed to open elf at
# /lib64/ld-linux-x86-64.so.2" (no x86 loader inside a native-arm64
# container) rather than at build time, which is exactly the kind of defect
# this Dockerfile pins against explicitly instead of leaving to whatever
# `docker build` defaults to on the machine that happens to run it. Docker
# Desktop's bundled QEMU emulation makes the amd64 build/run work
# transparently on an Apple Silicon dev machine (slower, but correct); real
# Fly deploys need no emulation at all since Fly machines already ARE amd64.
FROM --platform=linux/amd64 node:22-bookworm-slim AS base

# Chrome (Chrome for Testing, downloaded by puppeteer's own postinstall
# below) needs these shared libraries/fonts present on the OS side — this is
# the "puppeteer-compatible base image (Chrome deps)" half of Step 3; the
# Chrome BINARY itself is not baked into this image manually, it's the exact
# build puppeteer@24 resolves for itself (see book-renderer/package.json),
# so this stays correct across a future puppeteer version bump without this
# list needing to track Chrome's own dependency changes by hand.
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    fonts-liberation \
    libasound2 \
    libatk-bridge2.0-0 \
    libatk1.0-0 \
    libatspi2.0-0 \
    libcairo2 \
    libcups2 \
    libdbus-1-3 \
    libdrm2 \
    libexpat1 \
    libgbm1 \
    libglib2.0-0 \
    libgtk-3-0 \
    libnspr4 \
    libnss3 \
    libpango-1.0-0 \
    libx11-6 \
    libx11-xcb1 \
    libxcb1 \
    libxcomposite1 \
    libxdamage1 \
    libxext6 \
    libxfixes3 \
    libxkbcommon0 \
    libxrandr2 \
    wget \
    xdg-utils \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# ── book-renderer: install (full, incl. devDependencies — puppeteer,
# pdf-lib, and vite-node are ALL devDependencies there today; this image
# needs every one of them at runtime, not just for a build step, so
# `--include=dev` is passed explicitly rather than relying on npm's
# NODE_ENV-driven default) and build the print-only PII-safe bundle. ────────
COPY --from=bookrenderer . /app/book-renderer
WORKDIR /app/book-renderer
RUN npm ci --include=dev
# NOT `npm run build` (that runs the DEFAULT vite.config.ts, whose
# `publicDir: 'book-data'` is exactly what this whole build context
# construction exists to never depend on) — vite.print.config.ts is the
# dedicated, PII-safe config (publicDir: false, print.html entry only,
# dist-print/ output — see that file's own header comment).
RUN npx vite build --config vite.print.config.ts

# ── render worker's own server ──────────────────────────────────────────
# WORKDIR mirrors this repo's own local layout EXACTLY
# (`<repo-root>/render/memory-book-renderer/src/…` next to
# `<repo-root>/book-renderer/…`) — src/{fit,render,manifestRewrite}.ts import
# book-renderer via relative paths (`../../../book-renderer/…`) that were
# written to resolve correctly from a working tree checkout; a Docker layout
# that collapsed `render/memory-book-renderer` into a single `render/`
# directory silently broke those same relative imports (`../../book-renderer`
# needed one `..` less) — caught by actually booting this image, not by
# `tsc`/`vitest`, which both run from the real working tree and never see
# the mismatch. Keeping the image's directory depth identical to the repo's
# own is what makes this class of bug impossible instead of merely tested.
WORKDIR /app/render/memory-book-renderer
COPY package.json package-lock.json* ./
RUN npm ci --include=dev
COPY tsconfig.json ./
COPY src ./src

ENV PORT=8080
ENV BOOK_RENDERER_DIST_DIR=/app/book-renderer/dist-print
# Fly `hard_limit = 1` (fly.toml) already ensures one request per machine;
# this is Puppeteer's own internal page-render worker-pool size within that
# one request (renderBookPdfs()'s own `concurrency` option, unchanged from
# the CLI's default — see that module's header comment).
ENV RENDER_CONCURRENCY=4

EXPOSE 8080

CMD ["node_modules/.bin/vite-node", "src/index.ts"]
