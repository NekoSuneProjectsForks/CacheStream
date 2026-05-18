#!/bin/sh
# =========================================================
# cachestream-web entrypoint
# =========================================================
# Runs briefly as root to fix volume permissions + bootstrap
# the shared INTERNAL_API_TOKEN, then drops to `nextjs` before
# exec'ing the Node server.
#
# Writable mounts on the web side:
#   /app/data         — SQLite DB, branding logos, covers
#   /app/audio        — FIFOs + shared bootstrap files
#   /app/media/music  — uploaded tracks
#   /app/media/vods   — uploaded VODs
# =========================================================
set -e

# /app/audio is shared with the streamer container. Both
# entrypoints chown'ing it would race; make it world-writable
# instead. Holds FIFOs + the bootstrap token file (mode 0644).
if [ -d "/app/audio" ]; then
  chmod 0777 /app/audio 2>/dev/null || true
fi

# Existing audio FIFOs may have been created by an older boot
# with the default mkfifo umask (0644), which prevents the
# streamer (different UID) from opening them O_RDWR. Re-chmod
# while we're still root, before dropping privileges.
for fifo in /app/audio/silence.fifo /app/audio/music.fifo; do
  if [ -p "$fifo" ]; then
    chmod 0666 "$fifo" 2>/dev/null || true
  fi
done

# These are web-only mounts; safe to chown to our user.
for dir in /app/data /app/media/music /app/media/vods; do
  if [ -d "$dir" ]; then
    chown -R nextjs:nextjs "$dir" 2>/dev/null || true
    chmod 0775 "$dir" 2>/dev/null || true
  fi
done

# ─── INTERNAL_API_TOKEN bootstrap ────────────────────────────
# The streamer + web containers need a shared bearer token for
# their internal RPC. v1.7 promised to auto-generate it if absent
# but never did — fixing that here.
#
# Order of precedence:
#   1. INTERNAL_API_TOKEN in env (set by the operator in .env)
#   2. Existing /app/audio/.internal-api-token file (from a
#      previous boot of this same compose project)
#   3. Generate a fresh one and write it to the file
#
# The streamer's entrypoint reads from the same file as fallback
# when its own env is empty.
TOKEN_FILE=/app/audio/.internal-api-token
if [ -z "$INTERNAL_API_TOKEN" ]; then
  if [ -s "$TOKEN_FILE" ]; then
    INTERNAL_API_TOKEN="$(cat "$TOKEN_FILE")"
    echo "[entrypoint] using INTERNAL_API_TOKEN from $TOKEN_FILE"
  else
    # /dev/urandom + od is portable; no openssl dependency required.
    INTERNAL_API_TOKEN="$(od -An -N32 -tx1 /dev/urandom | tr -d ' \n')"
    echo -n "$INTERNAL_API_TOKEN" > "$TOKEN_FILE"
    chmod 0644 "$TOKEN_FILE"
    echo "[entrypoint] generated fresh INTERNAL_API_TOKEN → $TOKEN_FILE"
  fi
fi
# Always make sure the file matches the env value we'll exec
# with — handles the case where the operator pinned a value in
# .env and we want the streamer to pick that up too.
if [ ! -s "$TOKEN_FILE" ] || [ "$(cat "$TOKEN_FILE")" != "$INTERNAL_API_TOKEN" ]; then
  echo -n "$INTERNAL_API_TOKEN" > "$TOKEN_FILE"
  chmod 0644 "$TOKEN_FILE"
fi
export INTERNAL_API_TOKEN

exec setpriv --reuid=nextjs --regid=nextjs --init-groups -- "$@"
