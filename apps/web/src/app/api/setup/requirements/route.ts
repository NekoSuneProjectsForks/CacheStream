import { NextResponse } from "next/server";
import { setupRequirements, isSetupComplete } from "@/lib/settings";

export const dynamic = "force-dynamic";

/**
 * GET /api/setup/requirements
 *
 * Public — no auth gate. The wizard polls this to know which step
 * to land on. Returns booleans only; never reveals stored values.
 *
 * Locked off once `isSetupComplete` is true (to discourage probing
 * a configured deployment for which optional values are set).
 */
export async function GET() {
  // Always returns the requirement bools, but adds `setupComplete`
  // so the wizard can redirect itself to /admin if it's loaded
  // after setup has been completed in another tab.
  return NextResponse.json({
    ...setupRequirements(),
    setupComplete: isSetupComplete(),
  });
}
