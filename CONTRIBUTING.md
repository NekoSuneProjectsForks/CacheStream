# Contributing to CacheStream

Thanks for considering a contribution! This repo is intentionally
small + focused, so a few notes before you open a PR.

## Where things live

```
apps/web/         Next.js 14 + TypeScript control panel
apps/streamer/    Node + Chromium + FFmpeg worker
examples/         Drop-in scene + game templates for users
.github/          CI (multi-arch GHCR image build on tag)
```

**Web is stateless** beyond the SQLite database in `/app/data/`. If
you find yourself adding in-memory caches that need invalidation,
think again — most of the time the answer is a SQL query.

**Streamer is the only place that touches FFmpeg or Chromium.** The
web container talks to it over the internal HTTP API with a bearer
token. Don't reach for `spawn("ffmpeg", …)` inside `apps/web/` —
push it to the streamer via a new endpoint in `apps/streamer/src/api.js`.

## House style

- **TypeScript on the web, JavaScript on the streamer.** The streamer
  is meant to stay small and dependency-light; the web side gets the
  full TypeScript treatment.
- **Comments explain *why*, not *what*.** Code identifiers and types
  already say what something does. A comment should say why it's not
  obvious, or what would happen if the line below were removed.
- **No emojis in source code unless they're literally rendered to the
  user.** Frontend strings are fine; identifiers / log lines / commit
  messages are not.
- **No `any`.** If you can't avoid it, leave a one-line comment
  saying which TypeScript constraint you tried first.
- **One concern per route handler.** A route that does five things is
  hard to test; split into separate routes and share helpers via
  `apps/web/src/lib/`.

## Database changes

Schema migrations live in
[`apps/web/src/lib/db.ts`](apps/web/src/lib/db.ts) inside the
`SCHEMA_VERSIONS` array. Append a new function — never edit an
existing one. Migrations must be **idempotent** (use `IF NOT EXISTS`
+ PRAGMA `table_info` defensive checks for `ALTER TABLE`).

## Running locally

```bash
# Web side
cd apps/web
npm install
npm run dev               # localhost:7788

# Streamer side (separate terminal)
cd apps/streamer
npm install
export INTERNAL_API_TOKEN=dev
export STREAMER_PORT=7789
export TWITCH_STREAM_KEY=…
node src/index.js
```

For most web-side work you don't need the streamer running — the
panel polls `/api/stream/status` which 502s gracefully.

## Pull requests

- One topic per PR. "Refactor + new feature" PRs get split.
- Keep the diff small. If your PR ends up >800 lines, talk to a
  maintainer first about splitting it.
- New tabs in the admin panel need a corresponding section in
  `README.md` → *Control panel features*.
- New API routes need a row in `README.md` → *API reference* and
  a one-line description in `CHANGELOG.md`.
- Update the `## Unreleased` section of `CHANGELOG.md` if there is one;
  otherwise add a new dated heading like `## 1.7.0 - 2026-06-01`.

## Things that are out of scope

- Multi-tenant operation (one CacheStream = one streamer, by design).
- Browser-side state management libraries (Redux, Zustand, etc.).
- UI kits / Tailwind / styled-components — we hand-roll CSS for a
  reason; it's a small surface area and we want to keep it that way.
- YouTube / Kick / TikTok output. RTMP is RTMP — fork `apps/streamer/`
  to a new ingest URL if you need a second destination.

## Code of conduct

Be kind. Disagree about code, not about people. We don't have a
formal CoC because the project is small; if it grows we'll adopt the
Contributor Covenant.

## License

By contributing you agree your code is released under the
[MIT license](LICENSE).
