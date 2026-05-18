#!/usr/bin/env bash
# =========================================================
# CacheStream updater watcher
# =========================================================
# Runs on the host (NOT in a container). Watches the shared
# data volume for a marker file written by the web container's
# /api/system/update endpoint. When the marker appears, runs:
#
#   git pull --ff-only
#   docker compose pull
#   docker compose up -d --build
#
# …then removes the marker. A short log of each run is kept at
# $DATA_DIR/.update-log so the panel can show progress / errors.
#
# Install with: sudo bash scripts/install-updater.sh
# Removed with:  sudo bash scripts/install-updater.sh --uninstall
#
# Environment variables (override defaults via the systemd unit
# in install-updater.sh):
#   CACHESTREAM_DIR    — path to the CacheStream checkout
#                        (default: directory containing this script's parent)
#   CACHESTREAM_DATA   — path to the data volume on the host
#                        (default: <CACHESTREAM_DIR>/data)
#   POLL_INTERVAL      — seconds between marker checks (default: 5)
# =========================================================

set -u

# Resolve the repo root from this script's location so the watcher
# doesn't care where the operator cloned CacheStream.
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
DEFAULT_REPO="$(cd "$SCRIPT_DIR/.." && pwd)"

REPO_DIR="${CACHESTREAM_DIR:-$DEFAULT_REPO}"
# data lives inside a docker named volume by default; the install
# script resolves the actual path on the host for us. Operators can
# also override at install time.
DATA_DIR="${CACHESTREAM_DATA:-$REPO_DIR/data}"
POLL="${POLL_INTERVAL:-5}"

MARKER="$DATA_DIR/.update-requested"
LOGFILE="$DATA_DIR/.update-log"
INSTALLED="$DATA_DIR/.updater-installed"

mkdir -p "$DATA_DIR"
# Touch the install marker so the panel knows we're alive. The
# install script also touches this, so it's safe to do here every
# boot — handles the case where the data volume gets recreated
# but the systemd unit is still installed.
: > "$INSTALLED" 2>/dev/null || true

log() {
  printf '%s %s\n' "$(date -u +%FT%TZ)" "$*" | tee -a "$LOGFILE" >&2
}

run_update() {
  local target_json target
  target_json="$(cat "$MARKER" 2>/dev/null || true)"
  # Pull "target" out of the JSON without a jq dep. The marker is
  # always written by our own /api/system/update so the shape is
  # known + safe. Falls back to "latest" if we can't parse.
  target="$(printf '%s' "$target_json" | sed -n 's/.*"target":"\([^"]*\)".*/\1/p')"
  [ -z "$target" ] && target="latest"

  log "update requested (target=$target)"

  # Truncate log to keep it under ~50KB so the panel display stays
  # snappy. Keeping the last few runs is plenty for debugging.
  if [ -f "$LOGFILE" ] && [ "$(wc -c < "$LOGFILE")" -gt 51200 ]; then
    tail -c 30720 "$LOGFILE" > "$LOGFILE.tmp" && mv "$LOGFILE.tmp" "$LOGFILE"
  fi

  cd "$REPO_DIR" || { log "ERROR: cannot cd to $REPO_DIR"; rm -f "$MARKER"; return 1; }

  if [ "$target" = "latest" ] || [ -z "$target" ]; then
    log "git pull --ff-only"
    git pull --ff-only 2>&1 | tee -a "$LOGFILE" || { log "ERROR: git pull failed"; rm -f "$MARKER"; return 1; }
  else
    log "git fetch + checkout $target"
    git fetch --tags 2>&1 | tee -a "$LOGFILE"
    git checkout "$target" 2>&1 | tee -a "$LOGFILE" || { log "ERROR: checkout $target failed"; rm -f "$MARKER"; return 1; }
  fi

  log "docker compose pull"
  docker compose pull 2>&1 | tee -a "$LOGFILE" || log "WARN: docker compose pull had non-fatal errors"

  log "docker compose up -d --build"
  docker compose up -d --build 2>&1 | tee -a "$LOGFILE" || { log "ERROR: docker compose up failed"; rm -f "$MARKER"; return 1; }

  log "update complete"
  rm -f "$MARKER"
}

log "cachestream-updater started — watching $MARKER (poll=${POLL}s)"

# Main loop. inotifywait would be nicer but adds a dep; a 5s poll
# is plenty for "click button, wait 30-60s for the rebuild" UX.
while true; do
  if [ -f "$MARKER" ]; then
    run_update || log "update run failed"
  fi
  sleep "$POLL"
done
