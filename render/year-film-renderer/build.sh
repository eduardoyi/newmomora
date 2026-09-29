#!/usr/bin/env bash
# Builds the year-film-renderer image from a STAGED copy of film-renderer/:
# only files git tracks or would track (git ls-files --cached --others
# --exclude-standard), so everything .gitignore excludes — every family's
# film-data/ (GBs of real media), renders, generated compositions, Studio
# caches, raw music — can never reach the Docker context, whatever
# .dockerignore semantics a Docker version applies to named contexts.
#
# The job context stages only the job (package + src) and the shared TS it
# imports, at repo-relative paths. Production images must come from a clean
# tree (no uncommitted changes in what gets staged) and are tagged by git sha.
#
#   ./build.sh [extra docker build args…]      (ALLOW_DIRTY=1 for local tests)
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
repo="$(git -C "$here" rev-parse --show-toplevel)"
stage="$(mktemp -d)"
trap 'rm -rf "$stage"' EXIT

staged_paths=(film-renderer render/year-film-renderer supabase/functions/_shared/year-film-trim.ts)
if [ -n "$(git -C "$repo" status --porcelain -- "${staged_paths[@]}")" ] && [ "${ALLOW_DIRTY:-0}" != "1" ]; then
  echo "refusing to build: uncommitted changes in ${staged_paths[*]} (ALLOW_DIRTY=1 for a local test image)" >&2
  exit 1
fi
sha="$(git -C "$repo" rev-parse --short=12 HEAD)"

(cd "$repo" && git ls-files --cached --others --exclude-standard -z film-renderer) |
  (cd "$repo" && xargs -0 -I{} rsync -R "{}" "$stage/")
size=$(du -sh "$stage/film-renderer" | cut -f1)
files=$(find "$stage/film-renderer" -type f | wc -l | tr -d ' ')
echo "staged film-renderer: $files files, $size (no film-data, renders or caches)" >&2
if [ -d "$stage/film-renderer/film-data" ]; then
  echo "refusing to build: film-data/ was staged" >&2
  exit 1
fi

mkdir -p "$stage/job"
(cd "$repo" && git ls-files --cached --others --exclude-standard -z \
  render/year-film-renderer/package.json render/year-film-renderer/package-lock.json render/year-film-renderer/src \
  supabase/functions/_shared/year-film-trim.ts) |
  (cd "$repo" && xargs -0 -I{} rsync -R "{}" "$stage/job/")

docker build --build-context filmrenderer="$stage/film-renderer" --build-context job="$stage/job" \
  -t year-film-renderer -t "year-film-renderer:$sha" "$@" "$here"
echo "built year-film-renderer:$sha" >&2
