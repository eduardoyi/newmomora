#!/usr/bin/env bash
# F5 benchmark (docs/plans/year-film.md §10): assemble a film and render it,
# reporting wall time, peak memory, CPUs and output size as one JSON line.
#
#   bench.sh [slug]          (default: sample)
#
# Env: WORKERS (HyperFrames render workers, default auto),
#      KEEP_ALIVE=1 (sleep after rendering so the MP4 can be fetched with
#      `fly ssh sftp get /tmp/out.mp4` before the machine is destroyed).
set -euo pipefail
slug="${1:-sample}"
workers="${WORKERS:-auto}"
cd /app/film-renderer

# Peak memory in use across the whole machine/container (Chrome workers are
# separate processes), sampled every 0.5s.
peak_file=$(mktemp)
echo 0 > "$peak_file"
(
  peak=0
  while :; do
    used=$(awk '/MemTotal/{t=$2} /MemAvailable/{a=$2} END{print t-a}' /proc/meminfo)
    if [ "$used" -gt "$peak" ]; then peak=$used; echo "$peak" > "$peak_file"; fi
    sleep 0.5
  done
) &
sampler=$!
baseline=$(awk '/MemTotal/{t=$2} /MemAvailable/{a=$2} END{print t-a}' /proc/meminfo)

t0=$(date +%s.%N)
node assemble.mjs "$slug" >&2
t1=$(date +%s.%N)
(cd composition && hyperframes render -o /tmp/out.mp4 --video-frame-format jpg --workers "$workers" --quiet >&2)
t2=$(date +%s.%N)
kill "$sampler" 2>/dev/null || true

duration=$(ffprobe -v error -show_entries format=duration -of csv=p=0 /tmp/out.mp4)
bytes=$(stat -c %s /tmp/out.mp4)
total_kb=$(awk '/MemTotal/{print $2}' /proc/meminfo)
peak_kb=$(cat "$peak_file")
printf '{"slug":"%s","cpus":%s,"memTotalMB":%d,"workers":"%s","assembleSeconds":%.1f,"renderSeconds":%.1f,"filmSeconds":%.2f,"peakMemMB":%d,"baselineMemMB":%d,"outputMB":%.1f,"sha256":"%s"}\n' \
  "$slug" "$(nproc)" "$((total_kb / 1024))" "$workers" \
  "$(awk "BEGIN{print $t1 - $t0}")" "$(awk "BEGIN{print $t2 - $t1}")" "$duration" \
  "$((peak_kb / 1024))" "$((baseline / 1024))" "$(awk "BEGIN{print $bytes / 1000000}")" \
  "$(sha256sum /tmp/out.mp4 | cut -c1-16)"

if [ "${KEEP_ALIVE:-0}" = "1" ]; then
  echo "KEEP_ALIVE: /tmp/out.mp4 ready for sftp; sleeping 15 min" >&2
  sleep 900
fi
