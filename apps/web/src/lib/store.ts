/**
 * Persistence facade.
 *
 * Backed by SQLite (see lib/db.ts). Public API is intentionally
 * compatible with the v1.1 JSON store so existing callers
 * (route handlers, scheduler, OAuth flow) don't need changes —
 * only the rows added in v1.2 (tokens, commands, automod,
 * chat log, music) have new methods.
 *
 * Singleton pattern: getStore() returns the same instance for
 * the life of the process. SQLite handles concurrency.
 */

import crypto from "node:crypto";
import type Database from "better-sqlite3";
import { config } from "./config";
import { getDb, kvGet, kvSet, kvDelete } from "./db";

// ---- Types preserved from v1.1 ----------------------------------

export interface OwnerRecord {
  twitchUserId: string | null;
  twitchLogin: string;
  displayName: string;
  email: string | null;
  claimedAt: string;
  seeded?: boolean;
}

export interface ModeratorRecord {
  twitchUserId: string;
  twitchLogin: string;
  displayName: string;
  addedAt: number;
  addedByLogin: string | null;
  /** Reserved for future per-mod permission scopes; currently always []. */
  scopes: string[];
}

export interface StaffInvite {
  code: string;
  label: string | null;
  createdAt: number;
  createdByLogin: string | null;
  expiresAt: number | null;
  status: "pending" | "consumed" | "revoked";
  consumedAt: number | null;
  consumedById: string | null;
  consumedByLogin: string | null;
}

export interface SessionRecord {
  twitchUserId: string;
  login: string;
  displayName: string;
  email: string | null;
  createdAt: number;
  expiresAt: number;
}

export interface ScenePreset {
  id: string;
  name: string;
  url: string;
  createdAt: number;
}

export interface Overlay {
  id: string;
  type: "text" | "html" | "image" | "chat" | "alert" | "nowplaying";
  text?: string;
  html?: string;
  src?: string;
  top?: string;
  left?: string;
  right?: string;
  bottom?: string;
  width?: string;
  height?: string;
  color?: string;
  background?: string;
  font?: string;
  opacity?: number;
  glow?: boolean;
  border?: string;
  radius?: string;
}

export interface OverlaySet {
  id: string;
  name: string;
  overlays: Overlay[];
  createdAt: number;
}

export interface ScheduleEntry {
  id: string;
  enabled: boolean;
  scenePresetId: string;
  overlaySetId?: string | null;
  at: string;
  days: number[];
}

// ---- New in v1.2 ------------------------------------------------

export interface OAuthTokens {
  accessToken: string;
  refreshToken: string | null;
  expiresAt: number;
  scopes: string[];
  twitchUserId: string;
  updatedAt: number;
}

export interface PlatformLink {
  platform: string;            // 'twitch' | 'kick' | 'youtube' | 'vpzone'
  platformUserId: string;
  login: string | null;
  displayName: string | null;
  avatarUrl: string | null;
  extra: Record<string, unknown>;   // e.g. { chatroomId } for Kick
  scopes: string[];
  linkedAt: number;
}

export interface PlatformTokens {
  platform: string;
  accessToken: string;
  refreshToken: string | null;
  expiresAt: number;
  scopes: string[];
  platformUserId: string | null;
  updatedAt: number;
}

export interface CustomCommand {
  id: string;
  trigger: string;
  response: string;
  cooldownS: number;
  modOnly: boolean;
  subOnly: boolean;
  enabled: boolean;
  lastFired: number;
  createdAt: number;
}

export interface AutoModRule {
  id: string;
  matchType: "contains" | "regex" | "startswith";
  pattern: string;
  action: "delete" | "timeout" | "ban";
  durationS: number | null;
  reason: string | null;
  enabled: boolean;
  createdAt: number;
}

export interface ChatLogEntry {
  id: number;
  at: number;
  kind: "msg" | "event" | "system";
  userLogin: string | null;
  userName: string | null;
  color: string | null;
  badges: string | null;
  message: string;
  emotes: unknown[] | null;
}

export interface MusicTrack {
  id: string;
  path: string;
  title: string | null;
  artist: string | null;
  album: string | null;
  durationS: number | null;
  coverPath: string | null;
  manual: boolean;
  addedAt: number;
}

export interface VodSource {
  id: string;
  name: string;
  kind: "file" | "url";
  pathOrUrl: string;       // filename within MEDIA_VODS_DIR, or http(s) URL
  durationS: number | null;
  sizeBytes: number | null;
  loop: boolean;
  createdAt: number;
}

export type CustomSceneTemplate =
  | "starting_soon"
  | "brb"
  | "ending"
  | "generic"
  | "raw_html";

/**
 * Free-form payload for a custom scene. Each template uses a subset
 * of these fields; the panel UI validates per-template. Unknown
 * fields are kept on round-trip so older payloads survive a
 * template migration.
 */
