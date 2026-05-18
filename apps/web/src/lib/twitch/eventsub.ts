/**
 * Twitch EventSub WebSocket client.
 *
 * Subscribes to the broadcaster's alert events:
 *   - channel.follow
 *   - channel.subscribe
 *   - channel.subscription.gift
 *   - channel.subscription.message (resubs)
 *   - channel.cheer (bits)
 *   - channel.raid
 *
 * On connect, Twitch sends a `session_welcome` with a session_id;
 * we then POST one subscription per event type to /helix/eventsub/subscriptions
 * with transport `{ method: "websocket", session_id }`.
 *
 * Auto-handles `session_reconnect` notifications (Twitch may
 * migrate us to a new edge) and reconnects on close.
 */

import WebSocket from "ws";
import { config } from "../config";
import { getStore } from "../store";
import { getAccessToken, isRefreshTokenDead } from "./tokens";
import { publish } from "../bus";

const EVENTSUB_URL = "wss://eventsub.wss.twitch.tv/ws";
const SUB_URL = "https://api.twitch.tv/helix/eventsub/subscriptions";

const SUBSCRIPTIONS: Array<{ type: string; version: string; conditionFor: (id: string) => Record<string, string> }> = [
  { type: "channel.follow",              version: "2", conditionFor: (id) => ({ broadcaster_user_id: id, moderator_user_id: id }) },
  { type: "channel.subscribe",           version: "1", conditionFor: (id) => ({ broadcaster_user_id: id }) },
  { type: "channel.subscription.gift",   version: "1", conditionFor: (id) => ({ broadcaster_user_id: id }) },
  { type: "channel.subscription.message",version: "1", conditionFor: (id) => ({ broadcaster_user_id: id }) },
  { type: "channel.cheer",               version: "1", conditionFor: (id) => ({ broadcaster_user_id: id }) },
  { type: "channel.raid",                version: "1", conditionFor: (id) => ({ to_broadcaster_user_id: id }) },
];

type State = "idle" | "connecting" | "connected" | "closed";

class EventSubClient {
  private ws: WebSocket | null = null;
  private state: State = "idle";
  private sessionId: string | null = null;
  private lastError: string | null = null;
  private wantOnline = false;
  private backoff = 1000;
  private reconnectTimer: NodeJS.Timeout | null = null;

  status() {
    return {
      state: this.state, sessionId: this.sessionId,
      lastError: this.lastError,
    };
  }

  async start(reconnectUrl?: string): Promise<void> {
    // If the stored refresh token is already known-dead, don't even
    // open a websocket — we'd just session_welcome → subscribe →
    // 400 in a loop. The operator needs to re-login first.
    if (isRefreshTokenDead()) {
      this.lastError = "refresh token rejected by Twitch — re-login required";
      this.state = "closed";
      return;
    }
    this.wantOnline = true;
    if (this.state === "connecting" || this.state === "connected") return;
    this._connect(reconnectUrl);
  }

  stop(): void {
    this.wantOnline = false;
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
    if (this.ws) { try { this.ws.close(); } catch {} this.ws = null; }
    this.state = "closed";
  }

  async restart(): Promise<void> { this.stop(); this.wantOnline = true; this._connect(); }

  // ----------------------------------------------------------------

  private _connect(reconnectUrl?: string): void {
    this.state = "connecting";
    const ws = new WebSocket(reconnectUrl || EVENTSUB_URL);
    this.ws = ws;

    ws.on("message", (raw) => this._handle(raw.toString()).catch((err) => {
      console.warn("[eventsub] handler error:", err);
    }));

    ws.on("close", () => {
      this.state = "closed";
      this.ws = null;
      if (this.wantOnline) this._scheduleReconnect();
    });

    ws.on("error", (err) => {
      this.lastError = (err as Error).message;
      try { ws.close(); } catch {}
    });
  }

