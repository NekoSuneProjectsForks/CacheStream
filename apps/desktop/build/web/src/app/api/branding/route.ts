import { NextResponse } from "next/server";
import { ownerRoute, readJson } from "@/lib/api-helpers";
import { getBranding, setBranding } from "@/lib/branding";

export const dynamic = "force-dynamic";

/**
 * GET /api/branding — public (the scenes need it).
 * No secrets here — display name, tagline, accent, logo URL.
 */
export async function GET() {
  return NextResponse.json(getBranding());
}

/** PATCH /api/branding — owner-only. */
export const PATCH = ownerRoute(async (req) => {
  const body = await readJson<{
    displayName?: string;
    tagline?: string | null;
    accent?: string | null;
  }>(req);
  return NextResponse.json(setBranding(body));
});
