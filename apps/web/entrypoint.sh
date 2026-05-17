#!/bin/sh
# =========================================================
# cachestream-web entrypoint
# =========================================================
# Same purpose as the streamer entrypoint: fix volume-mount
# ownership while still running as root, then drop to the
# `nextjs` user before exec'ing the Node server.
#
# Writable mounts on the web side:
#   /app/data         — SQLite DB, branding logos, covers
#   /app/audio        — FIFO shared with the streamer
#   /app/media/music  — uploaded tracks
#   /app/media/vods   — uploaded VODs
# =========================================================
set -e

# /app/audio is shared with the streamer container. Both
# entrypoints chown'ing it would race; make it world-writable
# instead. Only ever holds named pipes — no secrets.
if [ -d "/app/audio" ]; then
  chmod 0777 /app/audio 2>/dev/null || true
fi

# These are web-only mounts; safe to chown to our user.
for dir in /app/data /app/media/music /app/media/vods; do
  if [ -d "$dir" ]; then
    chown -R nextjs:nextjs "$dir" 2>/dev/null || true
    chmod 0775 "$dir" 2>/dev/null || true
  fi
done

exec setpriv --reuid=nextjs --regid=nextjs --init-groups -- "$@"