export interface CustomSceneConfig {
  // Common
  title?: string;
  subtitle?: string;
  accent?: string;          // hex or CSS colour
  background?: string;      // hex / CSS colour / "image:<url>"
  textColor?: string;
  // Countdown (Starting Soon, Ending)
  countdownAt?: string;     // ISO timestamp
  countdownLabel?: string;
  // Social row (Ending)
  twitch?: string;
  youtube?: string;
  twitter?: string;
  discord?: string;
  // Raw HTML escape hatch
  html?: string;
  css?: string;
  // Anything we don't know about yet
  [extra: string]: unknown;
}

export interface CustomScene {
  id: string;
  slug: string;
  name: string;
  template: CustomSceneTemplate;
  config: CustomSceneConfig;
  createdAt: number;
  updatedAt: number;
}

export interface MusicRadioPreset {
  id: string;
  name: string;
  url: string;
  createdAt: number;
}

const SESSION_TTL_MS = 14 * 24 * 60 * 60 * 1000;
const CHAT_LOG_CAP = 2000;

class Store {
  private db: Database.Database;

  constructor() {
    this.db = getDb();
    // Seed owner from INITIAL_OWNER_LOGIN if vacant.
    if (!this.getOwner() && config.oauth.initialOwnerLogin) {
      this.db.prepare(
        `INSERT OR REPLACE INTO owner (id, twitch_user_id, twitch_login, display_name, email, claimed_at, seeded)
         VALUES (1, NULL, ?, ?, NULL, ?, 1)`
      ).run(
        config.oauth.initialOwnerLogin,
        config.oauth.initialOwnerLogin,
        new Date().toISOString()
      );
    }
    this.gcSessions();
  }

  // ---- Owner ----------------------------------------------------

  getOwner(): OwnerRecord | null {
    const row = this.db.prepare("SELECT * FROM owner WHERE id = 1").get() as any;
    if (!row) return null;
    return {
      twitchUserId: row.twitch_user_id,
      twitchLogin:  row.twitch_login,
      displayName:  row.display_name,
      email:        row.email,
      claimedAt:    row.claimed_at,
      ...(row.seeded ? { seeded: true } : {}),
    };
  }

  claimOwnerIfUnset(user: {
    id: string;
    login: string;
    display_name?: string;
    email?: string;
  }): boolean {
    if (this.getOwner()) return false;
    this.db.prepare(
      `INSERT INTO owner (id, twitch_user_id, twitch_login, display_name, email, claimed_at, seeded)
       VALUES (1, ?, ?, ?, ?, ?, 0)`
    ).run(
      user.id,
      user.login.toLowerCase(),
      user.display_name || user.login,
      user.email || null,
      new Date().toISOString()
    );
    return true;
  }

  isOwner(user: { id?: string | null; login?: string | null }): boolean {
    const o = this.getOwner();
    if (!o || !user) return false;
    if (user.id && o.twitchUserId && o.twitchUserId === user.id) return true;
    return Boolean(user.login && o.twitchLogin === String(user.login).toLowerCase());
  }

  upgradeOwnerFromUser(user: {
    id: string;
    login: string;
    display_name?: string;
    email?: string;
  }): void {
    const o = this.getOwner();
    if (!o || !this.isOwner(user)) return;
    this.db.prepare(
      `UPDATE owner SET
         twitch_user_id = COALESCE(twitch_user_id, ?),
         display_name   = ?,
         email          = COALESCE(?, email),
         seeded         = 0
       WHERE id = 1`
    ).run(user.id, user.display_name || user.login, user.email || null);
  }

  // ---- Moderators + invites (v1.13.0) ---------------------------
  //
  // Multi-broadcaster support. The owner mints single-use invite
  // codes; an invitee logs in via Twitch OAuth carrying the code
  // on a cookie, the OAuth callback consumes the row and adds
  // them to `moderators`. Mods then have staffRoute-level access
  // (driving the panel, switching scenes, sending chat) without
  // needing the broadcaster's password.

  listModerators(): ModeratorRecord[] {
    const rows = this.db.prepare(
      "SELECT * FROM moderators ORDER BY added_at"
    ).all() as any[];
    return rows.map((r) => ({
      twitchUserId:  r.twitch_user_id,
      twitchLogin:   r.twitch_login,
      displayName:   r.display_name,
      addedAt:       r.added_at,
      addedByLogin:  r.added_by_login,
      scopes:        safeJson(r.scopes_json, []),
    }));
  }

  isModerator(user: { id?: string | null; login?: string | null }): boolean {
    if (!user) return false;
    if (user.id) {
      const r = this.db.prepare(
        "SELECT 1 FROM moderators WHERE twitch_user_id = ?"
      ).get(user.id);
      if (r) return true;
    }
    if (user.login) {
      const r = this.db.prepare(
        "SELECT 1 FROM moderators WHERE twitch_login = ?"
      ).get(String(user.login).toLowerCase());
      if (r) return true;
    }
    return false;
  }

  /** Owner OR mod — the staffRoute() gate's authority check. */
  isStaff(user: { id?: string | null; login?: string | null }): boolean {
    return this.isOwner(user) || this.isModerator(user);
  }

