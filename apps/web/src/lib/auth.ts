/**
 * Auth helpers for API routes and server components.
 *
 *   getCurrentSession() — read + validate the session cookie
 *   requireOwner()      — throws if caller isn't the broadcaster
 *   requireStaff()      — throws if caller isn't owner OR moderator
 *   getCurrentRole()    — "owner" | "mod" | null without throwing
 *
 * Using next/headers so this works in both route handlers
 * and React Server Components without a separate code path.
 *
 * Role model (v1.13.0):
 *
 *   owner — the broadcaster who completed the first-run wizard.
 *           Exactly one per deployment. All-powerful: can mint
 *           invites, manage / revoke moderators, change branding,
 *           and rotate the stream key. Helix calls authenticated
 *           as the owner are how chat sends go out.
 *
 *   mod   — anyone the owner has invited via /api/staff/invites
 *           and who logged in via Twitch with the invite cookie
 *           set. Drives the panel — switches scenes, sends chat,
 *           runs commands. Cannot mint invites, manage other mods,
 *           or change destructive settings (stream key, OAuth app).
 */

import { cookies } from "next/headers";
import { SESSION_COOKIE, unsign } from "./cookies";
import { getStore, type SessionRecord } from "./store";

export type Role = "owner" | "mod" | null;

export function getCurrentSession(): SessionRecord | null {
  const signed = cookies().get(SESSION_COOKIE)?.value;
  const sid = unsign(signed);
  if (!sid) return null;
  return getStore().getSession(sid);
}

/** Owner / mod / nobody. Doesn't throw. */
export function getCurrentRole(): Role {
  const s = getCurrentSession();
  if (!s) return null;
  const store = getStore();
  const u = { id: s.twitchUserId, login: s.login };
  if (store.isOwner(u)) return "owner";
  if (store.isModerator(u)) return "mod";
  return null;
}

export class AuthError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

/**
 * Throws if the caller isn't the broadcaster. Use for actions
 * that meaningfully change the deployment's identity or charge
 * the broadcaster: rotating stream keys, claiming ownership,
 * inviting moderators, deleting other moderators, modifying
 * branding.
 */
export function requireOwner(): SessionRecord {
  const session = getCurrentSession();
  if (!session) throw new AuthError(401, "auth_required");
  const store = getStore();
  if (!store.isOwner({ id: session.twitchUserId, login: session.login })) {
    throw new AuthError(403, "not_owner");
  }
  return session;
}

/**
 * Throws if the caller isn't owner OR moderator. Use for the
 * everyday panel actions a mod is expected to drive: switching
 * scenes, sending chat, managing music queue, running commands,
 * triggering ad breaks, etc.
 *
 * Returns the SessionRecord + resolved role so callers can
 * gate sub-features by role without re-querying.
 */
export function requireStaff(): SessionRecord & { role: "owner" | "mod" } {
  const session = getCurrentSession();
  if (!session) throw new AuthError(401, "auth_required");
  const store = getStore();
  const u = { id: session.twitchUserId, login: session.login };
  if (store.isOwner(u))      return { ...session, role: "owner" };
  if (store.isModerator(u))  return { ...session, role: "mod" };
  throw new AuthError(403, "not_staff");
}
