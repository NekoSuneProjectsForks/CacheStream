/**
 * Tiny route-handler helpers.
 *
 *   ownerRoute(handler)  — wraps a handler with requireOwner() + error→JSON.
 *   staffRoute(handler)  — wraps a handler with requireStaff()  + error→JSON
 *                          (owner OR moderator — v1.13.0+).
 *   readJson(req)        — parse JSON body with a 64KB cap.
 */

import { NextRequest, NextResponse } from "next/server";
import { AuthError, requireOwner, requireStaff } from "./auth";
import { bootOnce } from "./boot";

/**
 * Wraps a route handler so it can only be reached by the
 * broadcaster (the deployment's owner).
 *
 * Use for actions that meaningfully alter the broadcaster's
 * identity / billing surface: stream-key rotation, claiming
 * ownership, managing moderators / invites, branding changes,
 * deleting the broadcaster's data.
 */
export function ownerRoute<T extends (req: NextRequest, ctx: any) => Promise<NextResponse>>(
  handler: T
): T {
  const wrapped = (async (req: NextRequest, ctx: any) => {
    try {
      // Lazy server boot — see lib/boot.ts. First API call triggers
      // chat, eventsub, games, scene-preset seed. No-op on subsequent
      // calls.
      bootOnce();
      requireOwner();
      return await handler(req, ctx);
    } catch (err: any) {
      if (err instanceof AuthError) {
        return NextResponse.json({ error: err.message }, { status: err.status });
      }
      const status = typeof err.status === "number" ? err.status : 500;
      return NextResponse.json(
        { error: err.message || "internal_error" },
        { status }
      );
    }
  }) as T;
  return wrapped;
}

/**
 * Wraps a route handler so it can be reached by EITHER the
 * owner or a moderator (anyone the owner invited via a staff
 * invite code in v1.13.0+).
 *
 * Use for the everyday panel actions a mod is expected to be
 * able to drive: scene switching, sending chat, queueing music,
 * triggering ad breaks, running commands.
 *
 * The role is stashed on `(req as any).cs.role` for handlers
 * that want to gate sub-features by role (e.g. show different
 * UI / refuse a destructive sub-operation when role === "mod").
 */
export function staffRoute<T extends (req: NextRequest, ctx: any) => Promise<NextResponse>>(
  handler: T
): T {
  const wrapped = (async (req: NextRequest, ctx: any) => {
    try {
      bootOnce();
      const session = requireStaff();
      (req as any).cs = { role: session.role, login: session.login, userId: session.twitchUserId };
      return await handler(req, ctx);
    } catch (err: any) {
      if (err instanceof AuthError) {
        return NextResponse.json({ error: err.message }, { status: err.status });
      }
      const status = typeof err.status === "number" ? err.status : 500;
      return NextResponse.json(
        { error: err.message || "internal_error" },
        { status }
      );
    }
  }) as T;
  return wrapped;
}

export async function readJson<T = any>(req: NextRequest): Promise<T> {
  const text = await req.text();
  if (text.length > 64 * 1024) throw Object.assign(new Error("payload too large"), { status: 413 });
  if (!text) return {} as T;
  try { return JSON.parse(text) as T; }
  catch { throw Object.assign(new Error("invalid json"), { status: 400 }); }
}
