---
name: oauth2-server-side-relay
description: New OAuth2 platforms must be implemented server-side via the oauth-relay broker — never embed client secrets in the app
metadata:
  type: feedback
---

When adding ANY new platform that uses OAuth2 (logins, chat, stream-key, etc.), **always implement the OAuth2 flow server-side through the relay broker — never embed a client_id/secret or per-user redirect registration in the desktop/web app.**

The broker lives in **`apps/oauth-relay/`** on the **`oauth-relay` branch** (server-side data is kept on its own branch, matching the repo's branch-per-target model).

Why: client secrets shipped in a distributable can be extracted; and making every end user register their own OAuth app + localhost redirect URI is slow. The relay holds the secret server-side and exposes ONE stable callback per provider, so end users configure nothing. Whoever runs the relay supplies the keys (`RELAY_<PROVIDER>_CLIENT_ID` / `_SECRET`) — "bring your own keys", server-side only.

Flow (loopback broker / relay): the provider callback hits the **server first, then the app**:
1. app → `GET <relay>/oauth/:provider/start?redirect_uri=http://127.0.0.1:<port>/cb&state=…&scope=…`
2. relay → provider authorize (relay's stable callback + relay client_id + PKCE)
3. provider → `GET <relay>/oauth/:provider/callback` (relay exchanges code→tokens with the secret + PKCE)
4. relay → app loopback `http://127.0.0.1:<port>/cb?state=…&pickup=<one-time-code>` (tokens are NOT in the URL)
5. app backend → `POST <relay>/oauth/:provider/exchange {pickup}` (server-to-server) → tokens
6. refresh later via `POST <relay>/oauth/:provider/refresh {refresh_token}` (relay uses the secret)

Security: only loopback `redirect_uri`s accepted; PKCE (per-provider); pickup codes single-use + short TTL; relay holds tokens only ephemerally (during pickup). See `apps/oauth-relay/README.md`. Relates to [[desktop-app-next-phase]].