  addModerator(args: {
    twitchUserId: string;
    twitchLogin: string;
    displayName: string;
    addedByLogin?: string | null;
  }): ModeratorRecord {
    this.db.prepare(
      `INSERT OR REPLACE INTO moderators
         (twitch_user_id, twitch_login, display_name, added_at, added_by_login, scopes_json)
       VALUES (?, ?, ?, ?, ?, '[]')`
    ).run(
      args.twitchUserId,
      String(args.twitchLogin).toLowerCase(),
      args.displayName,
      Date.now(),
      args.addedByLogin || null,
    );
    return {
      twitchUserId: args.twitchUserId,
      twitchLogin:  String(args.twitchLogin).toLowerCase(),
      displayName:  args.displayName,
      addedAt:      Date.now(),
      addedByLogin: args.addedByLogin || null,
      scopes:       [],
    };
  }

  removeModerator(twitchUserId: string): boolean {
    return this.db.prepare(
      "DELETE FROM moderators WHERE twitch_user_id = ?"
    ).run(twitchUserId).changes > 0;
  }

  // ---- Invites --------------------------------------------------

  listInvites(): StaffInvite[] {
    const rows = this.db.prepare(
      "SELECT * FROM staff_invites ORDER BY created_at DESC"
    ).all() as any[];
    return rows.map(mapInvite);
  }

  createInvite(args: {
    label?: string | null;
    createdByLogin?: string | null;
    expiresAt?: number | null;
  }): StaffInvite {
    // 24-character urlsafe code. Long enough that brute-forcing is
    // hopeless even without rate limiting; short enough to read
    // aloud once if needed.
    const code = crypto.randomBytes(18).toString("base64url");
    const now = Date.now();
    this.db.prepare(
      `INSERT INTO staff_invites
         (code, label, created_at, created_by_login, expires_at, status)
       VALUES (?, ?, ?, ?, ?, 'pending')`
    ).run(code, args.label || null, now, args.createdByLogin || null,
          args.expiresAt ?? null);
    return {
      code,
      label:            args.label || null,
      createdAt:        now,
      createdByLogin:   args.createdByLogin || null,
      expiresAt:        args.expiresAt ?? null,
      status:           "pending",
      consumedAt:       null,
      consumedById:     null,
      consumedByLogin:  null,
    };
  }

  /** Atomically claim an invite code + add the user as a moderator. */
  consumeInvite(code: string, user: {
    id: string;
    login: string;
    displayName: string;
  }): { ok: true; moderator: ModeratorRecord } | { ok: false; reason: string } {
    return this.db.transaction(() => {
      const row = this.db.prepare(
        "SELECT * FROM staff_invites WHERE code = ?"
      ).get(code) as any;
      if (!row) return { ok: false as const, reason: "not_found" };
      if (row.status !== "pending") {
        return { ok: false as const, reason: `already ${row.status}` };
      }
      if (row.expires_at && row.expires_at < Date.now()) {
        // Mark as expired-effectively so listing shows it as such;
        // technically we could leave it 'pending' with the timestamp
        // and let the UI render the state, but flipping to 'revoked'
        // is simpler.
        this.db.prepare("UPDATE staff_invites SET status = 'revoked' WHERE code = ?").run(code);
        return { ok: false as const, reason: "expired" };
      }
      // Don't add the owner as a moderator — pointless.
      if (this.isOwner(user)) {
        return { ok: false as const, reason: "you are the owner" };
      }
      const mod = this.addModerator({
        twitchUserId: user.id,
        twitchLogin:  user.login,
        displayName:  user.displayName,
        addedByLogin: row.created_by_login,
      });
      this.db.prepare(
        `UPDATE staff_invites
            SET status = 'consumed',
                consumed_at = ?,
                consumed_by_id = ?,
                consumed_by_login = ?
          WHERE code = ?`
      ).run(Date.now(), user.id, String(user.login).toLowerCase(), code);
      return { ok: true as const, moderator: mod };
    })();
  }

  revokeInvite(code: string): boolean {
    return this.db.prepare(
      "UPDATE staff_invites SET status = 'revoked' WHERE code = ? AND status = 'pending'"
    ).run(code).changes > 0;
  }

  // ---- Sessions -------------------------------------------------

