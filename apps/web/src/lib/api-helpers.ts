/**
 * Tiny route-handler helpers.
 *
 *   ownerRoute(handler)  — wraps a handler with requireOwner() + error→JSON.
 *   readJson(req)        — parse JSON body with a 64KB cap.
 */

import { NextRequest, NextResponse } from "next/server";
import { AuthError, requireOwner } from "./auth";
import { bootOnce } from "./boot";

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

export async function readJson<T = any>(req: NextRequest): Promise<T> {
  const text = await req.text();
  if (text.length > 64 * 1024) throw Object.assign(new Error("payload too large"), { status: 413 });
  if (!text) return {} as T;
  try { return JSON.parse(text) as T; }
  catch { throw Object.assign(new Error("invalid json"), { status: 400 }); }
}
