/**
 * Auth helpers for API routes and server components.
 *
 *   getCurrentSession()  — read + validate the session cookie
 *   requireOwner()       — throws (with status) if caller isn't owner
 *
 * Using next/headers so this works in both route handlers
 * and React Server Components without a separate code path.
 */

import { cookies } from "next/headers";
import { SESSION_COOKIE, unsign } from "./cookies";
import { getStore, type SessionRecord } from "./store";

export function getCurrentSession(): SessionRecord | null {
  const signed = cookies().get(SESSION_COOKIE)?.value;
  const sid = unsign(signed);
  if (!sid) return null;
  return getStore().getSession(sid);
}

export class AuthError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export function requireOwner(): SessionRecord {
  const session = getCurrentSession();
  if (!session) throw new AuthError(401, "auth_required");
  const store = getStore();
  if (!store.isOwner({ id: session.twitchUserId, login: session.login })) {
    throw new AuthError(403, "not_owner");
  }
  return session;
}
