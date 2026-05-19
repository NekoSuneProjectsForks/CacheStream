/**
 * SQLite connection + schema + JSON migration.
 *
 * Lifecycle:
 *   1. First call to `getDb()` opens (or creates) data/cachestream.db,
 *      runs `applySchema()` which is fully idempotent (CREATE TABLE IF
 *      NOT EXISTS + numbered user_version migrations).
 *   2. If `data/state.json` from v1.1 still exists, `migrateFromJson()`
 *      reads it, copies every row into the relevant tables in a single
 *      transaction, then renames the file to `state.json.migrated-<ts>`.
 *
 * Why SQLite?
 *   - Single file, no extra service.
 *   - better-sqlite3 is synchronous which is fine for our load (one
 *     operator, a handful of writes per minute) and removes a category
 *     of async/order bugs.
 *
 * All tables are keyed by stable string IDs (UUIDs) so the JSON
 * migration can preserve existing IDs verbatim and any external
 * references (e.g. schedule rows pointing at scene presets) stay
 * intact.
 */

import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { config } from "./config";

let _db: Database.Database | null = null;

export function getDb(): Database.Database {
  if (_db) return _db;

  const dir = path.resolve(process.cwd(), config.runtime.dataDir);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "cachestream.db");

  _db = new Database(file);
  _db.pragma("journal_mode = WAL");      // crash-safe, allows readers during writes
  _db.pragma("foreign_keys = ON");
  _db.pragma("busy_timeout = 5000");

  applySchema(_db);
  migrateFromJson(_db, dir);
  return _db;
}

// ---- Schema -----------------------------------------------------

