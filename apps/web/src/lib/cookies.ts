/**
 * Cookie helpers.
 *
 * Sessions and OAuth state are stored in HMAC-signed cookies
 * (value.signature). We sign with SESSION_SECRET so a stolen
 * cookie from another deployment can't replay.
 *
 * `Secure` is set whenever TRUST_PROXY=true (Cloudflare
 * Tunnel terminates HTTPS, the browser sees https://, so
 * Secure is mandatory). For pure-localhost dev (TRUST_PROXY
 * false) we drop Secure so cookies still work over plain http.
 */

import crypto from "node:crypto";
import { config } from "./config";

export const SESSION_COOKIE = "cs_session";
export const STATE_COOKIE = "cs_oauth_state";
export const SCENE_HINT_COOKIE = "cs_last_scene";

export const STATE_TTL_MS = 10 * 60 * 1000;
export const SESSION_TTL_MS = 14 * 24 * 60 * 60 * 1000;

export function sign(value: string): string {
  const mac = crypto
    .createHmac("sha256", config.oauth.sessionSecret)
    .update(value)
    .digest("hex");
  return `${value}.${mac}`;
}

export function unsign(signed: string | null | undefined): string | null {
  if (!signed || typeof signed !== "string") return null;
  const dot = signed.lastIndexOf(".");
  if (dot < 0) return null;
  const value = signed.slice(0, dot);
  const mac = signed.slice(dot + 1);
  const expected = crypto
    .createHmac("sha256", config.oauth.sessionSecret)
    .update(value)
    .digest("hex");
  const a = Buffer.from(mac, "hex");
  const b = Buffer.from(expected, "hex");
  if (a.length !== b.length) return null;
  return crypto.timingSafeEqual(a, b) ? value : null;
}

export interface CookieOpts {
  httpOnly: true;
  sameSite: "lax";
  secure: boolean;
  path: string;
  maxAge: number;
}

export function cookieOpts(maxAgeMs: number): CookieOpts {
  return {
    httpOnly: true,
    sameSite: "lax",
    secure: config.web.trustProxy,
    path: "/",
    maxAge: Math.floor(maxAgeMs / 1000),
  };
}
