"use strict";

/**
 * OAuth2 relay/broker HTTP server.
 *
 * The provider callback reaches the SERVER first, then the app:
 *
 *   app ──(1 GET /oauth/:p/start?redirect_uri=http://127.0.0.1:PORT/cb&state)──▶ relay
 *   relay ─(2 302)─▶ provider authorize (relay's stable callback + PKCE + secret-side)
 *   provider ─(3 302 code)─▶ relay /oauth/:p/callback   (relay swaps code→tokens)
 *   relay ─(4 302)─▶ app loopback /cb?state&pickup=<one-time>   (NO tokens in the URL)
 *   app backend ─(5 POST /oauth/:p/exchange {pickup})─▶ relay → tokens (server-to-server)
 *   app ─(later POST /oauth/:p/refresh {refresh_token})─▶ relay → fresh tokens
 *
 * The client secret never leaves the relay; tokens are held only ephemerally
 * (one short-lived, single-use pickup). Exported as a factory so the desktop
 * app can embed it for "local" mode, or it can run standalone (index.js) as
 * the "public" hosted instance.
 */

const http = require("node:http");
const { URL, URLSearchParams } = require("node:url");
const { getProvider, listConfigured } = require("./providers");
const { createPkce, randomToken } = require("./pkce");
const { TtlStore } = require("./store");

const PROVIDER_RE = /^[a-z0-9_-]+$/;
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);

