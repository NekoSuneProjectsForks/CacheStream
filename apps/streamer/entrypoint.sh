#!/bin/sh
# =========================================================
# cachestream-streamer entrypoint
# =========================================================
# Runs briefly as root to fix permissions on the shared
# /app/audio volume + pick up the INTERNAL_API_TOKEN from
# the shared bootstrap file (written by the web container),
# then drops to `streamer` before exec'ing the Node command.
# =========================================================
set -e

# /app/audio is a shared IPC volume — the web container's
# `nextjs` user also writes to it (silence + music FIFOs +
# the bootstrap token file). World-writable is fine; only
# ever holds named pipes + a token file at mode 0644.
if [ -d "/app/audio" ]; then
  chmod 0777 /app/audio 2>/dev/null || true
fi

# ─── INTERNAL_API_TOKEN bootstrap ────────────────────────────
# If the operator pinned a value in .env, that wins. Otherwise
# we read from the shared file written by the web container.
# Wait up to 30s for the file to appear — `depends_on` in
# compose only waits for the container to START, not for the
# entrypoint to finish writing the token.
TOKEN_FILE=/app/audio/.internal-api-token
if [ -z "$INTERNAL_API_TOKEN" ]; then
  i=0
  while [ ! -s "$TOKEN_FILE" ] && [ $i -lt 60 ]; do
    if [ $i -eq 0 ]; then
      echo "[entrypoint] waiting for web container to write $TOKEN_FILE …"
    fi
    sleep 0.5
    i=$((i + 1))
  done
  if [ -s "$TOKEN_FILE" ]; then
    INTERNAL_API_TOKEN="$(cat "$TOKEN_FILE")"
    echo "[entrypoint] using INTERNAL_API_TOKEN from $TOKEN_FILE"
  else
    echo "[entrypoint] ERROR: $TOKEN_FILE never appeared. Is the web container running?"
    echo "[entrypoint] You can also pin INTERNAL_API_TOKEN= in .env."
    exit 1
  fi
fi
export INTERNAL_API_TOKEN

# Drop privileges. `setpriv --init-groups` resets supplementary
# groups to whatever `streamer` actually belongs to.
exec setpriv --reuid=streamer --regid=streamer --init-groups -- "$@"
