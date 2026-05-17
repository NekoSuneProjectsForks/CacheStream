# Security policy

## Reporting a vulnerability

Please **do not** open a public GitHub issue for security findings.
Instead, email the maintainers or open a private GitHub Security
Advisory at:

<https://github.com/cachenetworks/CacheStream/security/advisories/new>

Include:

- A description of the issue and the path you took to find it.
- Proof-of-concept code or commands, if you have them.
- Any suggested mitigation.

We aim to acknowledge reports within **72 hours** and ship a fix
within **14 days** for high-severity issues.

## In scope

The following are in scope for reports:

- Auth bypass on `/api/*` routes (skipping `requireOwner`).
- Token / secret leakage to the browser, logs, or unauthenticated
  endpoints.
- Stored XSS in the admin panel (custom scenes are owner-only and
  intentionally render arbitrary HTML — that is **not** a finding).
- SSRF, RCE, path traversal in any upload or file-serving route
  (`/api/music/upload`, `/api/vods/upload`, `/api/music/file/:id`,
  `/api/branding/logo`, etc.).
- SQL injection (the codebase uses parameterised `better-sqlite3`
  prepared statements throughout, but report any case that escaped).
- Privilege escalation between the `nextjs` / `streamer` container
  users and the host.
- Cookie / session attacks (forging the HMAC, replaying old sessions
  past expiry).

## Out of scope

- Findings that require a malicious owner. The owner authors raw HTML
  scenes, has the broadcaster's Twitch token, and operates the panel.
  This is an authenticated single-tenant tool, not a public service.
- Reports against the bundled Twitch Helix / EventSub / IRC behaviour
  that are actually issues with Twitch's platform.
- Self-XSS that requires the operator to paste hostile HTML into the
  raw-HTML scene editor.
- Denial-of-service via uploading huge files (mitigated by per-file
  size caps; report only if you find a bypass).

## Supported versions

| Version | Supported |
|---|---|
| 1.6.x   | ✅ |
| 1.5.x   | Security fixes only |
| < 1.5   | ❌ — upgrade |

Thank you for helping keep CacheStream safe.