function createServer({ config, logger = console } = {}) {
  const txns = new TtlStore();      // relayState → pending login
  const pickups = new TtlStore();   // pickup code → { provider, tokens }
  const rate = new Map();           // ip → { count, windowStart }

  const server = http.createServer(async (req, res) => {
    try {
      const u = new URL(req.url, "http://relay.internal");
      const path = u.pathname.replace(/\/+$/, "") || "/";

      if (req.method === "GET" && path === "/healthz") {
        return json(res, 200, { ok: true, providers: listConfigured(), txns: txns.size, pickups: pickups.size });
      }
      if (req.method === "GET" && path === "/") {
        return infoPage(res, baseUrl(req));
      }

      const m = path.match(/^\/oauth\/([^/]+)\/(start|callback|exchange|refresh)$/);
      if (!m) return json(res, 404, { error: "not_found" });
      const providerName = decodeURIComponent(m[1]).toLowerCase();
      const action = m[2];
      if (!PROVIDER_RE.test(providerName)) return json(res, 400, { error: "bad_provider" });

      if (req.method === "GET" && action === "start") return handleStart(req, res, u, providerName);
      if (req.method === "GET" && action === "callback") return handleCallback(req, res, u, providerName);
      if (req.method === "POST" && action === "exchange") return handleExchange(req, res, providerName);
      if (req.method === "POST" && action === "refresh") return handleRefresh(req, res, providerName);
      return json(res, 405, { error: "method_not_allowed" });
    } catch (err) {
      logger.error?.({ err: err?.message }, "relay request error");
      try { json(res, 500, { error: "internal_error" }); } catch { /* already sent */ }
    }
  });

  // ---- handlers --------------------------------------------------

  function handleStart(req, res, u, providerName) {
    if (!rateOk(req)) return json(res, 429, { error: "rate_limited" });
    const provider = getProvider(providerName);
    if (!provider) return json(res, 404, { error: "provider_not_configured", provider: providerName });

    const redirectUri = u.searchParams.get("redirect_uri") || "";
    const appState = u.searchParams.get("state") || "";
    const scope = (u.searchParams.get("scope") || provider.defaultScope || "").trim();

    if (!appRedirectAllowed(redirectUri)) {
      return json(res, 400, { error: "invalid_redirect_uri", detail: "must be a loopback (127.0.0.1/localhost) URL" });
    }
    if (!appState || appState.length > 512) return json(res, 400, { error: "invalid_state" });

    const pkce = provider.usePkce ? createPkce() : null;
    const relayState = randomToken(24);
    txns.set(relayState, {
      provider: providerName, appRedirect: redirectUri, appState,
      verifier: pkce ? pkce.verifier : null,
    }, config.txTtlMs);

    const params = new URLSearchParams({
      client_id: provider.clientId,
      redirect_uri: relayCallback(req, providerName),
      response_type: "code",
      scope,
      state: relayState,
      ...(provider.extraAuthParams || {}),
    });
    if (pkce) { params.set("code_challenge", pkce.challenge); params.set("code_challenge_method", "S256"); }

    logger.info?.({ provider: providerName, scope }, "login started");
    return redirect(res, `${provider.authorizeUrl}?${params.toString()}`);
  }

  async function handleCallback(req, res, u, providerName) {
    if (!rateOk(req)) return json(res, 429, { error: "rate_limited" });
    const relayState = u.searchParams.get("state") || "";
    const tx = txns.take(relayState);
    if (!tx || tx.provider !== providerName) {
      return html(res, 400, "Login session expired or unknown. Please start the login again.");
    }
    const provider = getProvider(providerName);
    if (!provider) return html(res, 400, "Provider is no longer configured.");

    const provErr = u.searchParams.get("error");
    const code = u.searchParams.get("code");
    if (provErr || !code) {
      return redirectToApp(res, tx.appRedirect, {
        state: tx.appState,
        error: provErr || "no_code",
        error_description: u.searchParams.get("error_description") || "",
      });
    }

    let tokens;
    try {
      tokens = await exchangeCode(provider, code, relayCallback(req, providerName), tx.verifier);
    } catch (err) {
      logger.warn?.({ provider: providerName, err: err?.message }, "token exchange failed");
      return redirectToApp(res, tx.appRedirect, { state: tx.appState, error: "exchange_failed", error_description: err.message });
    }

    const pickup = randomToken(24);
    pickups.set(pickup, { provider: providerName, tokens }, config.pickupTtlMs);
    logger.info?.({ provider: providerName }, "login completed → pickup issued");
    return redirectToApp(res, tx.appRedirect, { state: tx.appState, pickup });
  }

  async function handleExchange(req, res, providerName) {
    const body = await readJson(req);
    const pickup = body && body.pickup;
    if (!pickup) return json(res, 400, { error: "missing_pickup" });
    const rec = pickups.take(String(pickup));   // single-use
    if (!rec) return json(res, 404, { error: "invalid_or_used_pickup" });
    if (rec.provider !== providerName) return json(res, 400, { error: "provider_mismatch" });
    return json(res, 200, { ok: true, provider: providerName, tokens: rec.tokens });
  }

  async function handleRefresh(req, res, providerName) {
    const provider = getProvider(providerName);
    if (!provider) return json(res, 404, { error: "provider_not_configured" });
    const body = await readJson(req);
    const refreshToken = body && body.refresh_token;
    if (!refreshToken) return json(res, 400, { error: "missing_refresh_token" });
    try {
      const tokens = await refreshTokens(provider, String(refreshToken));
      return json(res, 200, { ok: true, provider: providerName, tokens });
    } catch (err) {
      return json(res, 400, { error: "refresh_failed", error_description: err.message });
    }
  }

  // ---- provider token calls --------------------------------------

  async function exchangeCode(provider, code, redirectUri, verifier) {
    const body = new URLSearchParams({
      grant_type: "authorization_code", code, redirect_uri: redirectUri, client_id: provider.clientId,
    });
    if (provider.clientSecret) body.set("client_secret", provider.clientSecret);
    if (provider.usePkce && verifier) body.set("code_verifier", verifier);
    return tokenRequest(provider, body);
  }

  async function refreshTokens(provider, refreshToken) {
    const body = new URLSearchParams({
      grant_type: "refresh_token", refresh_token: refreshToken, client_id: provider.clientId,
    });
    if (provider.clientSecret) body.set("client_secret", provider.clientSecret);
    return tokenRequest(provider, body);
  }

  async function tokenRequest(provider, body) {
    const r = await fetch(provider.tokenUrl, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      body: body.toString(),
      signal: AbortSignal.timeout(12_000),
    });
    const text = await r.text();
    let j = null; try { j = JSON.parse(text); } catch { /* non-JSON error body */ }
    if (!r.ok || !j || !j.access_token) {
      const msg = (j && (j.error_description || j.error || j.message)) || `token endpoint ${r.status}`;
      const e = new Error(String(msg)); e.status = r.status; throw e;
    }
    return {
      access_token: j.access_token,
      refresh_token: j.refresh_token || null,
      token_type: j.token_type || "bearer",
      expires_in: j.expires_in ?? null,
      scope: Array.isArray(j.scope) ? j.scope.join(" ") : (j.scope || null),
      obtained_at: Date.now(),
    };
  }

  // ---- helpers ---------------------------------------------------

  function baseUrl(req) {
    if (config.publicUrl) return config.publicUrl;
    const proto = (config.trustProxy && header(req, "x-forwarded-proto")) || "http";
    const host = (config.trustProxy && header(req, "x-forwarded-host")) || header(req, "host") || `127.0.0.1:${config.port}`;
    return `${proto.split(",")[0].trim()}://${host.split(",")[0].trim()}`;
  }
  function relayCallback(req, provider) { return `${baseUrl(req)}/oauth/${provider}/callback`; }

  function appRedirectAllowed(raw) {
    let url; try { url = new URL(raw); } catch { return false; }
    if (url.protocol !== "http:" && url.protocol !== "https:") return false;
    if (LOOPBACK_HOSTS.has(url.hostname)) return true;
    if (config.allowNonLoopbackAppRedirect) return true;
    return config.allowedAppOrigins.includes(url.origin);
  }

  function redirectToApp(res, base, params) {
    let url;
    try { url = new URL(base); } catch { return html(res, 400, "Invalid app redirect."); }
    for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== "") url.searchParams.set(k, v);
    return redirect(res, url.toString());
  }

  function rateOk(req) {
    const ip = clientIp(req);
    const now = Date.now();
    const e = rate.get(ip);
    if (!e || now - e.windowStart > 60_000) { rate.set(ip, { count: 1, windowStart: now }); return true; }
    e.count++;
    if (rate.size > 5000) for (const [k, v] of rate) if (now - v.windowStart > 60_000) rate.delete(k);
    return e.count <= config.rateMaxPerMin;
  }
  function clientIp(req) {
    if (config.trustProxy) { const f = header(req, "x-forwarded-for"); if (f) return f.split(",")[0].trim(); }
    return req.socket?.remoteAddress || "unknown";
  }

  function infoPage(res, base) {
    const configured = listConfigured();
    const rows = configured.length
      ? configured.map((p) => `<li><code>${esc(p)}</code> — <code>GET ${esc(base)}/oauth/${esc(p)}/start?redirect_uri=http://127.0.0.1:PORT/cb&amp;state=…</code></li>`).join("")
      : "<li><em>No providers configured. Set RELAY_&lt;PROVIDER&gt;_CLIENT_ID / _CLIENT_SECRET.</em></li>";
    html(res, 200,
      `<h1>OAuth2 relay</h1><p>Brokers OAuth logins for loopback apps. Secrets stay server-side.</p>` +
      `<p>Base: <code>${esc(base)}</code></p><h2>Configured providers</h2><ul>${rows}</ul>`);
  }

  return { server, listen, close, _internals: { txns, pickups } };

  function listen() {
    return new Promise((resolve, reject) => {
      server.listen(config.port, config.bindHost, () => {
        logger.info?.({ port: config.port, host: config.bindHost, providers: listConfigured() }, "oauth relay listening");
        resolve(server);
      });
      server.on("error", reject);
    });
  }
  function close() { return new Promise((r) => server.close(() => r())); }
}