  createSession(user: {
    id: string;
    login: string;
    display_name?: string;
    email?: string;
  }): { sid: string; expiresAt: number } {
    const sid = crypto.randomBytes(32).toString("hex");
    const now = Date.now();
    const expiresAt = now + SESSION_TTL_MS;
    this.db.prepare(
      `INSERT INTO sessions (sid, twitch_user_id, login, display_name, email, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(sid, user.id, user.login, user.display_name || user.login, user.email || null, now, expiresAt);
    return { sid, expiresAt };
  }

  getSession(sid: string | null | undefined): SessionRecord | null {
    if (!sid) return null;
    const row = this.db.prepare("SELECT * FROM sessions WHERE sid = ?").get(sid) as any;
    if (!row) return null;
    if (row.expires_at < Date.now()) {
      this.destroySession(sid);
      return null;
    }
    return {
      twitchUserId: row.twitch_user_id,
      login:        row.login,
      displayName:  row.display_name,
      email:        row.email,
      createdAt:    row.created_at,
      expiresAt:    row.expires_at,
    };
  }

  destroySession(sid: string | null | undefined): void {
    if (!sid) return;
    this.db.prepare("DELETE FROM sessions WHERE sid = ?").run(sid);
  }

  private gcSessions(): void {
    this.db.prepare("DELETE FROM sessions WHERE expires_at < ?").run(Date.now());
  }

  // ---- Scenes ---------------------------------------------------

  listScenes(): ScenePreset[] {
    const rows = this.db.prepare("SELECT * FROM scenes ORDER BY created_at").all() as any[];
    return rows.map((r) => ({ id: r.id, name: r.name, url: r.url, createdAt: r.created_at }));
  }

  addScene(name: string, url: string): ScenePreset {
    const preset: ScenePreset = {
      id: crypto.randomUUID(),
      name: name.trim() || "untitled",
      url: url.trim(),
      createdAt: Date.now(),
    };
    this.db.prepare("INSERT INTO scenes (id, name, url, created_at) VALUES (?, ?, ?, ?)")
      .run(preset.id, preset.name, preset.url, preset.createdAt);
    return preset;
  }

  removeScene(id: string): boolean {
    const r = this.db.prepare("DELETE FROM scenes WHERE id = ?").run(id);
    return r.changes > 0;
  }

  updateSceneUrl(id: string, url: string): boolean {
    const r = this.db.prepare("UPDATE scenes SET url = ? WHERE id = ?").run(url.trim(), id);
    return r.changes > 0;
  }

  getScene(id: string): ScenePreset | null {
    const r = this.db.prepare("SELECT * FROM scenes WHERE id = ?").get(id) as any;
    return r ? { id: r.id, name: r.name, url: r.url, createdAt: r.created_at } : null;
  }

  // ---- Overlay sets --------------------------------------------

  listOverlaySets(): OverlaySet[] {
    const rows = this.db.prepare("SELECT * FROM overlay_sets ORDER BY created_at").all() as any[];
    return rows.map((r) => ({
      id: r.id, name: r.name,
      overlays: JSON.parse(r.overlays_json) as Overlay[],
      createdAt: r.created_at,
    }));
  }

  saveOverlaySet(name: string, overlays: Overlay[]): OverlaySet {
    const set: OverlaySet = {
      id: crypto.randomUUID(),
      name: name.trim() || "untitled",
      overlays,
      createdAt: Date.now(),
    };
    this.db.prepare(
      "INSERT INTO overlay_sets (id, name, overlays_json, created_at) VALUES (?, ?, ?, ?)"
    ).run(set.id, set.name, JSON.stringify(set.overlays), set.createdAt);
    return set;
  }

  /** Update overlays inside an existing set (used by Studio Mode). */
  updateOverlaySet(id: string, overlays: Overlay[]): OverlaySet | null {
    const existing = this.getOverlaySet(id);
    if (!existing) return null;
    this.db.prepare("UPDATE overlay_sets SET overlays_json = ? WHERE id = ?")
      .run(JSON.stringify(overlays), id);
    return { ...existing, overlays };
  }

  removeOverlaySet(id: string): boolean {
    const r = this.db.prepare("DELETE FROM overlay_sets WHERE id = ?").run(id);
    if (this.getActiveOverlaySetId() === id) kvDelete("active_overlay_set_id");
    return r.changes > 0;
  }

  getOverlaySet(id: string): OverlaySet | null {
    const r = this.db.prepare("SELECT * FROM overlay_sets WHERE id = ?").get(id) as any;
    if (!r) return null;
    return {
      id: r.id, name: r.name,
      overlays: JSON.parse(r.overlays_json),
      createdAt: r.created_at,
    };
  }

  getActiveOverlaySetId(): string | null { return kvGet("active_overlay_set_id"); }

  setActiveOverlaySet(id: string | null): void {
    if (id) kvSet("active_overlay_set_id", id);
    else kvDelete("active_overlay_set_id");
  }

  getActiveOverlaySet(): OverlaySet | null {
    const id = this.getActiveOverlaySetId();
    return id ? this.getOverlaySet(id) : null;
  }

  // ---- Schedule -------------------------------------------------

  listSchedule(): ScheduleEntry[] {
    const rows = this.db.prepare("SELECT * FROM schedule").all() as any[];
    return rows.map((r) => ({
      id: r.id, enabled: !!r.enabled,
      scenePresetId: r.scene_preset_id,
      overlaySetId: r.overlay_set_id,
      at: r.at,
      days: JSON.parse(r.days_json),
    }));
  }

  addSchedule(entry: Omit<ScheduleEntry, "id">): ScheduleEntry {
    const e: ScheduleEntry = { id: crypto.randomUUID(), ...entry };
    this.db.prepare(
      `INSERT INTO schedule (id, enabled, scene_preset_id, overlay_set_id, at, days_json)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).run(e.id, e.enabled ? 1 : 0, e.scenePresetId, e.overlaySetId ?? null, e.at, JSON.stringify(e.days));
    return e;
  }

