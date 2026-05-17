# syntax=docker/dockerfile:1.7
# =========================================================
# cachestream-web — Next.js 14 (standalone output)
# =========================================================
# Multi-stage:
#   1. deps   — install full deps (incl. dev) for the build
#   2. builder — `next build` to produce .next/standalone
#   3. runner  — tiny image with only the standalone output
# =========================================================

# ---- 1. deps ----
FROM node:20-bookworm-slim AS deps
WORKDIR /app
# python3/build-essential are needed to compile better-sqlite3's
# native bindings. They live only in the deps + builder stages.
RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 build-essential ca-certificates \
    && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json* ./
RUN npm install --no-audit --no-fund

# ---- 2. builder ----
FROM node:20-bookworm-slim AS builder
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 build-essential \
    && rm -rf /var/lib/apt/lists/*
COPY --from=deps /app/node_modules ./node_modules
COPY . .
# Ensure public/ exists even if the repo doesn't ship one —
# the runner stage unconditionally copies it.
RUN mkdir -p public && npm run build

# ---- 3. runner ----
FROM node:20-bookworm-slim AS runner
WORKDIR /app
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1

# Runtime deps:
#   - wget for the docker-compose healthcheck
#   - dumb-init for clean signal handling under PID 1
#   - ffmpeg + coreutils for the music subsystem
#   - util-linux for setpriv (drops the entrypoint to nextjs)
RUN apt-get update && apt-get install -y --no-install-recommends \
      wget ca-certificates dumb-init ffmpeg coreutils util-linux \
    && rm -rf /var/lib/apt/lists/* \
    && useradd --system --create-home --shell /usr/sbin/nologin nextjs

# Standalone output: server.js + minimal node_modules + .next.
COPY --from=builder --chown=nextjs:nextjs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nextjs /app/.next/static    ./.next/static
COPY --from=builder --chown=nextjs:nextjs /app/public          ./public

# Writable mount points. The entrypoint re-chowns them at run
# time too, in case the volume init left them as root:root.
RUN mkdir -p /app/data /app/audio /app/media/music /app/media/vods \
    && chown nextjs:nextjs /app/data /app/audio /app/media/music /app/media/vods

COPY entrypoint.sh /usr/local/bin/cachestream-entrypoint
RUN chmod +x /usr/local/bin/cachestream-entrypoint

# No USER directive — the entrypoint runs as root briefly to
# fix volume ownership, then setpriv-drops to nextjs.
EXPOSE 7788

ENTRYPOINT ["dumb-init", "--", "/usr/local/bin/cachestream-entrypoint"]
CMD ["node", "server.js"]
