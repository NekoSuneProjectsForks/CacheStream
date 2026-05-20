# syntax=docker/dockerfile:1.7
# =========================================================
# cachestream-ingest — nginx + nginx-rtmp-module
# =========================================================
# We build our own image rather than using tiangolo/nginx-rtmp
# (abandoned since 2018, breaks with OBS 30+'s Enhanced RTMP),
# nginx-rtmp-module-arm, or any of the other community images
# that haven't been updated in years.
#
# This is a small Debian-slim image that builds nginx-rtmp-module
# (last release 1.2.2, 2020) against current nginx (1.27+).
# Multi-arch friendly so it builds for amd64 + arm64 cleanly via
# the same GHCR workflow as the web + streamer images.
# =========================================================

# ---- Build stage ----
FROM debian:bookworm-slim AS build

RUN apt-get update && apt-get install -y --no-install-recommends \
      build-essential \
      ca-certificates \
      curl \
      libpcre3-dev \
      libssl-dev \
      zlib1g-dev \
    && rm -rf /var/lib/apt/lists/*

ARG NGINX_VERSION=1.27.4
ARG RTMP_MODULE_VERSION=1.2.2

WORKDIR /src

# nginx-rtmp-module is the de-facto choice. arut's repo went read-
# only after 1.2.2 (2020) but pull requests for OBS-Enhanced-RTMP
# / HEVC / AV1 compatibility have been merged. We could switch to
# nginx-rtmp-module-2 (a community continuation) if needed.
RUN curl -fsSL https://nginx.org/download/nginx-${NGINX_VERSION}.tar.gz | tar xz \
 && curl -fsSL https://github.com/arut/nginx-rtmp-module/archive/refs/tags/v${RTMP_MODULE_VERSION}.tar.gz | tar xz

RUN cd nginx-${NGINX_VERSION} \
 && ./configure \
      --prefix=/usr/local/nginx \
      --with-http_ssl_module \
      --with-http_stub_status_module \
      --with-threads \
      --add-module=/src/nginx-rtmp-module-${RTMP_MODULE_VERSION} \
 && make -j"$(nproc)" \
 && make install

# ---- Runner stage ----
FROM debian:bookworm-slim AS runner

RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates \
      libpcre3 \
      libssl3 \
      zlib1g \
      tini \
    && rm -rf /var/lib/apt/lists/*

COPY --from=build /usr/local/nginx /usr/local/nginx
COPY --from=build /src/nginx-rtmp-module-1.2.2/stat.xsl /usr/local/nginx/html/stat.xsl

# Drop a placeholder config so the binary is happy to start before
# the bind-mount in docker-compose substitutes the real one.
RUN mkdir -p /tmp/hls && chmod 0777 /tmp/hls

ENV PATH="/usr/local/nginx/sbin:${PATH}"

EXPOSE 1935 8080

ENTRYPOINT ["tini", "--"]
CMD ["nginx", "-g", "daemon off;"]