  updateSchedule(id: string, patch: Partial<ScheduleEntry>): ScheduleEntry | null {
    const existing = this.listSchedule().find((s) => s.id === id);
    if (!existing) return null;
    const merged = { ...existing, ...patch, id };
    this.db.prepare(
      `UPDATE schedule SET enabled = ?, scene_preset_id = ?, overlay_set_id = ?, at = ?, days_json = ?
       WHERE id = ?`
    ).run(
      merged.enabled ? 1 : 0,
      merged.scenePresetId,
      merged.overlaySetId ?? null,
      merged.at,
      JSON.stringify(merged.days),
      id
    );
    return merged;
  }

  removeSchedule(id: string): boolean {
    return this.db.prepare("DELETE FROM schedule WHERE id = ?").run(id).changes > 0;
  }

  // ---- v1.2: OAuth tokens --------------------------------------

  saveTokens(t: OAuthTokens): void {
    this.db.prepare(
      `INSERT OR REPLACE INTO oauth_tokens
        (id, access_token, refresh_token, expires_at, scopes_json, twitch_user_id, updated_at)
       VALUES (1, ?, ?, ?, ?, ?, ?)`
    ).run(t.accessToken, t.refreshToken, t.expiresAt, JSON.stringify(t.scopes), t.twitchUserId, t.updatedAt);
  }

  getTokens(): OAuthTokens | null {
    const r = this.db.prepare("SELECT * FROM oauth_tokens WHERE id = 1").get() as any;
    if (!r) return null;
    return {
      accessToken: r.access_token,
      refreshToken: r.refresh_token,
      expiresAt: r.expires_at,
      scopes: JSON.parse(r.scopes_json),
      twitchUserId: r.twitch_user_id,
      updatedAt: r.updated_at,
    };
  }

  clearTokens(): void { this.db.prepare("DELETE FROM oauth_tokens WHERE id = 1").run(); }

  // ---- Multi-platform accounts (Kick/YouTube/VPzone alongside Twitch) ----

  listPlatformLinks(): PlatformLink[] {
    return (this.db.prepare("SELECT * FROM platform_links ORDER BY linked_at").all() as any[])
      .map(mapPlatformLink);
  }

  getPlatformLink(platform: string): PlatformLink | null {
    const r = this.db.prepare("SELECT * FROM platform_links WHERE platform = ? LIMIT 1").get(platform) as any;
    return r ? mapPlatformLink(r) : null;
  }

  savePlatformLink(l: Omit<PlatformLink, "linkedAt"> & { linkedAt?: number }): PlatformLink {
    const linkedAt = l.linkedAt ?? Date.now();
    this.db.prepare(
      `INSERT INTO platform_links
        (platform, platform_user_id, login, display_name, avatar_url, extra_json, scopes_json, linked_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(platform, platform_user_id) DO UPDATE SET
         login=excluded.login, display_name=excluded.display_name,
         avatar_url=excluded.avatar_url, extra_json=excluded.extra_json,
         scopes_json=excluded.scopes_json`
    ).run(
      l.platform, l.platformUserId, l.login, l.displayName, l.avatarUrl,
      JSON.stringify(l.extra || {}), JSON.stringify(l.scopes || []), linkedAt,
    );
    return { ...l, extra: l.extra || {}, scopes: l.scopes || [], linkedAt };
  }

  removePlatformLink(platform: string): void {
    this.db.prepare("DELETE FROM platform_links WHERE platform = ?").run(platform);
    this.db.prepare("DELETE FROM platform_tokens WHERE platform = ?").run(platform);
  }

  getPlatformTokens(platform: string): PlatformTokens | null {
    const r = this.db.prepare("SELECT * FROM platform_tokens WHERE platform = ?").get(platform) as any;
    if (!r) return null;
    return {
      platform: r.platform,
      accessToken: r.access_token,
      refreshToken: r.refresh_token,
      expiresAt: r.expires_at,
      scopes: JSON.parse(r.scopes_json),
      platformUserId: r.platform_user_id,
      updatedAt: r.updated_at,
    };
  }

