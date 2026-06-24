"use strict";

/**
 * Tiny in-memory key→value store with per-entry TTL and a background sweep.
 * Used for pending login transactions and one-time pickup codes. Ephemeral
 * by design — the relay never persists user tokens to disk.
 *
 * (Single-process. For a multi-instance public deployment, back this with
 * Redis and keep the same get/take/set surface.)
 */
class TtlStore {
  constructor(sweepMs = 30_000) {
    this.map = new Map();
    this.timer = setInterval(() => this.sweep(), sweepMs);
    if (this.timer.unref) this.timer.unref();
  }

  set(key, value, ttlMs) {
    this.map.set(key, { value, exp: Date.now() + ttlMs });
  }

  get(key) {
    const e = this.map.get(key);
    if (!e) return null;
    if (Date.now() > e.exp) { this.map.delete(key); return null; }
    return e.value;
  }

  /** Get and remove atomically (single-use codes). */
  take(key) {
    const v = this.get(key);
    if (v != null) this.map.delete(key);
    return v;
  }

  delete(key) { this.map.delete(key); }

  sweep() {
    const now = Date.now();
    for (const [k, e] of this.map) if (now > e.exp) this.map.delete(k);
  }

  get size() { return this.map.size; }
}

module.exports = { TtlStore };
