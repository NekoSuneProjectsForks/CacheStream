import { redirect } from "next/navigation";
import { isSetupComplete, setupRequirements } from "@/lib/settings";
import { config } from "@/lib/config";
import { SetupWizard } from "./SetupWizard";
import "../admin/admin.css";

/**
 * First-run setup wizard at `/setup`.
 *
 * Lifecycle:
 *   - Fresh container, no kv values → wizard shows from step 1.
 *   - Wizard partially complete → it resumes at the next unsatisfied
 *     step (driven by `setupRequirements()`).
 *   - All required values present → redirect to `/admin`. The wizard
 *     can be reached manually for re-configuration, but users get
 *     bumped to /admin by default.
 *
 * Steps:
 *   1. Welcome / preflight (PUBLIC_URL check)
 *   2. Twitch developer app (client id + secret)
 *   3. Twitch login (handoff to /api/auth/twitch/login)
 *   4. Done → /admin
 */
export const dynamic = "force-dynamic";

export default function SetupPage({
  searchParams,
}: {
  searchParams: { [k: string]: string | undefined };
}) {
  const force = searchParams.force === "1";
  if (isSetupComplete() && !force) {
    redirect("/admin");
  }

  const reqs = setupRequirements();
  return (
    <SetupWizard
      requirements={reqs}
      publicUrl={config.web.publicUrl}
      redirectUri={`${config.web.publicUrl}/api/auth/twitch/callback`}
    />
  );
}