  private async _handle(raw: string): Promise<void> {
    const env = JSON.parse(raw);
    const type = env.metadata?.message_type;

    if (type === "session_welcome") {
      this.sessionId = env.payload.session.id;
      this.state = "connected";
      this.lastError = null;
      this.backoff = 1000;
      await this._subscribeAll();
      return;
    }

    if (type === "session_reconnect") {
      const next = env.payload.session.reconnect_url;
      // Twitch wants us to open the new URL BEFORE closing the old.
      const oldWs = this.ws;
      this.ws = null;
      this._connect(next);
      try { oldWs?.close(); } catch {}
      return;
    }

    if (type === "session_keepalive") {
      // Nothing to do; presence keeps the connection alive.
      return;
    }

    if (type === "notification") {
      const subType = env.metadata.subscription_type;
      const event = env.payload.event;
      getStore().appendChatLog({
        at: Date.now(), kind: "event",
        userLogin: event.user_login || event.from_broadcaster_user_login || null,
        userName:  event.user_name  || event.from_broadcaster_user_name  || null,
        color: null, badges: null,
        message: humanizeEvent(subType, event),
        emotes: null,
      });
      publish("alerts", { type: subType, event });
      return;
    }

    if (type === "revocation") {
      console.warn("[eventsub] subscription revoked:", env.payload.subscription);
    }
  }

  private async _subscribeAll(): Promise<void> {
    const tokens = getStore().getTokens();
    if (!tokens || !this.sessionId) return;
    let token: string;
    try {
      token = await getAccessToken();
    } catch (err: any) {
      // Refresh failed (commonly: refresh token revoked, expired
      // beyond grace, or client secret rotated). Stop trying —
      // every retry will hit the same wall and spam the log.
      this.lastError = err?.message || String(err);
      this.wantOnline = false;
      if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
      try { this.ws?.close(); } catch {}
      this.ws = null;
      this.state = "closed";
      console.warn("[eventsub] giving up:", this.lastError);
      return;
    }
    const broadcasterId = tokens.twitchUserId;

    for (const sub of SUBSCRIPTIONS) {
      try {
        const body = {
          type: sub.type,
          version: sub.version,
          condition: sub.conditionFor(broadcasterId),
          transport: { method: "websocket", session_id: this.sessionId },
        };
        const res = await fetch(SUB_URL, {
          method: "POST",
          headers: {
            "Client-Id": config.oauth.clientId,
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(body),
        });
        if (!res.ok && res.status !== 409 /* already subscribed */) {
          const text = await res.text().catch(() => "");
          console.warn(`[eventsub] subscribe ${sub.type} failed:`, res.status, text);
        }
      } catch (err) {
        console.warn(`[eventsub] subscribe ${sub.type} threw:`, err);
      }
    }
  }

  private _scheduleReconnect(): void {
    if (!this.wantOnline) return;
    const delay = this.backoff;
    this.backoff = Math.min(this.backoff * 2, 30_000);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this._connect();
    }, delay);
  }
}

function humanizeEvent(type: string, e: any): string {
  switch (type) {
    case "channel.follow":              return `${e.user_name} followed`;
    case "channel.subscribe":           return `${e.user_name} subscribed (tier ${e.tier})${e.is_gift ? " (gift)" : ""}`;
    case "channel.subscription.gift":   return `${e.user_name} gifted ${e.total} subs`;
    case "channel.subscription.message":return `${e.user_name} resubbed (${e.cumulative_months} months): ${e.message?.text || ""}`;
    case "channel.cheer":               return `${e.user_name || "Anonymous"} cheered ${e.bits} bits${e.message ? ": " + e.message : ""}`;
    case "channel.raid":                return `${e.from_broadcaster_user_name} raided with ${e.viewers}`;
    default:                            return type;
  }
}

let _client: EventSubClient | null = null;
function client(): EventSubClient { return _client ||= new EventSubClient(); }

export async function startEventSub(): Promise<void> { await client().start(); }
export function stopEventSub(): void { client().stop(); }
export function eventSubStatus() { return client().status(); }

export async function reconnectEventSubIfRunning(): Promise<void> {
  const c = client();
  if (c.status().state === "idle" || c.status().state === "closed") return;
  await c.restart();
}