const SCHEMA_VERSIONS: Array<(db: Database.Database) => void> = [
  // ---- v1: initial 1.2 schema ----
  (db) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS owner (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        twitch_user_id TEXT,
        twitch_login   TEXT NOT NULL,
        display_name   TEXT NOT NULL,
        email          TEXT,
        claimed_at     TEXT NOT NULL,
        seeded         INTEGER NOT NULL DEFAULT 0
      );

      CREATE TABLE IF NOT EXISTS sessions (
        sid          TEXT PRIMARY KEY,
        twitch_user_id TEXT NOT NULL,
        login        TEXT NOT NULL,
        display_name TEXT NOT NULL,
        email        TEXT,
        created_at   INTEGER NOT NULL,
        expires_at   INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS sessions_expires_idx ON sessions(expires_at);

      CREATE TABLE IF NOT EXISTS scenes (
        id         TEXT PRIMARY KEY,
        name       TEXT NOT NULL,
        url        TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS overlay_sets (
        id           TEXT PRIMARY KEY,
        name         TEXT NOT NULL,
        overlays_json TEXT NOT NULL,
        created_at   INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS kv (
        key   TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS schedule (
        id              TEXT PRIMARY KEY,
        enabled         INTEGER NOT NULL DEFAULT 1,
        scene_preset_id TEXT NOT NULL,
        overlay_set_id  TEXT,
        at              TEXT NOT NULL,
        days_json       TEXT NOT NULL DEFAULT '[]'
      );

      -- OAuth tokens for the broadcaster (one row, id=1).
      CREATE TABLE IF NOT EXISTS oauth_tokens (
        id              INTEGER PRIMARY KEY CHECK (id = 1),
        access_token    TEXT NOT NULL,
        refresh_token   TEXT,
        expires_at      INTEGER NOT NULL,
        scopes_json     TEXT NOT NULL,
        twitch_user_id  TEXT NOT NULL,
        updated_at      INTEGER NOT NULL
      );

      -- Custom chat commands. Trigger is matched against the first
      -- word of an incoming chat message.
      CREATE TABLE IF NOT EXISTS commands (
        id          TEXT PRIMARY KEY,
        trigger     TEXT NOT NULL UNIQUE,
        response    TEXT NOT NULL,
        cooldown_s  INTEGER NOT NULL DEFAULT 5,
        mod_only    INTEGER NOT NULL DEFAULT 0,
        sub_only    INTEGER NOT NULL DEFAULT 0,
        enabled     INTEGER NOT NULL DEFAULT 1,
        last_fired  INTEGER NOT NULL DEFAULT 0,
        created_at  INTEGER NOT NULL
      );

      -- AutoMod rules. Match types: 'contains' | 'regex' | 'startswith'.
      CREATE TABLE IF NOT EXISTS automod_rules (
        id         TEXT PRIMARY KEY,
        match_type TEXT NOT NULL,
        pattern    TEXT NOT NULL,
        action     TEXT NOT NULL, -- 'delete' | 'timeout' | 'ban'
        duration_s INTEGER,
        reason     TEXT,
        enabled    INTEGER NOT NULL DEFAULT 1,
        created_at INTEGER NOT NULL
      );

      -- Recent chat events for the panel's chat view. Cap with
      -- a periodic trim trigger so the table never grows unbounded.
      CREATE TABLE IF NOT EXISTS chat_log (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        at         INTEGER NOT NULL,
        kind       TEXT NOT NULL,  -- 'msg' | 'event' | 'system'
        user_login TEXT,
        user_name  TEXT,
        color      TEXT,
        badges     TEXT,
        message    TEXT NOT NULL,
        emote_json TEXT
      );
      CREATE INDEX IF NOT EXISTS chat_log_at_idx ON chat_log(at);

      -- Music library + queue.
      CREATE TABLE IF NOT EXISTS music_tracks (
        id         TEXT PRIMARY KEY,
        path       TEXT NOT NULL,    -- relative to /app/media/music inside container
        title      TEXT,
        artist     TEXT,
        duration_s INTEGER,
        added_at   INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS music_radio_presets (
        id   TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        url  TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
    `);
  },

  // ---- v2: 1.3 — games + studio mode --------------------------
  (db) => {
    db.exec(`
      -- AI Pet creature. Single row (id=1). Stats clamped 0..100.
      -- Personality drifts from chat; mutations are appended JSON.
      CREATE TABLE IF NOT EXISTS pet_state (
        id            INTEGER PRIMARY KEY CHECK (id = 1),
        name          TEXT NOT NULL,
        species       TEXT NOT NULL,
        hunger        INTEGER NOT NULL DEFAULT 50,
        happiness     INTEGER NOT NULL DEFAULT 50,
        energy        INTEGER NOT NULL DEFAULT 50,
        intelligence  INTEGER NOT NULL DEFAULT 50,
        aggression    INTEGER NOT NULL DEFAULT 50,
        morality      INTEGER NOT NULL DEFAULT 50,
        age_minutes   INTEGER NOT NULL DEFAULT 0,
        evolution     INTEGER NOT NULL DEFAULT 0,
        mutations_json TEXT NOT NULL DEFAULT '[]',
        last_action   TEXT,
        last_actor    TEXT,
        last_tick_at  INTEGER NOT NULL DEFAULT 0,
        born_at       INTEGER NOT NULL
      );

      -- Twitch Plays Datacenter. Single row (id=1). Game tick
      -- consumes power, raises temperature, drops uptime under
      -- attack. Chat commands mutate state.
      CREATE TABLE IF NOT EXISTS datacenter_state (
        id            INTEGER PRIMARY KEY CHECK (id = 1),
        servers       INTEGER NOT NULL DEFAULT 3,
        servers_max   INTEGER NOT NULL DEFAULT 3,
        power_kw      INTEGER NOT NULL DEFAULT 10,
        power_kw_cap  INTEGER NOT NULL DEFAULT 20,
        coolant       INTEGER NOT NULL DEFAULT 80,
        temperature_c INTEGER NOT NULL DEFAULT 22,
        uptime_pct    INTEGER NOT NULL DEFAULT 100,
        attacks_active INTEGER NOT NULL DEFAULT 0,
        budget        INTEGER NOT NULL DEFAULT 1000,
        reputation    INTEGER NOT NULL DEFAULT 50,
        tick          INTEGER NOT NULL DEFAULT 0,
        log_json      TEXT NOT NULL DEFAULT '[]',
        last_tick_at  INTEGER NOT NULL DEFAULT 0
      );
    `);
  },

  // ---- v3: 1.4 — track metadata + VOD sources -----------------
  (db) => {
    // ALTER TABLE ADD COLUMN can't be wrapped in CREATE-IF-NOT-EXISTS,
    // but SQLite errors on duplicate-column. Use a defensive PRAGMA
    // check so re-running this migration on a partially-applied DB
    // doesn't blow up.
    const cols = (db.prepare(`PRAGMA table_info(music_tracks)`).all() as any[])
      .map((c) => c.name);
    if (!cols.includes("album"))         db.exec(`ALTER TABLE music_tracks ADD COLUMN album TEXT`);
    if (!cols.includes("cover_path"))    db.exec(`ALTER TABLE music_tracks ADD COLUMN cover_path TEXT`);
    if (!cols.includes("manual"))        db.exec(`ALTER TABLE music_tracks ADD COLUMN manual INTEGER NOT NULL DEFAULT 0`);

    db.exec(`
      -- Pre-recorded video sources. Either a local file uploaded
      -- to /app/media/vods or a remote http(s) URL.
      -- The streamer plays these via its own FFmpeg pipeline,
      -- skipping Chromium entirely (much lower CPU than rendering
      -- a <video> element).
      CREATE TABLE IF NOT EXISTS vod_sources (
        id          TEXT PRIMARY KEY,
        name        TEXT NOT NULL,
        kind        TEXT NOT NULL,           -- 'file' | 'url'
        path_or_url TEXT NOT NULL,           -- filename inside MEDIA_VODS_DIR, or URL
        duration_s  INTEGER,
        size_bytes  INTEGER,
        loop_play   INTEGER NOT NULL DEFAULT 0,
        created_at  INTEGER NOT NULL
      );
    `);
  },

  // ---- v4: 1.5 — custom scenes --------------------------------
  (db) => {
    db.exec(`
      -- User-authored scenes. Each row is rendered by
      -- /scene/custom/[slug]. The 'template' column picks the
      -- renderer; 'config_json' carries the per-template payload
      -- (title, subtitle, accent, social handles, raw HTML, etc.).
      -- Slugs are unique and URL-safe.
      CREATE TABLE IF NOT EXISTS custom_scenes (
        id          TEXT PRIMARY KEY,
        slug        TEXT NOT NULL UNIQUE,
        name        TEXT NOT NULL,
        template    TEXT NOT NULL,          -- 'starting_soon' | 'brb' | 'ending'
                                            -- | 'generic' | 'raw_html'
        config_json TEXT NOT NULL DEFAULT '{}',
        created_at  INTEGER NOT NULL,
        updated_at  INTEGER NOT NULL
      );
    `);
  },

  // ---- v5: 1.13 — moderators + invites ------------------------
  //
  // Multi-broadcaster support. The owner can mint single-use
  // invite codes; an invitee logs in via Twitch OAuth carrying
  // the code on a cookie, which adds them to `moderators`.
  // The session table is unchanged — sessions just identify
  // "which Twitch user is here", and the authz layer checks
  // owner OR moderator membership.
  //
  // We DON'T mirror moderator OAuth tokens. The broadcaster's
  // tokens stay the channel's identity for Helix calls (sending
  // chat AS the broadcaster, etc.); mods just drive the panel
  // and the broadcaster's session-bound permissions flow through.
  (db) => {
    db.exec(`
      -- One row per moderator. Identity is Twitch user id; login
      -- is mirrored for log readability + so an owner inviting by
      -- login can be reconciled when the moderator first signs in.
      CREATE TABLE IF NOT EXISTS moderators (
        twitch_user_id  TEXT PRIMARY KEY,
        twitch_login    TEXT NOT NULL,
        display_name    TEXT NOT NULL,
        added_at        INTEGER NOT NULL,
        added_by_login  TEXT,
        -- Reserved for future per-mod permission scopes (currently
        -- all mods get the staff-tier capability set). Stored as a
        -- JSON array of scope strings; empty = default staff perms.
        scopes_json     TEXT NOT NULL DEFAULT '[]'
      );

      -- Invite codes the owner mints from the Staff tab. Codes are
      -- single-use + carry an optional expiry. When an invitee logs
      -- in with the code on their cookie, the OAuth callback
      -- consumes the row (status = 'consumed' + consumed_by_*)
      -- and inserts into moderators.
      CREATE TABLE IF NOT EXISTS staff_invites (
        code              TEXT PRIMARY KEY,
        label             TEXT,             -- "for jane (mod)" etc.
        created_at        INTEGER NOT NULL,
        created_by_login  TEXT,
        expires_at        INTEGER,          -- nullable = no expiry
        status            TEXT NOT NULL,    -- 'pending' | 'consumed' | 'revoked'
        consumed_at       INTEGER,
        consumed_by_id    TEXT,
        consumed_by_login TEXT
      );
    `);
  },
];

function applySchema(db: Database.Database): void {
  const cur = (db.pragma("user_version", { simple: true }) as number) ?? 0;
  for (let v = cur; v < SCHEMA_VERSIONS.length; v++) {
    db.transaction(() => {
      SCHEMA_VERSIONS[v](db);
      db.pragma(`user_version = ${v + 1}`);
    })();
  }
}

// ---- One-shot JSON → SQLite migration ---------------------------

function migrateFromJson(db: Database.Database, dir: string): void {
  const jsonPath = path.join(dir, "state.json");
  if (!fs.existsSync(jsonPath)) return;

  // Skip if we've already migrated this session.
  const flagged = db.prepare("SELECT value FROM kv WHERE key = 'migrated_from_json'").get() as
    | { value: string } | undefined;
  if (flagged) return;

  let parsed: any;
  try {
    parsed = JSON.parse(fs.readFileSync(jsonPath, "utf8"));
  } catch {
    console.warn("[db] state.json is unreadable; skipping migration");
    return;
  }

  const tx = db.transaction(() => {
    if (parsed.owner) {
      const o = parsed.owner;
      db.prepare(
        `INSERT OR REPLACE INTO owner (id, twitch_user_id, twitch_login, display_name, email, claimed_at, seeded)
         VALUES (1, ?, ?, ?, ?, ?, ?)`
      ).run(o.twitchUserId, String(o.twitchLogin).toLowerCase(), o.displayName, o.email, o.claimedAt, o.seeded ? 1 : 0);
    }

    if (parsed.sessions) {
      const stmt = db.prepare(
        `INSERT OR REPLACE INTO sessions (sid, twitch_user_id, login, display_name, email, created_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      );
      for (const [sid, s] of Object.entries<any>(parsed.sessions)) {
        stmt.run(sid, s.twitchUserId, s.login, s.displayName, s.email, s.createdAt, s.expiresAt);
      }
    }

    if (Array.isArray(parsed.scenes)) {
      const stmt = db.prepare(
        `INSERT OR REPLACE INTO scenes (id, name, url, created_at) VALUES (?, ?, ?, ?)`
      );
      for (const s of parsed.scenes) stmt.run(s.id, s.name, s.url, s.createdAt);
    }

    if (Array.isArray(parsed.overlays)) {
      const stmt = db.prepare(
        `INSERT OR REPLACE INTO overlay_sets (id, name, overlays_json, created_at) VALUES (?, ?, ?, ?)`
      );
      for (const o of parsed.overlays) {
        stmt.run(o.id, o.name, JSON.stringify(o.overlays || []), o.createdAt);
      }
    }

    if (parsed.activeOverlaySetId) {
      db.prepare(`INSERT OR REPLACE INTO kv (key, value) VALUES ('active_overlay_set_id', ?)`)
        .run(String(parsed.activeOverlaySetId));
    }

    if (Array.isArray(parsed.schedule)) {
      const stmt = db.prepare(
        `INSERT OR REPLACE INTO schedule (id, enabled, scene_preset_id, overlay_set_id, at, days_json)
         VALUES (?, ?, ?, ?, ?, ?)`
      );
      for (const e of parsed.schedule) {
        stmt.run(e.id, e.enabled ? 1 : 0, e.scenePresetId, e.overlaySetId || null, e.at, JSON.stringify(e.days || []));
      }
    }

    db.prepare(`INSERT OR REPLACE INTO kv (key, value) VALUES ('migrated_from_json', ?)`)
      .run(new Date().toISOString());
  });

  try {
    tx();
    const archived = `${jsonPath}.migrated-${Date.now()}`;
    fs.renameSync(jsonPath, archived);
    console.log(`[db] migrated state.json → SQLite (archived to ${path.basename(archived)})`);
  } catch (err) {
    console.error("[db] JSON→SQLite migration failed; state.json left in place:", err);
  }
}

// ---- KV helpers (used by anything that just needs a flag) -------

export function kvGet(key: string): string | null {
  const row = getDb().prepare("SELECT value FROM kv WHERE key = ?").get(key) as
    | { value: string } | undefined;
  return row?.value ?? null;
}

export function kvSet(key: string, value: string): void {
  getDb()
    .prepare("INSERT OR REPLACE INTO kv (key, value) VALUES (?, ?)")
    .run(key, value);
}

export function kvDelete(key: string): void {
  getDb().prepare("DELETE FROM kv WHERE key = ?").run(key);
}
