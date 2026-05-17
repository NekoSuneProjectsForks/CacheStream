import { redirect } from "next/navigation";
import { getCurrentSession } from "@/lib/auth";
import { getStore } from "@/lib/store";
import { tryStatus } from "@/lib/streamer-client";
import { config } from "@/lib/config";
import { getBranding } from "@/lib/branding";
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
  const session = getCurrentSession();
  const store = getStore();
  const owner = store.getOwner();

  if (!session) {
    return <LoginGate owner={owner} loginUrl={`${config.web.publicUrl}/api/auth/twitch/login`} />;
  }

  if (!store.isOwner({ id: session.twitchUserId, login: session.login })) {
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
