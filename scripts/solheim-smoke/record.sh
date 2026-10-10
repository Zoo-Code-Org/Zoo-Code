#!/usr/bin/env bash
# Run inside a fresh xvfb-run display, never record an existing desktop.
set -euo pipefail
: "${DISPLAY:?Run this wrapper under xvfb-run}"
: "${SOLHEIM_SMOKE_OUT_DIR:?Set a scratch output directory}"
mkdir -p "$SOLHEIM_SMOKE_OUT_DIR"
recording="$SOLHEIM_SMOKE_OUT_DIR/smoke.mp4"

# The recorder needs display access, not provider/GitHub credentials. Fragmented
# MP4 keeps completed fragments readable if the action is forcibly interrupted.
env -i "PATH=$PATH" "DISPLAY=$DISPLAY" "XAUTHORITY=${XAUTHORITY:-}" \
    ffmpeg -nostdin -hide_banner -loglevel error -y \
    -f x11grab -video_size 1280x720 -framerate 12 -i "$DISPLAY" \
    -an -c:v libx264 -preset ultrafast -crf 28 -pix_fmt yuv420p -g 24 \
    -t 480 -fs 125829120 -movflags +frag_keyframe+empty_moov \
    "$recording" >/dev/null 2>&1 &
recorder_pid=$!

finish() {
    result=$?
    trap - EXIT
    kill -INT "$recorder_pid" 2>/dev/null || true
    # A hung recorder must not hold the action open indefinitely.
    for ((attempt = 0; attempt < 50; attempt++)); do
        kill -0 "$recorder_pid" 2>/dev/null || break
        sleep 0.1
    done
    kill -KILL "$recorder_pid" 2>/dev/null || true
    wait "$recorder_pid" 2>/dev/null || true
    if [[ ! -s "$recording" ]] || ! env -i "PATH=$PATH" \
        ffprobe -v error "$recording" >/dev/null 2>&1; then
        echo "Solheim smoke recording failed"
        [[ "$result" -ne 0 ]] || result=1
    fi
    exit "$result"
}
trap finish EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
sleep 0.5
kill -0 "$recorder_pid" 2>/dev/null || exit 1

# Arguments are used for credential-free recorder tests; CI supplies none.
if [[ "$#" -gt 0 ]]; then "$@"; else pnpm solheim:smoke; fi
