# NekoStream OAuth2 Relay

A small, **dependency-free** Node server that **brokers OAuth2 logins** for
native / loopback apps. The provider callback reaches **the server first, then
the app**, so:

- the **client secret never ships in the app** — it lives only here, server-side;
- end users **don't register their own redirect URIs** — the relay exposes one
  stable callback per provider;
- tokens reach the app via a **one-time, single-use pickup** instead of sitting
  in a browser URL.

This is the backend that lets the desktop/web app log users into Twitch, Kick,
YouTube, etc. without each user creating their own OAuth app.

> This branch is **only** the relay server (server-side data lives on its own
> branch). The apps that consume it live on the `desktop` / `docker` branches.

---

## Two modes (same server)

| | **Public** | **Local / self-hosted** |
|---|---|---|
| Where it runs | a domain you host, e.g. `https://nekostreamappoauth2.nekosunevr.co.uk` | the user's own machine |
| Keys | you register one OAuth app per provider | the user brings their own keys |
| End-user setup | **none** | register an app, paste keys |
| Provider redirect | `https://…/oauth/<provider>/callback` | `http://127.0.0.1:<port>/oauth/<provider>/callback` |

The app chooses with **one setting** — the relay URL. Either way the secret
stays on the server.

---

## Setup

**Requirements:** Node 18+ (uses built-in `fetch` / `crypto` — no `npm install`
needed) — or Docker.

1. **Register an OAuth app per provider** and set its redirect URI to
   `<your-relay-origin>/oauth/<provider>/callback`:
   - Twitch — <https://dev.twitch.tv/console/apps> → `…/oauth/twitch/callback`
   - Kick — <https://kick.com/developer> → `…/oauth/kick/callback`
   - YouTube/Google — <https://console.cloud.google.com> → `…/oauth/youtube/callback`

2. **Configure** — copy the example and fill in keys (a provider with no
   `CLIENT_ID` is simply disabled):

   ```bash
   cp .env.example .env
   ```

   ```ini
   PUBLIC_URL=https://nekostreamappoauth2.nekosunevr.co.uk   # omit for local/dev
   RELAY_TWITCH_CLIENT_ID=...
   RELAY_TWITCH_CLIENT_SECRET=...
   RELAY_KICK_CLIENT_ID=...            # Kick uses PKCE
   RELAY_KICK_CLIENT_SECRET=...
   RELAY_YOUTUBE_CLIENT_ID=...         # Google / YouTube
   RELAY_YOUTUBE_CLIENT_SECRET=...
   ```

3. **Run:**

   ```bash
   node --env-file=.env src/index.js
   # or
   docker build -t nekostream-oauth-relay .
   docker run --env-file .env -p 8788:8788 nekostream-oauth-relay
   ```

4. **Public deploy:** put it behind TLS (nginx / Caddy / Cloudflare), keep
   `TRUST_PROXY=true`, and point your domain at it. `PUBLIC_URL` must equal the
   origin you registered as the providers' redirect base.

Check it's up: `GET /healthz` → `{ "ok": true, "providers": [...] }`.

---

## How it works

```
app ─1 GET /oauth/:p/start?redirect_uri=http://127.0.0.1:PORT/cb&state=…&scope=… ─▶ relay
relay ─2 302 ─▶ provider authorize   (relay's stable callback + PKCE; secret server-side)
provider ─3 302 ?code ─▶ relay /oauth/:p/callback   (relay swaps code → tokens)
relay ─4 302 ─▶ app loopback /cb?state=…&pickup=<one-time>      (NO tokens in the URL)
app backend ─5 POST /oauth/:p/exchange {pickup} ─▶ relay → { tokens }   (server-to-server)
later:  app ─ POST /oauth/:p/refresh {refresh_token} ─▶ relay → { tokens }
```

### API

| Method & path | Purpose |
|---|---|
| `GET /oauth/:provider/start?redirect_uri&state[&scope]` | begin login; 302 → provider. `redirect_uri` must be loopback. |
| `GET /oauth/:provider/callback?code&state` | provider returns here; relay swaps the code, 302 → app loopback with `pickup`. |
| `POST /oauth/:provider/exchange` `{pickup}` | redeem the one-time pickup → `{ tokens }`. |
| `POST /oauth/:provider/refresh` `{refresh_token}` | refresh via the relay (uses the secret) → `{ tokens }`. |
| `GET /healthz` | `{ ok, providers }`. |
| `GET /` | human info page (no secrets). |

`tokens` = `{ access_token, refresh_token, token_type, expires_in, scope, obtained_at }`.

---

## Files

```
src/server.js           createServer() — routes, PKCE flow, token exchange (embeddable)
src/providers.js        provider registry (twitch / kick / youtube) — add new ones here
src/pkce.js             PKCE (S256) + random tokens
src/store.js            in-memory TTL store (txns + one-time pickups)
src/config.js           env config
src/index.js            standalone entry point
client/relay-client.js  framework-free reference client for the apps
.env.example            configuration template
Dockerfile              non-root image + healthcheck
```

Add a new platform in `src/providers.js` (authorize/token URLs, scopes, whether
it uses PKCE) — never embed its secret in the app.

---

## Security

- App `redirect_uri` must be **loopback** (or an explicitly allowlisted origin)
  — stops the relay being abused as an open redirect to steal codes.
- **PKCE** per provider; the client secret only ever lives server-side.
- **Pickup** codes are single-use with a short TTL; tokens are held only
  ephemerally and never written to disk.
- Per-IP rate limiting on `/start` + `/callback`.
- Single-process in-memory store; for a multi-instance deployment back
  `src/store.js` with Redis (same `get` / `take` / `set` surface).

## License

MIT.
