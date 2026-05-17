#!/bin/sh
# =========================================================
# cachestream-streamer entrypoint
# =========================================================
# Runs briefly as root to fix permissions on bind / named
# volumes (which Docker creates as 0:0 regardless of the
# image's USER), then exec's the real command as the
# unprivileged `streamer` user.
#
# Why this exists:
#   - The Dockerfile drops to USER streamer at build time.
#   - But docker-compose volume mounts only attach at run
#     time, AFTER the image's USER is set. Their ownership
#     is whatever the host or anonymous-volume init left
#     them as — usually root:root on first boot.
#   - That breaks `mkfifo` on /app/audio (the FIFO shared
#     with the web container) which is exactly the symptom
#     we saw in v1.5.
#
# We chown only the directories that need to be writable;
# we don't recurse into volumes that may contain large
# pre-existing data (the music library, the SQLite DB).
# =========================================================
set -e

# /app/audio is a shared IPC volume — the web container's
# `nextjs` user also writes to it (silence + music FIFOs). Both
# entrypoints chown'ing it would race each other and whoever
# lost couldn't write. So we just make it world-writable here.
# This volume only ever contains named pipes; no secrets.
if [ -d "/app/audio" ]; then
  chmod 0777 /app/audio 2>/dev/null || true
fi

# Drop privileges. `setpriv --init-groups` resets supplementary
# groups to whatever `streamer` actually belongs to.
exec setpriv --reuid=streamer --regid=streamer --init-groups -- "$@"
