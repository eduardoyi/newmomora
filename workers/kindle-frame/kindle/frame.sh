#!/bin/sh
# PW1 only. Direct RTC approach documented by pascalw/kindle-dash (MIT).
BASE=/mnt/us/extensions/momora-frame
RTC=/sys/devices/platform/mxc_rtc.0/wakeup_enable
LOCK=/tmp/momora-hardware-test.lock
MODE=${1:-test}
[ "$MODE" = test ] || [ "$MODE" = daily ] || exit 1
mkdir "$LOCK" 2>/dev/null || exit 1
[ ! -f "$BASE/cloud.log" ] || mv "$BASE/cloud.log" "$BASE/cloud.previous.log"
exec >> "$BASE/cloud.log" 2>&1
STOPPED=0; CHANGED=0; WIFI_CHANGED=0
log(){ printf '%s %s\n' "$(date +%s)" "$*"; }
cleanup(){
 if [ "$WIFI_CHANGED" = 1 ]; then lipc-set-prop com.lab126.cmd wirelessEnable "$OLD_WIFI"; fi
 if [ "$CHANGED" = 1 ]; then lipc-set-prop com.lab126.powerd preventScreenSaver "$OLD_PREVENT"; fi
 if [ "$STOPPED" = 1 ]; then /sbin/initctl start lab126_gui; fi
 rmdir "$LOCK";log END
}
trap cleanup EXIT
trap 'exit 1' INT TERM
[ -f "$BASE/cloud.conf" ] || { log 'Missing cloud configuration';exit 1; }
. "$BASE/cloud.conf"
case "$FRAME_URL" in https://*.workers.dev) ;; *) log 'Invalid endpoint';exit 1;; esac
[ "${#FRAME_TOKEN}" -eq 64 ] || exit 1
case "$FRAME_TOKEN" in *[!a-f0-9]*) exit 1;; esac
OLD_WIFI=$(lipc-get-prop com.lab126.cmd wirelessEnable) || exit 1
OLD_PREVENT=$(lipc-get-prop com.lab126.powerd preventScreenSaver) || exit 1
case "$OLD_WIFI:$OLD_PREVENT" in 0:0|0:1|1:0|1:1) ;; *) exit 1;; esac
[ "$(lipc-get-prop com.lab126.powerd isCharging)" = 0 ] || { log 'Unplug the cable before starting';exit 1; }
[ "$(cat "$RTC")" = 0 ] || { log 'An existing wake alarm is active';exit 1; }
case "$(/sbin/initctl status lab126_gui)" in *start/running*) ;; *) exit 1;; esac
log "START $MODE boot=$(cat /proc/sys/kernel/random/boot_id)"
# A valid clock is necessary for TLS certificate verification. Never disable it.
NOW=$(date +%s)
if [ "$NOW" -lt "$BOOTSTRAP_EPOCH" ]; then
 date -u -s "$BOOTSTRAP_TIME" >/dev/null 2>&1 || date -u -s "$BOOTSTRAP_BUSYBOX" >/dev/null 2>&1 || { log 'Set the Kindle date before running';exit 1; }