// ---- response utils (module scope) -------------------------------

function header(req, name) { const v = req.headers[name]; return Array.isArray(v) ? v[0] : (v || ""); }
function json(res, code, obj) {
  const s = JSON.stringify(obj);
  res.writeHead(code, { "content-type": "application/json", "content-length": Buffer.byteLength(s), "cache-control": "no-store" });
  res.end(s);
}
function html(res, code, inner) {
  const s = `<!doctype html><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1"><title>OAuth relay</title><body style="font:15px system-ui;max-width:640px;margin:40px auto;padding:0 16px;color:#0b1020">${inner}</body>`;
  res.writeHead(code, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
  res.end(s);
}
function redirect(res, location) { res.writeHead(302, { location, "cache-control": "no-store" }); res.end(); }
function esc(s) { return String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c])); }

function readJson(req) {
  return new Promise((resolve) => {
    const chunks = []; let size = 0;
    req.on("data", (c) => { size += c.length; if (size > 32 * 1024) { req.destroy(); resolve(null); return; } chunks.push(c); });
    req.on("end", () => { const raw = Buffer.concat(chunks).toString("utf8"); if (!raw) return resolve({}); try { resolve(JSON.parse(raw)); } catch { resolve(null); } });
    req.on("error", () => resolve(null));
  });
}

module.exports = { createServer };
