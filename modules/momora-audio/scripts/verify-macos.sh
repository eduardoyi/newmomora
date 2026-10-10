#!/usr/bin/env bash
# Verifies the iOS audio core (modules/momora-audio/ios/*.swift, everything except
# MomoraAudioModule.swift, which needs ExpoModulesCore) outside Xcode:
#
#   1. compiles it with scripts/cli-main.swift for macOS (and for the iOS simulator SDK);
#   2. generates synthetic inputs with ffmpeg lavfi (tones/noise/silence only: the repo
#      is public, so NO human voices) in m4a/wav/caf/aiff/mp3 (+ an Ogg Opus, which iOS
#      must refuse for now);
#   3. runs probe / analyze / render and checks
#        - durations,
#        - energies against a reference computed from ffmpeg-decoded PCM with the
#          plan's "Energy bucket spec" (independent Python implementation below),
#        - render output is AAC-LC, mono, 48 kHz, the right length, and time-aligned
#          (a noise burst in the source lands where it should in the trimmed output),
#        - stable error codes (unsupported_format / decode_failed / too_long / io_failed);
#   4. optionally repeats the whole suite inside an iOS simulator via `simctl spawn`.
#
# Not part of CI (needs macOS, Xcode and ffmpeg). See docs/features/audio-memories.md.
#
# Usage:  scripts/verify-macos.sh [--skip-sim] [--keep]
#         SIM_UDID=<udid> to choose the simulator (default: first available iPhone on
#         the newest iOS runtime; it is shut down afterwards if this script booted it).
set -euo pipefail

SKIP_SIM=0
KEEP=0
for arg in "$@"; do
  case "$arg" in
    --skip-sim) SKIP_SIM=1 ;;
    --keep) KEEP=1 ;;
    *) echo "unknown option: $arg" >&2; exit 2 ;;
  esac
done

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
IOS_DIR="$HERE/../ios"
CORE_FILES=("$IOS_DIR/AudioErrors.swift" "$IOS_DIR/AudioDecoder.swift" "$IOS_DIR/AudioProbe.swift" "$IOS_DIR/AudioAnalysis.swift" "$IOS_DIR/AudioRender.swift")

for tool in swiftc ffmpeg ffprobe python3 afinfo; do
  command -v "$tool" >/dev/null || { echo "missing required tool: $tool" >&2; exit 2; }
done

WORK="$(mktemp -d "${TMPDIR:-/tmp}/momora-audio-verify.XXXXXX")"
BOOTED_BY_US=""
cleanup() {
  if [[ -n "$BOOTED_BY_US" ]]; then xcrun simctl shutdown "$BOOTED_BY_US" >/dev/null 2>&1 || true; fi
  if [[ "$KEEP" == 1 ]]; then echo "kept work dir: $WORK"; else rm -rf "$WORK"; fi
}
trap cleanup EXIT

mkdir -p "$WORK/build" "$WORK/in" "$WORK/out"
cp "$HERE/cli-main.swift" "$WORK/build/main.swift"

echo "== compile (macOS)"
swiftc -O -o "$WORK/build/cli-macos" "${CORE_FILES[@]}" "$WORK/build/main.swift"

echo "== compile (iOS simulator SDK, arm64, deployment target 16.4 = podspec)"
SIM_SDK="$(xcrun --sdk iphonesimulator --show-sdk-path)"
swiftc -O -target arm64-apple-ios16.4-simulator -sdk "$SIM_SDK" \
  -o "$WORK/build/cli-sim" "${CORE_FILES[@]}" "$WORK/build/main.swift"
echo "   ok: core builds for the iOS simulator SDK"

