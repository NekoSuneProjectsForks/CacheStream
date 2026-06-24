"use strict";

const crypto = require("node:crypto");

function b64url(buf) {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** RFC 7636 PKCE pair (S256). */
function createPkce() {
  const verifier = b64url(crypto.randomBytes(32));
  const challenge = b64url(crypto.createHash("sha256").update(verifier).digest());
  return { verifier, challenge };
}

/** A high-entropy URL-safe token (relay state, pickup codes, …). */
function randomToken(bytes = 32) {
  return b64url(crypto.randomBytes(bytes));
}

module.exports = { createPkce, randomToken, b64url };
