#!/usr/bin/env bash
# Test-only mirror of record.sh that runs a supplied command instead of the
# fixed Node driver. Production record.sh rejects supplied arguments, so the
# command-execution recorder tests target this helper. A sync test in
# scripts/solheim-smoke-workflow.test.mjs keeps this wrapper identical to
# record.sh outside the driver selection. Never use this helper in CI or
# production.
set -euo pipefail
: "${DISPLAY:?Run this wrapper under xvfb-run}"
: "${SOLHEIM_SMOKE_OUT_DIR:?Set a scratch output directory}"
mkdir -p "$SOLHEIM_SMOKE_OUT_DIR"
final_recording="$SOLHEIM_SMOKE_OUT_DIR/smoke.mp4"

# Stale output from an earlier attempt must never survive into this attempt's
# upload. Remove only these exact paths and pending artifact writes.
rm -f "$final_recording" "$SOLHEIM_SMOKE_OUT_DIR/verdict.json" "$SOLHEIM_SMOKE_OUT_DIR/trace.json" \
    "$SOLHEIM_SMOKE_OUT_DIR"/verdict.json.*.tmp "$SOLHEIM_SMOKE_OUT_DIR"/trace.json.*.tmp

# The recorder needs display access, not provider/GitHub credentials. Fragmented
# MP4 keeps completed fragments readable if the action is forcibly interrupted.
# The output muxer is forced with -f mp4 because the temporary file name has no
# mp4 suffix for ffmpeg to infer the format from.
temp_recording="$SOLHEIM_SMOKE_OUT_DIR/.smoke.mp4.$$.tmp"
env -i "PATH=$PATH" "DISPLAY=$DISPLAY" "XAUTHORITY=${XAUTHORITY:-}" \
    ffmpeg -nostdin -hide_banner -loglevel error -y \
    -f x11grab -video_size 1280x720 -framerate 12 -i "$DISPLAY" \
    -an -c:v libx264 -preset ultrafast -crf 28 -pix_fmt yuv420p -g 24 \
    -t 480 -fs 125829120 -movflags +frag_keyframe+empty_moov \
    -f mp4 "$temp_recording" >/dev/null 2>&1 &
recorder_pid=$!

provider_pid=""

# Accepted normal shutdown semantics: ffmpeg exits non-zero after its graceful
# INT or TERM shutdown, so a recorder that was still alive when shutdown started
# is judged by content validation, not by its interrupted exit status. A recorder
# that stopped on its own before shutdown must have exited zero (the -t or -fs
# limits); any other self-chosen non-zero status fails the recording even when
# ffprobe can still read the fragments.
report_recording_failure() {
    echo "Solheim smoke recording failed: $1"
    [[ "$result" -ne 0 ]] || result=1
}

# The provider child is the Node driver itself, so TERM reaches the one process
# that owns teardown and the atomic verdict and trace writes. The 30 second
# budget covers the driver teardown worst case: three 5 second host termination
# windows plus cleanup and artifact writes. KILL is the last resort for a hung
# driver; a killed driver can leave host processes behind, and no wrapper
# cleanup can repair that boundary.
provider_stop_budget="${SOLHEIM_SMOKE_STOP_BUDGET_S:-30}"
[[ "$provider_stop_budget" =~ ^[0-9]+$ ]] || provider_stop_budget=30

stop_provider() {
    [[ -n "$provider_pid" ]] || return 0
    kill -TERM "$provider_pid" 2>/dev/null || return 0
    for ((attempt = 0; attempt < provider_stop_budget * 10; attempt++)); do
        kill -0 "$provider_pid" 2>/dev/null || break
        sleep 0.1
    done
    kill -KILL "$provider_pid" 2>/dev/null || true
    wait "$provider_pid" 2>/dev/null || true
}

finish() {
    result=$?
    trap - EXIT
    # Teardown must run to completion once it starts.
    trap '' INT TERM
    local recorder_status=0 recorder_was_alive=0
    if kill -0 "$recorder_pid" 2>/dev/null; then
        recorder_was_alive=1
    fi
    # TERM is a graceful stop for ffmpeg: it finalizes the fragments before exit.
    kill -TERM "$recorder_pid" 2>/dev/null || true
    # A hung recorder must not hold the action open indefinitely.
    for ((attempt = 0; attempt < 50; attempt++)); do
        kill -0 "$recorder_pid" 2>/dev/null || break
        sleep 0.1
    done
    kill -KILL "$recorder_pid" 2>/dev/null || true
    wait "$recorder_pid" 2>/dev/null || recorder_status=$?
    # An interrupted provider must not outlive the wrapper.
    stop_provider
    if [[ "$recorder_was_alive" -eq 0 ]] && [[ "$recorder_status" -ne 0 ]]; then
        rm -f "$temp_recording"
        report_recording_failure "recorder stopped on its own with exit status $recorder_status"
    elif [[ ! -s "$temp_recording" ]]; then
        rm -f "$temp_recording"
        report_recording_failure "recorder output is missing or empty"
    elif ! env -i "PATH=$PATH" ffprobe -v error "$temp_recording" >/dev/null 2>&1; then
        rm -f "$temp_recording"
        report_recording_failure "recorder output failed ffprobe validation"
    elif mv -f "$temp_recording" "$final_recording"; then
        # Same-directory rename: atomic, so no partially written final exists.
        # The published, nonempty final is the only success marker.
        :
    else
        rm -f "$temp_recording"
        report_recording_failure "validated recording could not be published"
    fi
    exit "$result"
}
trap finish EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
sleep 0.5
kill -0 "$recorder_pid" 2>/dev/null || exit 1

# The supplied command stands in for the Node driver. Backgrounding the
# provider keeps the signal traps responsive during the run.
"$@" &
provider_pid=$!
provider_status=0
wait "$provider_pid" || provider_status=$?
exit "$provider_status"
