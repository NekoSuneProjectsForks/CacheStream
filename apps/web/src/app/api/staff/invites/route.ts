import { NextResponse } from "next/server";
import { ownerRoute, readJson } from "@/lib/api-helpers";
import { requireOwner } from "@/lib/auth";
import { getStore } from "@/lib/store";

export const dynamic = "force-dynamic";

/**
 * Owner-only invite management.
 *
 *   GET  /api/staff/invites           — list all invites
 *   POST /api/staff/invites { label?, expiresInHours? }
 *                                     — mint a new invite
 *
 * The invitee accepts an invite by visiting
 *   /login/invite?code=<code>
 * which sets a signed cookie and bounces them through
 * Twitch OAuth. The callback consumes the code + adds them
 * to `moderators` atomically.
 */
export const GET = ownerRoute(async () => {
  return NextResponse.json(getStore().listInvites());
});

export const POST = ownerRoute(async (req) => {
  const body = await readJson<{ label?: string; expiresInHours?: number }>(req);
  const owner = requireOwner();
  const expiresAt = typeof body.expiresInHours === "number" && body.expiresInHours > 0
    ? Date.now() + Math.round(body.expiresInHours) * 3600 * 1000
    : null;
  const inv = getStore().createInvite({
    label: body.label?.toString().slice(0, 80) || null,
    createdByLogin: owner.login,
    expiresAt,
  });
  return NextResponse.json(inv);
});
