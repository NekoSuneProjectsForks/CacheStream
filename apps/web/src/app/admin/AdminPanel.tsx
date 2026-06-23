"use client";

import { useState } from "react";
import type {
  OwnerRecord,
  ScenePreset,
  OverlaySet,
  ScheduleEntry,
} from "@/lib/store";
import type { StreamerStatus } from "@/lib/streamer-client";
import { StatusTab } from "./tabs/StatusTab";
import { StudioTab } from "./tabs/StudioTab";
import { ScenesTab } from "./tabs/ScenesTab";
import { StreamInfoTab } from "./tabs/StreamInfoTab";
import { ChatTab } from "./tabs/ChatTab";
import { CommandsTab } from "./tabs/CommandsTab";
import { AlertsTab } from "./tabs/AlertsTab";
import { MusicTab } from "./tabs/MusicTab";
import { VisualizerTab } from "./tabs/VisualizerTab";
import { VodsTab } from "./tabs/VodsTab";
import { GamesTab } from "./tabs/GamesTab";
import { BrandingTab } from "./tabs/BrandingTab";
import { SourcesTab } from "./tabs/SourcesTab";
import { StaffTab } from "./tabs/StaffTab";

interface SessionInfo { login: string; displayName: string }
interface BrandingSnapshot {
  displayName: string;
  tagline: string | null;
  accent: string | null;
  logoUrl: string | null;
  logoFile: string | null;
}

interface Props {
  session: SessionInfo;
  owner: OwnerRecord | null;
  role: "owner" | "mod";
  branding: BrandingSnapshot;
  initialStatus: StreamerStatus | null;
  initialScenes: ScenePreset[];
  initialOverlaySets: OverlaySet[];
  initialActiveOverlayId: string | null;
  initialSchedule: ScheduleEntry[];
  defaultSceneUrl: string;
}

type TabKey =
  | "status" | "studio" | "scenes" | "sources" | "info" | "chat"
  | "commands" | "alerts" | "music" | "visualizer" | "vods" | "games"
  | "branding" | "staff";

/**
 * `ownerOnly` tabs are hidden from moderators. Mods still get
 * everything they need to drive the panel (scenes, chat, music,
 * commands, etc.); branding + staff invites are owner-only by
 * design (see lib/auth.ts).
 */
const TABS: Array<{ key: TabKey; label: string; ownerOnly?: boolean }> = [
  { key: "status",   label: "Status" },
  { key: "studio",   label: "Studio" },
  { key: "scenes",   label: "Scenes" },
  { key: "sources",  label: "Sources" },
  { key: "info",     label: "Stream Info" },
  { key: "chat",     label: "Chat" },
  { key: "commands", label: "Commands / AutoMod" },
  { key: "alerts",   label: "Alerts" },
  { key: "music",    label: "Music" },
  { key: "visualizer", label: "Visualizer" },
  { key: "vods",     label: "VODs" },
  { key: "games",    label: "Games" },
  { key: "branding", label: "Branding", ownerOnly: true },
  { key: "staff",    label: "Staff",    ownerOnly: true },
];

/**
 * Admin control panel shell. Top-level layout is:
 *
 *   ┌──────────────────────────────┐
 *   │ Header (brand, user, logout) │
 *   ├──────────────────────────────┤
 *   │ Tab nav                      │
 *   ├──────────────────────────────┤
 *   │ Active tab body              │
 *   └──────────────────────────────┘
 *
 * Each tab manages its own state + polling. Initial server-rendered
 * data is passed through to Status so the page renders useful info
 * on first paint without waiting for client fetches.
 */
export function AdminPanel(props: Props) {
  const [tab, setTab] = useState<TabKey>("status");
  const [navOpen, setNavOpen] = useState(false);
  const visibleTabs = TABS.filter((t) => !t.ownerOnly || props.role === "owner");

  return (
    <div className="admin-shell">
      <header className="admin-head">
        <div className="brand-row">
          {props.branding.logoUrl && (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={props.branding.logoUrl} alt="" className="brand-logo" />
          )}
          <div>
            <div className="brand">{props.branding.displayName}</div>
            <div className="brand-sub">control panel</div>
          </div>
        </div>
        <div className="head-right">
          <div className="user">
            <span className="user-label">signed in as</span>
            <strong>{props.session.displayName}</strong>
            <span className={`role-badge role-${props.role}`}>
              {props.role === "owner" ? "OWNER" : "MOD"}
            </span>
            {props.role === "mod" && props.owner && (
              <span className="user-label" style={{ marginLeft: 8 }}>
                for <strong>{props.owner.displayName}</strong>
              </span>
            )}
          </div>
          <form action="/api/auth/logout" method="post">
            <button className="btn-ghost" type="submit">Logout</button>
          </form>
        </div>
        {/* Mobile menu toggle — hidden on desktop via CSS. */}
        <button className="nav-toggle"
                aria-label={navOpen ? "Close navigation" : "Open navigation"}
                aria-expanded={navOpen}
                onClick={() => setNavOpen((v) => !v)}>
          {navOpen ? "✕" : "☰"}
        </button>
      </header>

      <nav className={`tab-nav ${navOpen ? "open" : ""}`} role="tablist" aria-label="Sections">
        {visibleTabs.map((t) => (
          <button
            key={t.key}
            role="tab"
            aria-selected={tab === t.key}
            className={`tab ${tab === t.key ? "active" : ""}`}
            onClick={() => { setTab(t.key); setNavOpen(false); }}
          >
            {t.label}
          </button>
        ))}
      </nav>

      <div className="tab-body">
        {tab === "status" && (
          <StatusTab
            initialStatus={props.initialStatus}
            initialScenes={props.initialScenes}
            initialOverlaySets={props.initialOverlaySets}
            initialActiveOverlayId={props.initialActiveOverlayId}
            initialSchedule={props.initialSchedule}
            defaultSceneUrl={props.defaultSceneUrl}
          />
        )}
        {tab === "studio"   && <StudioTab />}
        {tab === "scenes"   && <ScenesTab />}
        {tab === "sources"  && <SourcesTab />}
        {tab === "info"     && <StreamInfoTab />}
        {tab === "chat"     && <ChatTab />}
        {tab === "commands" && <CommandsTab />}
        {tab === "alerts"   && <AlertsTab />}
        {tab === "music"      && <MusicTab />}
        {tab === "visualizer" && <VisualizerTab />}
        {tab === "vods"       && <VodsTab />}
        {tab === "games"    && <GamesTab />}
        {tab === "branding" && props.role === "owner" && <BrandingTab initial={props.branding} />}
        {tab === "staff"    && props.role === "owner" && <StaffTab />}
      </div>

      <footer className="admin-foot">
        cachestream · owner <strong>{props.owner?.displayName || "—"}</strong>
        {props.owner?.claimedAt && <> · claimed {new Date(props.owner.claimedAt).toLocaleDateString()}</>}
      </footer>
    </div>
  );
}
