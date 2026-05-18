#!/usr/bin/env bash
# =========================================================
# Installs the CacheStream auto-updater on this host.
# =========================================================
# Writes a systemd unit that runs `cachestream-updater.sh` as
# root, watching the shared data volume for the marker file the
# panel's "Update" button writes. Once the marker appears, it
# does `git pull && docker compose pull && docker compose up -d`.
#
# Why this lives on the host instead of the web container:
# updating containers from inside a container needs docker.sock
# (or worse), which is a meaningful security regression. The
# marker-file pattern keeps the privileged work outside, while
# letting the panel still drive the update from one click.
#
# Usage:
#   sudo bash scripts/install-updater.sh             # install
#   sudo bash scripts/install-updater.sh --uninstall # remove
# =========================================================

set -euo pipefail

if [ "${EUID:-$(id -u)}" -ne 0 ]; then
  echo "must be run as root (try: sudo bash $0)" >&2
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

UNIT_NAME="cachestream-updater"
UNIT_PATH="/etc/systemd/system/${UNIT_NAME}.service"
WATCHER_PATH="$SCRIPT_DIR/cachestream-updater.sh"

if [ "${1:-}" = "--uninstall" ]; then
  echo "stopping + disabling ${UNIT_NAME}…"
  systemctl stop "$UNIT_NAME" 2>/dev/null || true
  systemctl disable "$UNIT_NAME" 2>/dev/null || true
  rm -f "$UNIT_PATH"
  systemctl daemon-reload
  echo "removed."
  exit 0
fi

if [ ! -x "$WATCHER_PATH" ]; then
  chmod +x "$WATCHER_PATH"
fi

# Resolve the actual host path for the named docker volume so the
# watcher can touch files the web container will see. If the user
# is running with bind mounts (./data) the named volume lookup
# will fail and we fall back to <repo>/data — that's the install
# pattern we recommend in the README anyway.
DATA_DIR=""
if command -v docker >/dev/null 2>&1; then
  DATA_DIR="$(docker volume inspect cachestream_cachestream-data --format '{{ .Mountpoint }}' 2>/dev/null || true)"
fi
if [ -z "$DATA_DIR" ]; then
  DATA_DIR="$REPO_DIR/data"
  mkdir -p "$DATA_DIR"
fi
echo "data dir: $DATA_DIR"

cat > "$UNIT_PATH" <<UNIT
[Unit]
Description=CacheStream auto-updater (watches for panel-triggered updates)
After=docker.service network-online.target
Wants=network-online.target

[Service]
Type=simple
Environment=CACHESTREAM_DIR=$REPO_DIR
Environment=CACHESTREAM_DATA=$DATA_DIR
Environment=POLL_INTERVAL=5
ExecStart=$WATCHER_PATH
Restart=on-failure
RestartSec=10
# Run as the user that owns the checkout so git pull works without
# touching /root. Falls back to root if SUDO_USER isn't set (rare).
User=${SUDO_USER:-root}
# The watcher itself doesn't need root, but it runs docker compose
# which on most installs needs docker group membership. If the
# operator's user isn't in the docker group, the unit will fail
# loud — better than silently running but not being able to update.

[Install]
WantedBy=multi-user.target
UNIT

# The .updater-installed marker tells the panel to show the Update
# button instead of install instructions. Writing it here means even
# if the data volume gets recreated, the marker is recreated next
# time the watcher boots — the watcher script also touches it on
# every start as defence-in-depth.
: > "$DATA_DIR/.updater-installed"

systemctl daemon-reload
systemctl enable --now "$UNIT_NAME"

echo ""
echo "✔ ${UNIT_NAME} installed + started"
echo ""
echo "  status:   sudo systemctl status ${UNIT_NAME}"
echo "  log:      sudo journalctl -u ${UNIT_NAME} -f"
echo "  uninstall: sudo bash $0 --uninstall"
echo ""
echo "Click the Update button on the panel's Status tab to trigger"
echo "an update. The watcher polls every ${POLL_INTERVAL:-5}s."