echo "== generate inputs (ffmpeg lavfi; tones + noise bursts only)"
# 5 s: quiet tone with a loud 100 ms noise burst at t = 2.000 s. The burst is the
# alignment marker for trim checks; a different tone per channel proves the mean downmix.
BURST_L='0.05*sin(2*PI*440*t)+0.5*between(t,2,2.1)*(random(0)*2-1)'
BURST_R='0.05*sin(2*PI*660*t)+0.5*between(t,2,2.1)*(random(1)*2-1)'
ff() { ffmpeg -nostdin -hide_banner -loglevel error -y "$@"; }
src_stereo() { echo "aevalsrc='$BURST_L|$BURST_R':s=$1:d=5"; }
src_mono() { echo "aevalsrc='$BURST_L':s=$1:d=5"; }
IN="$WORK/in"
ff -f lavfi -i "$(src_stereo 44100)" -c:a aac -b:a 128k "$IN/burst_stereo_44k.m4a"
ff -f lavfi -i "$(src_mono 16000)"   -c:a aac -b:a 48k  "$IN/burst_mono_16k.m4a"
ff -f lavfi -i "$(src_mono 48000)"   -c:a pcm_s16le     "$IN/burst_mono_48k.wav"
ff -f lavfi -i "$(src_stereo 22050)" -c:a pcm_s16be -f caf "$IN/burst_stereo_22k.caf"
ff -f lavfi -i "$(src_stereo 32000)" -c:a pcm_s16be -f aiff "$IN/burst_stereo_32k.aiff"
ff -f lavfi -i "$(src_mono 44100)"   -c:a libmp3lame -b:a 96k "$IN/burst_mono_44k.mp3"
ff -f lavfi -i "anullsrc=r=44100:cl=mono" -t 5 -c:a pcm_s16le "$IN/silence_mono_44k.wav"
ff -f lavfi -i "$(src_mono 48000)" -t 0.3 -c:a pcm_s16le "$IN/short_mono_48k.wav"
ff -f lavfi -i "anoisesrc=d=5:c=pink:a=0.3:r=44100" -c:a pcm_s16le "$IN/noise_mono_44k.wav"
ff -f lavfi -i "$(src_mono 48000)"   -c:a libopus -b:a 32k "$IN/burst_mono.ogg"
ff -i "$IN/burst_stereo_44k.m4a" -c copy -metadata creation_time=2026-03-04T05:06:07Z "$IN/dated.m4a"
# 31 minutes of 8 kHz silence (~30 MB) for the too_long guard.
ff -f lavfi -i "anullsrc=r=8000:cl=mono" -t 1860 -c:a pcm_s16le "$IN/long_31min.wav"
echo "not audio" > "$IN/not_audio.m4a"
head -c 3000 "$IN/burst_stereo_44k.m4a" > "$IN/truncated.m4a"

run_suite() {
  local label="$1" cli="$2" runner="$3"
  echo
  echo "== suite: $label"
  python3 -I - "$cli" "$IN" "$WORK/out/$label" "$runner" <<'PY'
import array, json, math, os, re, subprocess, sys

cli, indir, outdir, runner = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4]
os.makedirs(outdir, exist_ok=True)
failures = []
checks = 0

def check(cond, msg):
    global checks
    checks += 1
    if not cond:
        failures.append(msg)
        print("   FAIL:", msg)

def run(*args):
    cmd = (runner.split() if runner else []) + [cli, *map(str, args)]
    p = subprocess.run(cmd, capture_output=True, text=True)
    line = p.stdout.strip().splitlines()[-1] if p.stdout.strip() else "{}"
    try:
        return json.loads(line)
    except Exception:
        failures.append("unparseable output for %s: %r %r" % (args[:2], p.stdout[-200:], p.stderr[-200:]))
        return {"error": "unparseable"}

def ffprobe(path):
    out = subprocess.run(
        ["ffprobe", "-v", "error", "-select_streams", "a:0", "-show_entries",
         "stream=codec_name,profile,channels,sample_rate,bit_rate:format=duration,bit_rate",
         "-of", "json", path], capture_output=True, text=True).stdout
    j = json.loads(out)
    return j["streams"][0], j["format"]

def afinfo_valid_ms(path):
    # CoreAudio's view of the file: valid frames exclude encoder priming/padding, which
    # is what players (AVPlayer, expo-audio) will actually play.
    out = subprocess.run(["afinfo", path], capture_output=True, text=True).stdout
    m = re.search(r"estimated duration: ([0-9.]+) sec", out)
    return float(m.group(1)) * 1000 if m else None

