#!/bin/sh
BASE=/mnt/us/extensions/momora-frame
(trap '' HUP;exec /bin/sh "$BASE/frame.sh" daily) </dev/null >/dev/null 2>&1 &
