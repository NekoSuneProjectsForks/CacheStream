"use strict";

/**
 * Provider registry. Credentials come from the environment:
 *   RELAY_<PROVIDER>_CLIENT_ID
 *   RELAY_<PROVIDER>_CLIENT_SECRET   (omit for a public PKCE-only client)
 *   RELAY_<PROVIDER>_SCOPE           (optional: override the default scope)
 *
 * A provider with no CLIENT_ID set is treated as DISABLED — it won't appear
 * on the info page and its routes 404. This is the "bring your own keys"
 * rule: the relay brokers only what its operator has configured.
 *
 * To add a new platform: add an entry here and document its scopes. Per the
 * project convention, OAuth2 platforms are ALWAYS brokered server-side here
 * — never with a secret embedded in the app.
 */

function env(provider, key) {
  return process.env[`RELAY_${provider.toUpperCase()}_${key}`] || "";
}

const REGISTRY = {
  twitch: {
    label: "Twitch",
    authorizeUrl: "https://id.twitch.tv/oauth2/authorize",
    tokenUrl: "https://id.twitch.tv/oauth2/token",
    usePkce: false,                 // confidential client (secret-based)
    defaultScope: "user:read:email",
    extraAuthParams: {},
  },
  kick: {
    label: "Kick",
    authorizeUrl: "https://id.kick.com/oauth/authorize",
    tokenUrl: "https://id.kick.com/oauth/token",
    usePkce: true,                  // Kick requires PKCE (S256)
    defaultScope: "user:read channel:read chat:write events:subscribe",
    extraAuthParams: {},
  },
  youtube: {
    label: "YouTube (Google)",
    authorizeUrl: "https://accounts.google.com/o/oauth2/v2/auth",
    tokenUrl: "https://oauth2.googleapis.com/token",
    usePkce: true,
    defaultScope: "https://www.googleapis.com/auth/youtube.readonly",
    // access_type=offline + prompt=consent → get a refresh_token reliably.
    extraAuthParams: { access_type: "offline", prompt: "consent" },
  },
};

/** Resolve a configured provider, or null if unknown/not configured. */
function getProvider(name) {
  const key = String(name || "").toLowerCase();
  const spec = REGISTRY[key];
  if (!spec) return null;
  const clientId = env(key, "CLIENT_ID");
  if (!clientId) return null;       // not configured → disabled
  return {
    name: key,
    ...spec,
    clientId,
    clientSecret: env(key, "CLIENT_SECRET"),
    defaultScope: env(key, "SCOPE") || spec.defaultScope,
  };
}

/** Names of providers that have at least a CLIENT_ID configured. */
function listConfigured() {
  return Object.keys(REGISTRY).filter((n) => !!env(n, "CLIENT_ID"));
}

module.exports = { getProvider, listConfigured, REGISTRY };