def ffmpeg_pcm(path):
    """Decode with ffmpeg at the native rate, keeping channels. Returns (rate, ch, interleaved floats)."""
    s, _ = ffprobe(path)
    rate, ch = int(s["sample_rate"]), int(s["channels"])
    raw = subprocess.run(["ffmpeg", "-nostdin", "-v", "error", "-i", path, "-f", "f32le", "-ar", str(rate), "-"],
                         capture_output=True).stdout
    a = array.array("f")
    a.frombytes(raw[: len(raw) // 4 * 4])
    return rate, ch, a

def apple_pcm(path, tmpdir):
    """Decode with CoreAudio's own afconvert (the decoder AVAudioFile uses) to float32 WAV.

    Lossy codecs (AAC, mp3) are not bit-identical across decoders and differ in how they
    treat encoder priming/padding (ffmpeg and Apple disagree by up to ~56 ms of length), so
    the bucket-math reference for those is built from Apple-decoded PCM. This still checks
    chunking, mean downmix, bucket sizing and energy math independently; ffmpeg is used
    as a looser cross-check of duration and loudness.
    """
    wav = os.path.join(tmpdir, os.path.basename(path) + ".apple.wav")
    subprocess.run(["afconvert", "-f", "WAVE", "-d", "LEF32", path, wav], check=True, capture_output=True)
    return ffmpeg_pcm(wav)

def mono_mean(a, ch):
    # Spec: arithmetic mean of channels.
    if ch == 1:
        return list(a)
    return [sum(a[i:i + ch]) / ch for i in range(0, len(a) - ch + 1, ch)]

def energies_ref(mono, rate, max_buckets, min_bucket_ms):
    """Independent implementation of the plan's 'Energy bucket spec'."""
    n = len(mono)
    duration_ms_estimate = n * 1000 / rate
    bucket_ms = max(min_bucket_ms, math.ceil(duration_ms_estimate / max_buckets))
    spb = max(1, int(math.floor(bucket_ms * rate / 1000 + 0.5)))
    energies = []
    for i in range(0, n, spb):
        seg = mono[i:i + spb]
        energies.append(sum(x * x for x in seg) / len(seg))
    return {"durationMs": int(math.floor(n * 1000 / rate + 0.5)), "bucketMs": bucket_ms, "energies": energies}

def burst_onset_ms(energies, bucket_ms, thresh_rms=0.08):
    for i, e in enumerate(energies):
        if e > thresh_rms ** 2:
            return i * bucket_ms
    return None

MAXB, MINB = 97, 20      # 97 keeps ceil(5000/97)=52 away from a rounding boundary
WIN_START, WIN_END = 1000, 3500

sources = [
    # name, lossless?, has burst
    ("burst_stereo_44k.m4a", False),
    ("burst_mono_16k.m4a", False),
    ("burst_mono_48k.wav", True),
    ("burst_stereo_22k.caf", True),
    ("burst_stereo_32k.aiff", True),
    ("burst_mono_44k.mp3", False),
]

for name, lossless in sources:
    path = os.path.join(indir, name)
    print("-- %s" % name)
    rate, ch, pcm = ffmpeg_pcm(path) if lossless else apple_pcm(path, outdir)
    mono = mono_mean(pcm, ch)
    if not lossless:
        frate, fch, fpcm = ffmpeg_pcm(path)
        fmono = mono_mean(fpcm, fch)
        d = abs(len(fmono) - len(mono)) * 1000 / rate
        e_a = sum(x * x for x in mono) / len(mono)
        e_f = sum(x * x for x in fmono) / len(fmono)
        check(d <= 70, "%s ffmpeg vs Apple decoded length differs by %.0f ms" % (name, d))
        check(abs(10 * math.log10(e_a / e_f)) <= 0.5, "%s ffmpeg vs Apple total energy" % name)
        print("   ffmpeg cross-check: length differs by %.1f ms, energy %.3f dB" % (d, 10 * math.log10(e_a / e_f)))

    # probe
    p = run("probe", path)
    check("error" not in p, "%s probe errored: %s" % (name, p))
    check(p.get("sizeBytes") == os.path.getsize(path), "%s probe sizeBytes" % name)
    check(int(p.get("sampleRate", 0)) == rate, "%s probe sampleRate %s != %s" % (name, p.get("sampleRate"), rate))
    check(p.get("channels") == ch, "%s probe channels %s != %s" % (name, p.get("channels"), ch))
    expect_container = {"m4a": "mp4", "wav": "wav", "caf": "caf", "aiff": "aiff", "mp3": "mp3"}[name.rsplit(".", 1)[1]]
    expect_codec = {"m4a": "aac", "wav": "pcm", "caf": "pcm", "aiff": "pcm", "mp3": "mp3"}[name.rsplit(".", 1)[1]]
    check(p.get("container") == expect_container, "%s container %s" % (name, p.get("container")))
    check(p.get("codec") == expect_codec, "%s codec %s" % (name, p.get("codec")))
    check(abs(p.get("durationMs", 0) - 5000) <= 60 if name != "short" else True, "%s probe duration %s" % (name, p.get("durationMs")))
    print("   probe: %s" % json.dumps({k: p[k] for k in sorted(p) if k != "sizeBytes"}))

    # analyze vs reference
    a = run("analyze", path, MAXB, MINB)
    check("error" not in a, "%s analyze errored: %s" % (name, a))
    ref = energies_ref(mono, rate, MAXB, MINB)
    check(a.get("bucketMs") == ref["bucketMs"], "%s bucketMs %s != %s" % (name, a.get("bucketMs"), ref["bucketMs"]))
    d_ms = abs(a.get("durationMs", 0) - ref["durationMs"])
    tol_ms = 0
    check(d_ms <= tol_ms, "%s analyze durationMs %s vs ref %s" % (name, a.get("durationMs"), ref["durationMs"]))
    ne, nr = len(a["energies"]), len(ref["energies"])
    check(ne == nr, "%s bucket count %d vs %d" % (name, ne, nr))
    worst = 0.0
    for x, y in zip(a["energies"], ref["energies"]):
        # relative error against the larger of the two with a tiny floor
        err = abs(x - y) / max(x, y, 1e-9)
        worst = max(worst, err)
    # Same PCM on both sides: only float32-vs-double rounding may differ.
    limit = 1e-4
    check(worst <= limit, "%s energies worst relative error %.3g > %.3g" % (name, worst, limit))
    print("   analyze: dur %d ms (ref %d), bucketMs %d, %d buckets (ref %d), worst rel err %.2e"
          % (a["durationMs"], ref["durationMs"], a["bucketMs"], ne, nr, worst))

    # render a window
    out = os.path.join(outdir, name.rsplit(".", 1)[0] + "_trim.m4a")
    r = run("render", path, out, WIN_START, WIN_END, 96000)
    check("error" not in r, "%s render errored: %s" % (name, r))
    if "error" in r:
        continue
    check(r["uri"].startswith("file://"), "%s render uri" % name)
    check(abs(r["durationMs"] - (WIN_END - WIN_START)) <= 3, "%s render durationMs %s" % (name, r["durationMs"]))
    check(r["sizeBytes"] == os.path.getsize(out), "%s render sizeBytes" % name)
    s, f = ffprobe(out)
    check(s["codec_name"] == "aac" and s.get("profile") == "LC", "%s output codec/profile %s/%s" % (name, s["codec_name"], s.get("profile")))
    check(int(s["channels"]) == 1, "%s output channels %s" % (name, s["channels"]))
    check(int(s["sample_rate"]) == 48000, "%s output sample rate %s" % (name, s["sample_rate"]))
    valid_ms = afinfo_valid_ms(out)
    check(valid_ms is not None and abs(valid_ms - (WIN_END - WIN_START)) <= 5, "%s CoreAudio valid duration %s" % (name, valid_ms))
    # Alignment: decode the OUTPUT with the same module (AVAudioFile applies priming/edit
    # info the way players do) at 2 ms buckets and look for the burst.
    oa = run("analyze", out, 100000, 2)
    onset = burst_onset_ms(oa["energies"], oa["bucketMs"])
    src_onset = burst_onset_ms(energies_ref(mono, rate, 100000, 2)["energies"], 2)
    want = None if src_onset is None else src_onset - WIN_START
    check(onset is not None and want is not None and abs(onset - want) <= 15,
          "%s burst onset in output %s ms, expected ~%s ms" % (name, onset, want))
    # Independent decode of the output (ffmpeg): total energy of the window must match the source window.
    orate, och, opcm = ffmpeg_pcm(out)
    lo, hi = int(WIN_START * rate / 1000), int(WIN_END * rate / 1000)
    seg = mono[lo:hi]
    e_src = sum(x * x for x in seg) / len(seg)
    omono = mono_mean(opcm, och)
    e_out = sum(x * x for x in omono) / len(omono)
    db = 10 * math.log10(e_out / e_src)
    # AAC at 96 kbps low-passes the white-noise burst, so a fraction of a dB is expected.
    check(abs(db) <= 1.5, "%s window loudness differs by %.2f dB" % (name, db))
    print("   render: %d ms, %d bytes, %s %s %dch %s Hz, CoreAudio valid %.1f ms, burst %s ms (want %s), window dB diff %.2f"
          % (r["durationMs"], r["sizeBytes"], s["codec_name"], s.get("profile"), int(s["channels"]), s["sample_rate"], valid_ms, onset, want, db))

# Window end beyond EOF clamps; full-range render keeps the length.
print("-- window edge cases")
src = os.path.join(indir, "burst_mono_48k.wav")
r = run("render", src, os.path.join(outdir, "tail.m4a"), 3000, 99999, 96000)
check("error" not in r and abs(r["durationMs"] - 2000) <= 3, "render past EOF clamps: %s" % r)
r = run("render", src, os.path.join(outdir, "full.m4a"), 0, 5000, 96000)
check("error" not in r and abs(r["durationMs"] - 5000) <= 3, "full-range render: %s" % r)
r = run("render", src, os.path.join(outdir, "bad.m4a"), 2000, 2000, 96000)
check(r.get("error") == "decode_failed", "empty selection -> decode_failed: %s" % r)
check(not os.path.exists(os.path.join(outdir, "bad.m4a")), "no partial output after failed render")
r = run("render", src, os.path.join(outdir, "past.m4a"), 9000, 12000, 96000)
check(r.get("error") == "decode_failed", "selection past EOF -> decode_failed: %s" % r)
check(not os.path.exists(os.path.join(outdir, "past.m4a")), "partial output deleted when selection is empty")
r = run("render", src, src, 0, 1000, 96000)
check(r.get("error") == "io_failed", "output == input refused: %s" % r)
print("   ok")

# Short file: single partial bucket handling, minBucketMs honoured.
print("-- short file")
short = os.path.join(indir, "short_mono_48k.wav")
rate, ch, pcm = ffmpeg_pcm(short)
ref = energies_ref(mono_mean(pcm, ch), rate, 4000, 20)
a = run("analyze", short, 4000, 20)
check(a.get("bucketMs") == 20 and len(a["energies"]) == len(ref["energies"]) and a["durationMs"] == ref["durationMs"],
      "short file shape %s vs %s" % ({k: a.get(k) for k in ("bucketMs", "durationMs")}, ref["durationMs"]))
check(all(abs(x - y) <= 1e-6 * max(x, y, 1e-9) + 1e-12 for x, y in zip(a["energies"], ref["energies"])), "short file energies")
print("   %d buckets of %d ms, durationMs %d" % (len(a["energies"]), a["bucketMs"], a["durationMs"]))

# Silence -> all-zero energies, still renders.
print("-- silence")
sil = os.path.join(indir, "silence_mono_44k.wav")
a = run("analyze", sil, MAXB, MINB)
check("error" not in a and max(a["energies"]) == 0.0 and a["durationMs"] == 5000, "silence energies: %s" % str(a)[:120])
r = run("render", sil, os.path.join(outdir, "silence.m4a"), 0, 5000, 96000)
check("error" not in r and abs(r["durationMs"] - 5000) <= 3, "silence render: %s" % r)
print("   ok")

# Bitrate is honoured (noise needs the bits; speech-like content may use fewer).
print("-- bitrate")
noise = os.path.join(indir, "noise_mono_44k.wav")
r = run("render", noise, os.path.join(outdir, "noise.m4a"), 0, 5000, 96000)
_, f = ffprobe(os.path.join(outdir, "noise.m4a"))
kbps = int(f["bit_rate"]) / 1000
check(80 <= kbps <= 112, "noise @96k renders at %.1f kbps" % kbps)
r64 = run("render", noise, os.path.join(outdir, "noise64.m4a"), 0, 5000, 64000)
_, f64 = ffprobe(os.path.join(outdir, "noise64.m4a"))
check(r64.get("sizeBytes", 1e9) < r.get("sizeBytes", 0), "64 kbps output smaller than 96 kbps")
print("   96k -> %.1f kbps, 64k -> %.1f kbps" % (kbps, int(f64["bit_rate"]) / 1000))

# creationDate from container metadata.
print("-- creationDate")
p = run("probe", os.path.join(indir, "dated.m4a"))
check(p.get("creationDate") == "2026-03-04T05:06:07.000Z", "creationDate %s" % p.get("creationDate"))
p = run("probe", os.path.join(indir, "burst_mono_48k.wav"))
check(p.get("creationDate") is None, "wav creationDate null: %s" % p.get("creationDate"))
print("   ok")

# Error codes.
print("-- error codes")
def expect_err(args, code, label):
    r = run(*args)
    check(r.get("error") == code, "%s -> %s (got %s)" % (label, code, r))
    msg = r.get("message", "")
    check(indir not in msg and outdir not in msg and "/" not in msg, "%s: message leaks a path: %r" % (label, msg))
    return r

ogg = os.path.join(indir, "burst_mono.ogg")
po = run("probe", ogg)
check(po.get("container") == "ogg" and po.get("codec") == "opus" and po.get("channels") == 1
      and po.get("sampleRate") == 48000 and abs(po.get("durationMs", 0) - 5000) <= 40, "ogg probe: %s" % po)
expect_err(["analyze", ogg, 100, 20], "unsupported_format", "ogg analyze")
expect_err(["render", ogg, os.path.join(outdir, "ogg.m4a"), 0, 1000, 96000], "unsupported_format", "ogg render")
check(not os.path.exists(os.path.join(outdir, "ogg.m4a")), "no output for refused ogg")
expect_err(["analyze", os.path.join(indir, "not_audio.m4a"), 100, 20], "unsupported_format", "text file")
expect_err(["probe", os.path.join(indir, "not_audio.m4a")], "unsupported_format", "text file probe")
r = run("analyze", os.path.join(indir, "truncated.m4a"), 100, 20)
check(r.get("error") in ("decode_failed", "unsupported_format"), "truncated m4a -> %s" % r)
expect_err(["probe", os.path.join(indir, "missing.m4a")], "io_failed", "missing file")
long_ = os.path.join(indir, "long_31min.wav")
pl = run("probe", long_)
check("error" not in pl and abs(pl.get("durationMs", 0) - 1860000) <= 100, "31 min probe still reports duration: %s" % pl)
expect_err(["analyze", long_, 100, 20], "too_long", "31 min analyze")
expect_err(["render", long_, os.path.join(outdir, "long.m4a"), 0, 1000, 96000], "too_long", "31 min render")
check(not os.path.exists(os.path.join(outdir, "long.m4a")), "no output for too_long")
print("   ok")

print()
print("%s: %d checks, %d failed" % ("PASS" if not failures else "FAIL", checks, len(failures)))
sys.exit(1 if failures else 0)
PY
}

run_suite macos "$WORK/build/cli-macos" ""

if [[ "$SKIP_SIM" == 1 ]]; then
  echo "== simulator run skipped (--skip-sim)"
  exit 0
fi

echo
echo "== iOS simulator run"
UDID="${SIM_UDID:-}"
if [[ -z "$UDID" ]]; then
  # Prefer an already-booted device, else the newest available iPhone.
  UDID="$(xcrun simctl list devices booted -j | python3 -c 'import json,sys; d=json.load(sys.stdin)["devices"]; print(next((x["udid"] for v in d.values() for x in v if x["state"]=="Booted"), ""))')"
fi
if [[ -z "$UDID" ]]; then
  UDID="$(xcrun simctl list devices available -j | python3 -c '
import json,sys,re
d=json.load(sys.stdin)["devices"]
best=None
for rt,devs in d.items():
    m=re.search(r"iOS-(\d+)-(\d+)",rt)
    if not m: continue
    v=(int(m[1]),int(m[2]))
    for x in devs:
        if "iPhone" in x["name"] and (best is None or v>best[0]): best=(v,x["udid"])
print(best[1] if best else "")')"
  if [[ -n "$UDID" ]]; then
    xcrun simctl boot "$UDID" && BOOTED_BY_US="$UDID"
    xcrun simctl bootstatus "$UDID" >/dev/null 2>&1 || true
  fi
fi
if [[ -z "$UDID" ]]; then
  echo "   no iOS simulator available; compile-only proof above stands"
  exit 0
fi
echo "   simulator: $(xcrun simctl list devices | grep "$UDID" | head -1 | sed 's/^ *//')"
run_suite ios-sim "$WORK/build/cli-sim" "xcrun simctl spawn $UDID"
