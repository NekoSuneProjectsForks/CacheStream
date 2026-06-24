"use strict";

/**
 * Relay server configuration (env-driven).
 *
 * The SAME server runs in two deployment modes — the choice is made by
 * whoever runs it, not in code:
 *   - PUBLIC  : hosted at a domain (e.g. https://oauth.example.com). You
 *               register ONE OAuth app per provider with that domain's
 *               callback and set RELAY_<P>_CLIENT_ID/SECRET. End users then
 *               log in with zero setup.
 *   - LOCAL   : run on the user's own machine (or embedded by the desktop
 *               app). The user registers their own OAuth app (localhost
 *               callback) and supplies their own keys. Harder, but nothing
 *               is shared.
 *
 * Either way the client secret only ever lives here, server-side.
 */

function bool(v, d) { if (v == null || v === "") return d; return /^(1|true|yes|on)$/i.test(String(v)); }
function int(v, d) { const n = parseInt(v, 10); return Number.isFinite(n) ? n : d; }

const config = {
  port: int(process.env.PORT, 8788),
  bindHost: process.env.BIND_HOST || "0.0.0.0",

  // Public base the PROVIDER redirects back to. MUST equal the origin you
  // registered as each provider app's redirect URI base (e.g.
  // https://oauth.example.com). If unset, it's derived per-request from the
  // forwarded Host header — fine for local/dev, but set it explicitly in
  // production so the redirect_uri is stable and matches what's registered.
  publicUrl: (process.env.PUBLIC_URL || "").replace(/\/+$/, ""),

  // How long a login may sit between /start and the provider callback.
  txTtlMs: int(process.env.TX_TTL_MS, 10 * 60 * 1000),
  // How long the one-time pickup code is valid for redemption by the app.
  pickupTtlMs: int(process.env.PICKUP_TTL_MS, 2 * 60 * 1000),

  // The app's redirect_uri must be a loopback address (the secure native-app
  // pattern) unless you explicitly opt out (e.g. a trusted web app origin).
  allowNonLoopbackAppRedirect: bool(process.env.ALLOW_NON_LOOPBACK_APP_REDIRECT, false),
  // Extra non-loopback app-redirect origins to allow (comma-separated), e.g.
  // a Docker panel's own https origin. Loopback is always allowed.
  allowedAppOrigins: (process.env.ALLOWED_APP_ORIGINS || "")
    .split(",").map((s) => s.trim()).filter(Boolean),

  // Behind a TLS-terminating proxy? Then trust X-Forwarded-Proto/Host.
  trustProxy: bool(process.env.TRUST_PROXY, true),

  // Simple per-IP rate limit on /start + /callback (abuse guard).
  rateMaxPerMin: int(process.env.RATE_MAX_PER_MIN, 60),

  logLevel: process.env.LOG_LEVEL || "info",
};

module.exports = { config };
