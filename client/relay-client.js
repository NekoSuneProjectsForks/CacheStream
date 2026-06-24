"use strict";

/**
 * Reference client for the OAuth2 relay — the piece an app embeds to log a
 * user in THROUGH the relay (public or local). Framework-free; uses native
 * fetch + crypto (Node 18+). Copy/port this into the desktop app + web panel.
 *
 * The app must run a tiny loopback HTTP server to catch step (4)'s redirect;
 * `buildStart()` + `handleCallbackQuery()` + `exchange()` are the moving
 * parts. The relay URL is the ONLY thing that differs between "public"
 * (your hosted domain) and "local" (http://127.0.0.1:<relayPort>) mode.
 */

const crypto = require("node:crypto");

/**
 * Default PUBLIC relay (the hosted instance). Apps point here for "public"
 * mode with zero setup; for "local" mode pass relayUrl = http://127.0.0.1:<port>.
 */
const DEFAULT_PUBLIC_RELAY = "https://nekostreamappoauth2.nekosunevr.co.uk";

class RelayClient {
  /** @param {{relayUrl?:string, fetchImpl?:Function}} opts */
  constructor({ relayUrl, fetchImpl } = {}) {
    // Default to the public hosted relay when no URL is given.
    this.relayUrl = String(relayUrl || DEFAULT_PUBLIC_RELAY).replace(/\/+$/, "");
    this.fetch = fetchImpl || globalThis.fetch;
  }

  /**
   * Build the browser URL to open for a login, plus the `state` to verify on
   * return. `appRedirect` is your loopback catcher, e.g.
   * http://127.0.0.1:53114/oauth/cb
   */
  buildStart(provider, appRedirect, { scope } = {}) {
    const state = crypto.randomBytes(16).toString("hex");
    const q = new URLSearchParams({ redirect_uri: appRedirect, state });
    if (scope) q.set("scope", scope);
    return { state, url: `${this.relayUrl}/oauth/${encodeURIComponent(provider)}/start?${q.toString()}` };
  }

  /**
   * Parse the loopback callback's query. Returns { pickup } on success or
   * { error } on failure. Throws if `state` doesn't match what buildStart
   * returned (CSRF guard).
   */
  handleCallbackQuery(query, expectedState) {
    const get = (k) => (query instanceof URLSearchParams ? query.get(k) : query[k]);
    if (expectedState && get("state") !== expectedState) throw new Error("state mismatch");
    if (get("error")) return { error: get("error"), error_description: get("error_description") || "" };
    const pickup = get("pickup");
    if (!pickup) return { error: "no_pickup" };
    return { pickup };
  }

  /** Redeem the one-time pickup for tokens (server-to-server). Single-use. */
  async exchange(provider, pickup) {
    const r = await this.fetch(`${this.relayUrl}/oauth/${encodeURIComponent(provider)}/exchange`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ pickup }),
    });
    const j = await r.json().catch(() => null);
    if (!r.ok || !j || !j.ok) throw new Error((j && (j.error_description || j.error)) || `exchange ${r.status}`);
    return j.tokens; // { access_token, refresh_token, expires_in, scope, token_type, obtained_at }
  }

  /** Refresh tokens via the relay (it holds the secret). */
  async refresh(provider, refreshToken) {
    const r = await this.fetch(`${this.relayUrl}/oauth/${encodeURIComponent(provider)}/refresh`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ refresh_token: refreshToken }),
    });
    const j = await r.json().catch(() => null);
    if (!r.ok || !j || !j.ok) throw new Error((j && (j.error_description || j.error)) || `refresh ${r.status}`);
    return j.tokens;
  }
}

module.exports = { RelayClient, DEFAULT_PUBLIC_RELAY };
