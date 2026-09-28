# syntax=docker/dockerfile:1.7
#
# Year Film render worker — F5 benchmark image (docs/plans/year-film.md §7.4,
# §10 F5). The §7.4 service shell (HMAC /render, R2 in/out, status) comes in
# P1; this image is what it will wrap: Node 22, headless Chrome, ffmpeg, the
# pinned HyperFrames CLI, and film-renderer/ (assembler, composition
# template, fonts, music beds).
#
# ── film-renderer as a SEPARATE, PII-excluded build context ───────────────
# Same mechanism as render/memory-book-renderer: film-renderer/ is brought in
# as a named build context, and film-renderer/.dockerignore excludes every
# family's film-data/, renders and Studio caches at the Docker layer.
#
#   docker build --build-context filmrenderer=../../film-renderer -t year-film-renderer .
#
# (run from render/year-film-renderer/).
#
# ── linux/amd64 ───────────────────────────────────────────────────────────
# Fly Machines are x86_64 and Chrome for Testing has no linux/arm64 build
# (see the book renderer's Dockerfile for the failure this pin prevents).
FROM --platform=linux/amd64 node:22-bookworm-slim

# Chrome's shared libraries + ffmpeg/ffprobe (assembler + HyperFrames) +
# procps (the benchmark's memory sampling).
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    ffmpeg \
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
    procps \
    xdg-utils \
  && rm -rf /var/lib/apt/lists/*

# The pinned CLI (same pin as film-renderer/composition/package.json) and its
# Chrome, fetched now — a scale-to-zero machine must never download at
# render time. Telemetry off: this machine renders family films.
#
# Chrome is placed with curl + unzip in the exact cache layout HyperFrames'
# own downloader uses (same Chrome for Testing build), not via
# `hyperframes browser ensure`: that hung for 20+ minutes after the download
# under amd64 emulation on Apple Silicon (F5, 2026-09-28). `browser path`
# then proves the CLI finds it without downloading.
RUN apt-get update && apt-get install -y --no-install-recommends curl unzip \
  && rm -rf /var/lib/apt/lists/*
ARG CHROME_VERSION=152.0.7977.30
RUN npm install -g hyperframes@0.8.80 \
  && dir="/root/.cache/hyperframes/chrome/chrome-headless-shell/linux-${CHROME_VERSION}" \
  && mkdir -p "$dir" \
  && curl -fsSL -o /tmp/chrome-headless-shell.zip \
     "https://storage.googleapis.com/chrome-for-testing-public/${CHROME_VERSION}/linux64/chrome-headless-shell-linux64.zip" \
  && unzip -q /tmp/chrome-headless-shell.zip -d "$dir" \
  && rm /tmp/chrome-headless-shell.zip \
  && hyperframes browser path | tee /dev/stderr | grep -q "linux-${CHROME_VERSION}" \
  && hyperframes telemetry disable

WORKDIR /app/film-renderer
COPY --from=filmrenderer . .

# The synthetic sample film — the only film this image renders until P1
# (no real family data leaves the laptop before then).
RUN node sample/make-sample.mjs

COPY bench.sh /app/bench.sh
RUN chmod +x /app/bench.sh

ENTRYPOINT ["/app/bench.sh"]
CMD ["sample"]
