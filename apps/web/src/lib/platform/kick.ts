/**
 * Kick chat client — connects to Kick's Pusher-protocol WebSocket, reads
 * chat for the linked channel's chatroom, and republishes each message on
 * the existing "chat" bus topic (tagged platform:"kick"). Also sends chat
 * back via the Kick REST API. Mirrors the StreamBOT approach.
 *
 * Untested end-to-end (needs a linked Kick app + live chat); structure +
 * endpoints match the verified reference in
 * docs/design/multi-platform-accounts.md (Appendix A).
 */

import WebSocket from "ws";
import { getStore } from "../store";
import { publish } from "../bus";
import { refreshKickToken, KICK_API_BASE } from "../oauth/kick";
import type { PlatformChatMessage } from "./types";

const PUSHER_URL =
  process.env.KICK_PUSHER_URL ||
  "wss://ws-us2.pusher.com/app/32cbd69e4b950bf97679?protocol=7&client=js&version=8.4.0&flash=false";

let ws: WebSocket | null = null;
let state: "idle" | "connecting" | "connected" | "closed" = "idle";
let lastError: string | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let stopped = false;

export function kickStatus() {
  return { state, lastError };
}

function chatroomId(): string | null {
  const link = getStore().getPlatformLink("kick");
  const id = link?.extra?.chatroomId;
  return id ? String(id) : null;
}

/** Start (idempotent) if a Kick channel is linked. */
export function startKickClient(): void {
  const id = chatroomId();
  if (!id) return;
  stopped = false;
  if (ws && (state === "connecting" || state === "connected")) return;
  connect(id);
}

export function stopKickClient(): void {
  stopped = true;
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
  try { ws?.close(); } catch {}
  ws = null;
  state = "closed";
}

function connect(id: string): void {
  try { ws?.close(); } catch {}
  state = "connecting";
  const sock = new WebSocket(PUSHER_URL);
  ws = sock;

  sock.on("open", () => {
    sock.send(JSON.stringify({
      event: "pusher:subscribe",
      data: { channel: `chatrooms.${id}.v2`, auth: "" },
    }));
  });
  sock.on("message", (buf) => handleMessage(buf.toString(), id));
  sock.on("error", (e: any) => { lastError = e?.message || String(e); });
  sock.on("close", () => {
    state = "closed";
    if (!stopped) scheduleReconnect(id);
  });
}

function scheduleReconnect(id: string): void {
  if (reconnectTimer) clearTimeout(reconnectTimer);
  reconnectTimer = setTimeout(() => connect(id), 5000);
}

function handleMessage(raw: string, id: string): void {
  let env: any;
  try { env = JSON.parse(raw); } catch { return; }
  const event: string = env.event || "";

  if (event === "pusher:connection_established" ||
      event === "pusher_internal:subscription_succeeded") {
    state = "connected";
    return;
  }
  if (event === "pusher:ping") {
    try { ws?.send(JSON.stringify({ event: "pusher:pong", data: {} })); } catch {}
    return;
  }
  if (event === "App\\Events\\ChatMessageEvent" || event === "chat.message.sent") {
    let data: any = env.data;
    if (typeof data === "string") { try { data = JSON.parse(data); } catch {} }
    const msg = parseKickChat(data, id);
    if (msg) publish("chat", msg);
  }
}

function parseKickChat(data: any, channelId: string): PlatformChatMessage | null {
  if (!data) return null;
  const content = data.content ?? data.message?.content ?? "";
  if (!content) return null;

  const sender = data.sender ?? data.user ?? data.author ?? data.message?.sender ?? {};
  const name = sender.username ?? sender.slug ?? sender.name ?? null;
  const badgesArr: any[] = Array.isArray(sender.identity?.badges)
    ? sender.identity.badges
    : (Array.isArray(sender.badges) ? sender.badges : []);
  const badgeTypes = badgesArr.map((b) => String(b?.type ?? b ?? "").toLowerCase());

  return {
    type: "msg",
    platform: "kick",
    channelId,
    id: data.id != null ? String(data.id) : null,
    login: name ? String(name).toLowerCase() : null,
    name: sender.display_name ?? name ?? null,
    color: sender.identity?.color ?? null,
    badges: badgeTypes.length ? badgeTypes.map((t) => `${t}/1`).join(",") : null,
    message: String(content),
    isMod: badgeTypes.includes("moderator"),
    isSub: badgeTypes.some((t) => t === "subscriber" || t === "sub"),
    at: Date.now(),
  };
}

/** Send a chat message to the linked Kick channel. */
export async function sendKickChat(text: string): Promise<void> {
  const body = text.trim();
  if (!body) return;
  const store = getStore();
  const broadcasterId = store.getPlatformLink("kick")?.platformUserId;
  const token = await kickAccessToken();

  const attempt = (payload: unknown) =>
    fetch(`${KICK_API_BASE}/chat`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      cache: "no-store",
    });

  let res = await attempt({ content: body.slice(0, 480), type: "bot" });
  if (!res.ok && broadcasterId) {
    res = await attempt({
      content: body.slice(0, 480),
      type: "message",
      broadcaster_user_id: Number(broadcasterId),
    });
  }
  if (!res.ok) lastError = `kick send ${res.status}`;
}

/** Valid access token, refreshing if near expiry. */
async function kickAccessToken(): Promise<string> {
  const store = getStore();
  const t = store.getPlatformTokens("kick");
  if (!t) throw new Error("kick not linked");
  if (t.expiresAt > Date.now() + 5000) return t.accessToken;
  if (t.refreshToken) {
    try {
      const r = await refreshKickToken(t.refreshToken);
      store.savePlatformTokens({
        platform: "kick",
        accessToken: r.access_token,
        refreshToken: r.refresh_token ?? t.refreshToken,
        expiresAt: Date.now() + (r.expires_in - 60) * 1000,
        scopes: (r.scope || "").split(" ").filter(Boolean),
        platformUserId: t.platformUserId,
        updatedAt: Date.now(),
      });
      return r.access_token;
    } catch (e: any) {
      lastError = `kick refresh failed: ${e?.message || e}`;
    }
  }
  return t.accessToken;
}
