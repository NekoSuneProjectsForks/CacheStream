import { redirect } from "next/navigation";
import { getCurrentSession, getCurrentRole } from "@/lib/auth";
import { getStore } from "@/lib/store";
import { tryStatus } from "@/lib/streamer-client";
import { config } from "@/lib/config";
import { getBranding } from "@/lib/branding";
import { bootOnce } from "@/lib/boot";
import { isSetupComplete } from "@/lib/settings";
import { AdminPanel } from "./AdminPanel";
import { LoginGate } from "./LoginGate";
import "./admin.css";

/**
 * Admin control panel — server entry.
 *
 *   1. No session     → show login gate.
 *   2. Session, but not owner → show "claimed by X" notice.
 *   3. Owner session  → render <AdminPanel /> with initial data.
 *
 * Initial data is hydrated server-side so the panel is
 * useful even before the first poll completes.
 */
export const dynamic = "force-dynamic";

export default async function AdminPage() {
  // First request to /admin (or any wrapped /api/* route) triggers
  // one-shot server boot — chat, eventsub, games, scene presets.
  bootOnce();

  // Fresh deploys land on /setup until the operator finishes the
  // first-run wizard. isSetupComplete() also treats a pre-v1.7
  // .env with TWITCH_CLIENT_ID set as "complete" so existing
  // deployments don't get bounced into the wizard.
  if (!isSetupComplete()) redirect("/setup");

  const session = getCurrentSession();
  const store = getStore();
  const owner = store.getOwner();

  if (!session) {
    return <LoginGate owner={owner} loginUrl={`${config.web.publicUrl}/api/auth/twitch/login`} />;
  }

  // v1.13.0: owner OR moderator both get the panel. Anyone else
  // is kicked back to login (the OAuth callback already 403s a
  // non-staff sign-in, but a stale session shouldn't be able to
  // hang around either).
  const role = getCurrentRole();
  if (role === null) {
    redirect("/api/auth/logout");
  }

  const [status, scenes, overlaysPayload, schedule] = await Promise.all([
    tryStatus(),
    Promise.resolve(store.listScenes()),
    Promise.resolve({
      sets: store.listOverlaySets(),
      activeId: store.getActiveOverlaySet()?.id || null,
    }),
    Promise.resolve(store.listSchedule()),
  ]);

  return (
    <AdminPanel
      session={{ login: session.login, displayName: session.displayName }}
      owner={owner}
      role={role as "owner" | "mod"}
      branding={getBranding()}
      initialStatus={status}
      initialScenes={scenes}
      initialOverlaySets={overlaysPayload.sets}
      initialActiveOverlayId={overlaysPayload.activeId}
      initialSchedule={schedule}
      defaultSceneUrl={config.scene.defaultUrl}
    />
  );
}