  savePlatformTokens(t: PlatformTokens): void {
    this.db.prepare(
      `INSERT OR REPLACE INTO platform_tokens
        (platform, access_token, refresh_token, expires_at, scopes_json, platform_user_id, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(
      t.platform, t.accessToken, t.refreshToken, t.expiresAt,
      JSON.stringify(t.scopes), t.platformUserId, t.updatedAt,
    );
  }

  // ---- v1.2: Custom commands -----------------------------------

  listCommands(): CustomCommand[] {
    const rows = this.db.prepare("SELECT * FROM commands ORDER BY trigger").all() as any[];
    return rows.map(mapCommand);
  }

  getCommandByTrigger(trigger: string): CustomCommand | null {
    const r = this.db.prepare("SELECT * FROM commands WHERE trigger = ?").get(trigger.toLowerCase()) as any;
    return r ? mapCommand(r) : null;
  }

  addCommand(c: Omit<CustomCommand, "id" | "createdAt" | "lastFired">): CustomCommand {
    const row: CustomCommand = {
      id: crypto.randomUUID(),
      trigger: c.trigger.toLowerCase().trim(),
      response: c.response,
      cooldownS: c.cooldownS,
      modOnly: c.modOnly,
      subOnly: c.subOnly,
      enabled: c.enabled,
      lastFired: 0,
      createdAt: Date.now(),
    };
    this.db.prepare(
      `INSERT INTO commands (id, trigger, response, cooldown_s, mod_only, sub_only, enabled, last_fired, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?)`
    ).run(row.id, row.trigger, row.response, row.cooldownS, row.modOnly ? 1 : 0, row.subOnly ? 1 : 0, row.enabled ? 1 : 0, row.createdAt);
    return row;
  }

  updateCommand(id: string, patch: Partial<CustomCommand>): CustomCommand | null {
    const existing = this.db.prepare("SELECT * FROM commands WHERE id = ?").get(id) as any;
    if (!existing) return null;
    const merged = mapCommand(existing);
    Object.assign(merged, patch, { id });
    this.db.prepare(
      `UPDATE commands SET trigger = ?, response = ?, cooldown_s = ?, mod_only = ?, sub_only = ?, enabled = ?
       WHERE id = ?`
    ).run(merged.trigger.toLowerCase(), merged.response, merged.cooldownS, merged.modOnly ? 1 : 0, merged.subOnly ? 1 : 0, merged.enabled ? 1 : 0, id);
    return merged;
  }

  markCommandFired(id: string, t: number): void {
    this.db.prepare("UPDATE commands SET last_fired = ? WHERE id = ?").run(t, id);
  }

  removeCommand(id: string): boolean {
    return this.db.prepare("DELETE FROM commands WHERE id = ?").run(id).changes > 0;
  }

  // ---- v1.2: AutoMod rules -------------------------------------

  listAutoModRules(): AutoModRule[] {
    const rows = this.db.prepare("SELECT * FROM automod_rules ORDER BY created_at").all() as any[];
    return rows.map(mapAutoMod);
  }

  addAutoModRule(r: Omit<AutoModRule, "id" | "createdAt">): AutoModRule {
    const row: AutoModRule = { id: crypto.randomUUID(), createdAt: Date.now(), ...r };
    this.db.prepare(
      `INSERT INTO automod_rules (id, match_type, pattern, action, duration_s, reason, enabled, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(row.id, row.matchType, row.pattern, row.action, row.durationS, row.reason, row.enabled ? 1 : 0, row.createdAt);
    return row;
  }

  updateAutoModRule(id: string, patch: Partial<AutoModRule>): AutoModRule | null {
    const existing = this.db.prepare("SELECT * FROM automod_rules WHERE id = ?").get(id) as any;
    if (!existing) return null;
    const merged = mapAutoMod(existing);
    Object.assign(merged, patch, { id });
    this.db.prepare(
      `UPDATE automod_rules SET match_type = ?, pattern = ?, action = ?, duration_s = ?, reason = ?, enabled = ?
       WHERE id = ?`
    ).run(merged.matchType, merged.pattern, merged.action, merged.durationS, merged.reason, merged.enabled ? 1 : 0, id);
    return merged;
  }

  removeAutoModRule(id: string): boolean {
    return this.db.prepare("DELETE FROM automod_rules WHERE id = ?").run(id).changes > 0;
  }

  // ---- v1.2: Chat log ------------------------------------------

  /** Insert a chat log entry; the log is auto-capped at CHAT_LOG_CAP. */
  appendChatLog(entry: Omit<ChatLogEntry, "id">): ChatLogEntry {
    const r = this.db.prepare(
      `INSERT INTO chat_log (at, kind, user_login, user_name, color, badges, message, emote_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(entry.at, entry.kind, entry.userLogin, entry.userName, entry.color, entry.badges, entry.message,
          entry.emotes ? JSON.stringify(entry.emotes) : null);
    // Periodic trim (cheap because of id index).
    if (Number(r.lastInsertRowid) % 50 === 0) {
      this.db.prepare(
        `DELETE FROM chat_log WHERE id IN (
           SELECT id FROM chat_log ORDER BY id DESC LIMIT -1 OFFSET ?
         )`
      ).run(CHAT_LOG_CAP);
    }
    return { id: Number(r.lastInsertRowid), ...entry };
  }

  listChatLog(limit = 200): ChatLogEntry[] {
    const rows = this.db.prepare("SELECT * FROM chat_log ORDER BY id DESC LIMIT ?").all(limit) as any[];
    return rows.reverse().map(mapChatLog);
  }

  // ---- v1.2: Music library + radio -----------------------------

  listMusicTracks(): MusicTrack[] {
    return (this.db.prepare("SELECT * FROM music_tracks ORDER BY added_at").all() as any[])
      .map(mapMusicTrack);
  }

  getMusicTrack(id: string): MusicTrack | null {
    const r = this.db.prepare("SELECT * FROM music_tracks WHERE id = ?").get(id) as any;
    return r ? mapMusicTrack(r) : null;
  }

  upsertMusicTrack(t: Omit<MusicTrack, "id" | "addedAt"> & { id?: string }): MusicTrack {
    const id = t.id ?? crypto.randomUUID();
    const addedAt = Date.now();
    this.db.prepare(
      `INSERT INTO music_tracks (id, path, title, artist, album, duration_s, cover_path, manual, added_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         path        = excluded.path,
         title       = excluded.title,
         artist      = excluded.artist,
         album       = excluded.album,
         duration_s  = excluded.duration_s,
         cover_path  = excluded.cover_path,
         manual      = excluded.manual`
    ).run(id, t.path, t.title, t.artist, t.album, t.durationS, t.coverPath, t.manual ? 1 : 0, addedAt);
    return { id, addedAt, ...t };
  }

  /** Update editable metadata only (title / artist / album / cover). */
  updateMusicTrackMeta(id: string, patch: { title?: string | null; artist?: string | null; album?: string | null; coverPath?: string | null }): MusicTrack | null {
    const existing = this.getMusicTrack(id);
    if (!existing) return null;
    const next = { ...existing, ...patch, manual: true };
    this.db.prepare(
      `UPDATE music_tracks
         SET title=?, artist=?, album=?, cover_path=?, manual=1
       WHERE id=?`
    ).run(next.title, next.artist, next.album, next.coverPath, id);
    return next;
  }

  /**
   * Persist an auto-extracted cover path WITHOUT flagging the track
   * as manually edited. Used by the self-healing cover route so a
   * later rescan can still re-derive everything else from tags.
   */
  setMusicTrackCover(id: string, coverPath: string | null): void {
    this.db.prepare("UPDATE music_tracks SET cover_path=? WHERE id=?").run(coverPath, id);
  }

  removeMusicTrack(id: string): boolean {
    return this.db.prepare("DELETE FROM music_tracks WHERE id = ?").run(id).changes > 0;
  }

  // ---- VOD sources --------------------------------------------

  listVods(): VodSource[] {
    return (this.db.prepare("SELECT * FROM vod_sources ORDER BY created_at").all() as any[])
      .map(mapVod);
  }

  getVod(id: string): VodSource | null {
    const r = this.db.prepare("SELECT * FROM vod_sources WHERE id = ?").get(id) as any;
    return r ? mapVod(r) : null;
  }

  addVod(v: Omit<VodSource, "id" | "createdAt">): VodSource {
    const row: VodSource = { id: crypto.randomUUID(), createdAt: Date.now(), ...v };
    this.db.prepare(
      `INSERT INTO vod_sources
        (id, name, kind, path_or_url, duration_s, size_bytes, loop_play, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(row.id, row.name, row.kind, row.pathOrUrl, row.durationS, row.sizeBytes, row.loop ? 1 : 0, row.createdAt);
    return row;
  }

  updateVod(id: string, patch: Partial<VodSource>): VodSource | null {
    const existing = this.getVod(id);
    if (!existing) return null;
    const next = { ...existing, ...patch, id };
    this.db.prepare(
      `UPDATE vod_sources
         SET name=?, kind=?, path_or_url=?, duration_s=?, size_bytes=?, loop_play=?
       WHERE id=?`
    ).run(next.name, next.kind, next.pathOrUrl, next.durationS, next.sizeBytes, next.loop ? 1 : 0, id);
    return next;
  }

  removeVod(id: string): boolean {
    return this.db.prepare("DELETE FROM vod_sources WHERE id = ?").run(id).changes > 0;
  }

  // ---- Custom scenes (v1.5) -----------------------------------

  listCustomScenes(): CustomScene[] {
    return (this.db.prepare("SELECT * FROM custom_scenes ORDER BY created_at").all() as any[])
      .map(mapCustomScene);
  }

  getCustomSceneById(id: string): CustomScene | null {
    const r = this.db.prepare("SELECT * FROM custom_scenes WHERE id = ?").get(id) as any;
    return r ? mapCustomScene(r) : null;
  }

  getCustomSceneBySlug(slug: string): CustomScene | null {
    const r = this.db.prepare("SELECT * FROM custom_scenes WHERE slug = ?").get(slug) as any;
    return r ? mapCustomScene(r) : null;
  }

  addCustomScene(input: {
    slug: string;
    name: string;
    template: CustomSceneTemplate;
    config: CustomSceneConfig;
  }): CustomScene {
    const now = Date.now();
    const row: CustomScene = {
      id: crypto.randomUUID(),
      slug: input.slug,
      name: input.name,
      template: input.template,
      config: input.config,
      createdAt: now,
      updatedAt: now,
    };
    this.db.prepare(
      `INSERT INTO custom_scenes (id, slug, name, template, config_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(row.id, row.slug, row.name, row.template, JSON.stringify(row.config), now, now);
    return row;
  }

  updateCustomScene(id: string, patch: Partial<{
    slug: string;
    name: string;
    template: CustomSceneTemplate;
    config: CustomSceneConfig;
  }>): CustomScene | null {
    const existing = this.getCustomSceneById(id);
    if (!existing) return null;
    const next: CustomScene = {
      ...existing,
      ...patch,
      // Merge config rather than replace so a partial UI save
      // doesn't wipe other fields.
      config: patch.config ? { ...existing.config, ...patch.config } : existing.config,
      updatedAt: Date.now(),
    };
    this.db.prepare(
      `UPDATE custom_scenes
         SET slug=?, name=?, template=?, config_json=?, updated_at=?
       WHERE id=?`
    ).run(next.slug, next.name, next.template, JSON.stringify(next.config), next.updatedAt, id);
    return next;
  }

  removeCustomScene(id: string): boolean {
    return this.db.prepare("DELETE FROM custom_scenes WHERE id = ?").run(id).changes > 0;
  }

  listRadioPresets(): MusicRadioPreset[] {
    return (this.db.prepare("SELECT * FROM music_radio_presets ORDER BY created_at").all() as any[])
      .map((r) => ({ id: r.id, name: r.name, url: r.url, createdAt: r.created_at }));
  }

  addRadioPreset(name: string, url: string): MusicRadioPreset {
    const row: MusicRadioPreset = {
      id: crypto.randomUUID(), name: name.trim() || "untitled", url: url.trim(),
      createdAt: Date.now(),
    };
    this.db.prepare(
      "INSERT INTO music_radio_presets (id, name, url, created_at) VALUES (?, ?, ?, ?)"
    ).run(row.id, row.name, row.url, row.createdAt);
    return row;
  }

  removeRadioPreset(id: string): boolean {
    return this.db.prepare("DELETE FROM music_radio_presets WHERE id = ?").run(id).changes > 0;
  }
}

function mapCommand(r: any): CustomCommand {
  return {
    id: r.id, trigger: r.trigger, response: r.response,
    cooldownS: r.cooldown_s, modOnly: !!r.mod_only, subOnly: !!r.sub_only,
    enabled: !!r.enabled, lastFired: r.last_fired, createdAt: r.created_at,
  };
}

function mapAutoMod(r: any): AutoModRule {
  return {
    id: r.id, matchType: r.match_type, pattern: r.pattern, action: r.action,
    durationS: r.duration_s, reason: r.reason, enabled: !!r.enabled, createdAt: r.created_at,
  };
}

function mapChatLog(r: any): ChatLogEntry {
  return {
    id: r.id, at: r.at, kind: r.kind,
    userLogin: r.user_login, userName: r.user_name,
    color: r.color, badges: r.badges, message: r.message,
    emotes: r.emote_json ? JSON.parse(r.emote_json) : null,
  };
}

function mapMusicTrack(r: any): MusicTrack {
  return {
    id: r.id, path: r.path,
    title: r.title, artist: r.artist, album: r.album ?? null,
    durationS: r.duration_s, coverPath: r.cover_path ?? null,
    manual: !!r.manual,
    addedAt: r.added_at,
  };
}

function mapPlatformLink(r: any): PlatformLink {
  let extra: Record<string, unknown> = {};
  try { extra = JSON.parse(r.extra_json || "{}"); } catch {}
  return {
    platform: r.platform,
    platformUserId: r.platform_user_id,
    login: r.login ?? null,
    displayName: r.display_name ?? null,
    avatarUrl: r.avatar_url ?? null,
    extra,
    scopes: JSON.parse(r.scopes_json || "[]"),
    linkedAt: r.linked_at,
  };
}

function mapVod(r: any): VodSource {
  return {
    id: r.id, name: r.name, kind: r.kind,
    pathOrUrl: r.path_or_url,
    durationS: r.duration_s, sizeBytes: r.size_bytes,
    loop: !!r.loop_play,
    createdAt: r.created_at,
  };
}

function mapCustomScene(r: any): CustomScene {
  let config: CustomSceneConfig = {};
  try { config = r.config_json ? JSON.parse(r.config_json) : {}; }
  catch { config = {}; }
  return {
    id: r.id, slug: r.slug, name: r.name,
    template: r.template as CustomSceneTemplate,
    config,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

function mapInvite(r: any): StaffInvite {
  return {
    code:            r.code,
    label:           r.label ?? null,
    createdAt:       r.created_at,
    createdByLogin:  r.created_by_login ?? null,
    expiresAt:       r.expires_at ?? null,
    status:          r.status,
    consumedAt:      r.consumed_at ?? null,
    consumedById:    r.consumed_by_id ?? null,
    consumedByLogin: r.consumed_by_login ?? null,
  };
}

/** JSON.parse with a typed fallback. Used for nullable JSON columns. */
function safeJson<T>(s: string | null | undefined, fallback: T): T {
  if (!s) return fallback;
  try { return JSON.parse(s) as T; }
  catch { return fallback; }
}

let _store: Store | null = null;
export function getStore(): Store {
  if (!_store) _store = new Store();
  return _store;
}