fi
[ "$(date +%s)" -ge "$BOOTSTRAP_EPOCH" ] || { log 'Clock is still incorrect';exit 1; }
fetch_file(){
 "$BASE/xh" --ignore-stdin --check-status --timeout=45 --body "$FRAME_URL$1" "Authorization:Bearer $FRAME_TOKEN" "User-Agent:MomoraFrame/1.0" > "$2" 2>/dev/null
 FETCH_CODE=$?
 [ "$FETCH_CODE" = 0 ] || log "HTTP client exit=$FETCH_CODE"
 return "$FETCH_CODE"
}
checksum(){
 if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | awk '{print $1}'
 else openssl dgst -sha256 "$1" | awk '{print $NF}';fi
}
validate_manifest(){
 awk '
 NR==1 {if(NF!=5||$1!="FRAME1"||$2!~/^[0-9]+$/||$3!~/^[0-9]+$/||length($4)!=36||$4~/[^a-f0-9-]/)exit 1;gen=$4;if($5!~/^[0-9.:-]+$/)exit 1;next}
 $1=="IMAGE" {if(NF!=4||$2!~/^[1-5]$/||seen[$2]++||length($3)!=64||$3~/[^a-f0-9]/||$4!="/image/"gen"/"$2)exit 1;images++;next}
 $1=="AT" {if(NF!=3||$2!~/^[0-9]+$/||$3!~/^[1-5]$/||$2<=last)exit 1;last=$2;times++;next}
 $1=="END" {if(NF!=1)exit 1;end++;next}
 {exit 1}
 END {if(images!=5||times<5||end!=1)exit 1}' "$1"
}
sync_batch(){
 log 'SYNC starting'
 WIFI_CHANGED=1
 lipc-set-prop com.lab126.cmd wirelessEnable 1 || return 1
 lipc-set-prop com.lab126.wifid enable 1 || return 1
 attempts=0
 until [ "$(lipc-get-prop com.lab126.wifid cmState)" = CONNECTED ];do
  attempts=$((attempts+1));[ "$attempts" -lt 15 ] || { log 'Wi-Fi not connected';return 1; };sleep 2
 done
 mkdir -p "$BASE/cloud-cache"
 STAGE="$BASE/cloud-cache/incoming"
 mkdir -p "$STAGE"
 fetch_file /manifest "$STAGE/manifest" || { log 'Manifest download failed';return 1; }
 validate_manifest "$STAGE/manifest" || { log 'Invalid manifest';return 1; }
 while read TAG SLOT SHA PATHNAME;do
  [ "$TAG" = IMAGE ] || continue
  fetch_file "$PATHNAME" "$STAGE/$SLOT.png" || return 1
  [ "$(checksum "$STAGE/$SLOT.png")" = "$SHA" ] || { log 'Image checksum failed';return 1; }
 done < "$STAGE/manifest"
 SERVER_TIME=$(awk 'NR==1{print $5}' "$STAGE/manifest")
 date -u -s "$SERVER_TIME" >/dev/null 2>&1 || { log 'Unable to sync clock';return 1; }
 # Rename complete staging directory, then switch a small pointer atomically.
 GEN=$(awk 'NR==1{print $4}' "$STAGE/manifest")
 DEST="$BASE/cloud-cache/$GEN"
 if [ -d "$DEST" ];then cp "$STAGE/manifest" "$DEST/manifest.new" && mv "$DEST/manifest.new" "$DEST/manifest" || return 1
 else mv "$STAGE" "$DEST" || return 1;fi
 printf '%s\n' "$GEN" > "$BASE/cloud-cache/current.new"
 mv "$BASE/cloud-cache/current.new" "$BASE/cloud-cache/current" || return 1
 # Delete only obsolete generated batch directories, never original Kindle content.
 for OLD in "$BASE"/cloud-cache/*;do
  [ -d "$OLD" ] || continue
  [ "$OLD" = "$DEST" ] || [ "$OLD" = "$BASE/cloud-cache/incoming" ] || rm -r "$OLD"
 done
 log 'SYNC complete: five images verified'
 return 0
}
wifi_off(){ lipc-set-prop com.lab126.wifid enable 0;lipc-set-prop com.lab126.cmd wirelessEnable 0; }
CHANGED=1
lipc-set-prop com.lab126.powerd preventScreenSaver 1 || exit 1
# Download with the normal Wi-Fi services running. Keep the existing image on failure.
SYNC_OK=0
sync_batch && SYNC_OK=1
wifi_off
[ "$MODE" != test ] || [ "$SYNC_OK" = 1 ] || { log 'Wireless test failed; see SYNC result';exit 1; }
[ -f "$BASE/cloud-cache/current" ] || { log 'No cached batch';exit 1; }
load_batch(){
 GEN=$(cat "$BASE/cloud-cache/current")
 case "$GEN" in *[!a-f0-9-]*|'') return 1;;esac
 CACHE="$BASE/cloud-cache/$GEN";MANIFEST="$CACHE/manifest"
 validate_manifest "$MANIFEST" || return 1
}
load_batch || exit 1
STOPPED=1
trap '' TERM
/sbin/initctl stop lab126_gui || exit 1
sleep 5
trap 'exit 1' TERM
show(){ "$BASE/fbink" -c -f --img "$CACHE/$1.png" || return 1;log "SHOW slot=$1";sleep 2; }
suspend_for(){
 [ "$1" -gt 0 ] || return 0
 sync
 printf '%s' "$1" > "$RTC" || return 1
 log "SLEEP seconds=$1"
 echo mem > /sys/power/state || return 1
 log "WAKE boot=$(cat /proc/sys/kernel/random/boot_id)"
 [ "$(lipc-get-prop com.lab126.powerd isCharging)" = 0 ] || return 2
}
if [ "$MODE" = test ];then
 for SLOT in 1 2;do show "$SLOT" || exit 1;suspend_for 60 || exit 1;done
 log 'Wireless two-image test complete';exit 0
fi
NEXT_SYNC=$(awk 'NR==1{print $3}' "$MANIFEST")
NOW=$(date +%s)
SLOT=$(awk -v n="$NOW" '$1=="AT"&&$2>n{print ($3==1?5:$3-1);exit}' "$MANIFEST")
[ -n "$SLOT" ] || SLOT=5
show "$SLOT" || exit 1
while :;do
 NOW=$(date +%s)
 if [ "$NOW" -ge "$NEXT_SYNC" ];then
  if sync_batch;then load_batch || exit 1;NEXT_SYNC=$(awk 'NR==1{print $3}' "$MANIFEST");else NEXT_SYNC=$((NOW+86400));fi
  wifi_off
 fi
 NEXT=$(awk -v n="$NOW" '$1=="AT"&&$2>n{print $2;exit}' "$MANIFEST")
 [ -n "$NEXT" ] || NEXT="$NEXT_SYNC"
 TARGET="$NEXT";[ "$NEXT_SYNC" -ge "$TARGET" ] || TARGET="$NEXT_SYNC"
 DELAY=$((TARGET-$(date +%s)));[ "$DELAY" -gt 0 ] || DELAY=1
 suspend_for "$DELAY" || exit 0
 NOW=$(date +%s)
 # Spurious/early wakes resume the remaining sleep, rather than exiting frame mode.
 if [ "$NOW" -ge "$NEXT" ];then
  SLOT=$(awk -v n="$NOW" '$1=="AT"&&$2<=n{s=$3}END{print s}' "$MANIFEST")
  [ -z "$SLOT" ] || show "$SLOT" || exit 1
 fi
done
