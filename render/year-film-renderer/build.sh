#!/usr/bin/env bash
# Builds the year-film-renderer image from a STAGED copy of film-renderer/:
# only files git tracks or would track (git ls-files --cached --others
# --exclude-standard), so everything .gitignore excludes — every family's
# film-data/ (GBs of real media), renders, generated compositions, Studio
# caches, raw music — can never reach the Docker context, whatever
# .dockerignore semantics a Docker version applies to named contexts.
#
#   ./build.sh [extra docker build args…]
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
repo="$(git -C "$here" rev-parse --show-toplevel)"
stage="$(mktemp -d)"
trap 'rm -rf "$stage"' EXIT

(cd "$repo" && git ls-files --cached --others --exclude-standard -z film-renderer) |
  (cd "$repo" && xargs -0 -I{} rsync -R "{}" "$stage/")
size=$(du -sh "$stage/film-renderer" | cut -f1)
files=$(find "$stage/film-renderer" -type f | wc -l | tr -d ' ')
echo "staged film-renderer: $files files, $size (no film-data, renders or caches)" >&2
if [ -d "$stage/film-renderer/film-data" ]; then
  echo "refusing to build: film-data/ was staged" >&2
  exit 1
fi

docker build --build-context filmrenderer="$stage/film-renderer" -t year-film-renderer "$@" "$here"
