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
import { runCommandIfMatch } from "../commands";
import { evaluateAutoMod } from "../automod";
import { sendChat } from "./chat";

const EVENTSUB_URL = "wss://eventsub.wss.twitch.tv/ws";
const SUB_URL = "https://api.twitch.tv/helix/eventsub/subscriptions";

const SUBSCRIPTIONS: Array<{ type: string; version: string; conditionFor: (id: string) => Record<string, string> }> = [
  { type: "channel.follow",              version: "2", conditionFor: (id) => ({ broadcaster_user_id: id, moderator_user_id: id }) },
  { type: "channel.subscribe",           version: "1", conditionFor: (id) => ({ broadcaster_user_id: id }) },
  { type: "channel.subscription.gift",   version: "1", conditionFor: (id) => ({ broadcaster_user_id: id }) },
  { type: "channel.subscription.message",version: "1", conditionFor: (id) => ({ broadcaster_user_id: id }) },
  { type: "channel.cheer",               version: "1", conditionFor: (id) => ({ broadcaster_user_id: id }) },
  { type: "channel.raid",                version: "1", conditionFor: (id) => ({ to_broadcaster_user_id: id }) },
  // v1.8.0 chat-on-EventSub. Replaces the old IRC-over-WebSocket
  // client. user_id is the chatter we're authenticating as — in
  // CacheStream that's always the broadcaster themselves (own-bot).
  { type: "channel.chat.message",        version: "1", conditionFor: (id) => ({ broadcaster_user_id: id, user_id: id }) },
  { type: "channel.chat.notification",   version: "1", conditionFor: (id) => ({ broadcaster_user_id: id, user_id: id }) },
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
    // Flip state synchronously before _connect so concurrent
    // start() calls bail. Same race-class fix as chat.ts.
    this.state = "connecting";
    console.log("[eventsub] start() — opening websocket to", reconnectUrl || EVENTSUB_URL);
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

      // Chat messages go to a different bus topic + DB shape than
      // alert events. They drive in-stream games (pet, datacenter),
      // custom commands, and AutoMod — none of which need to know
      // that the transport is EventSub vs the legacy IRC client.
      if (subType === "channel.chat.message") {
        this._handleChatMessage(event);
        return;
      }
      if (subType === "channel.chat.notification") {
        this._handleChatNotification(event);
        return;
      }

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

  /**
   * channel.chat.message — replaces the old IRC PRIVMSG handler.
   * Fan-out: chat log + bus (so the panel + games hear it) +
   * custom-commands engine + AutoMod.
   */
  private _handleChatMessage(e: any): void {
    const login    = e.chatter_user_login || null;
    const userName = e.chatter_user_name  || login;
    const text     = e.message?.text || "";
    const msgId    = e.message_id || null;
    const color    = e.color || null;
    // Helix badges arrive as [{ set_id, id, info }]. Flatten to the
    // IRC-style "moderator/1,subscriber/3" string the rest of the
    // UI already knows how to render, and so the mod/sub detectors
    // below still work whether we re-emitted from old or new chat.
    const badges = Array.isArray(e.badges)
      ? e.badges.map((b: any) => `${b.set_id}/${b.id || "1"}`).join(",")
      : null;

    getStore().appendChatLog({
      at: Date.now(), kind: "msg",
      userLogin: login, userName,
      color, badges, message: text,
      emotes: null,
    });

    const isMod = /(^|,)moderator\//.test(badges || "") || e.message_type === "channel_points_highlighted";
    const isSub = /(^|,)subscriber\//.test(badges || "") || /(^|,)founder\//.test(badges || "");

    const event = {
      type: "msg",
      id: msgId,
      login, name: userName, color, badges,
      message: text,
      isMod, isSub,
    };
    publish("chat", event);

    if (login) {
      Promise.resolve(runCommandIfMatch(event, (reply) => sendChat(reply)))
        .catch((err) => console.warn("[eventsub] command handler error:", err));
    }
    if (login && msgId) {
      Promise.resolve(evaluateAutoMod(event))
        .catch((err) => console.warn("[eventsub] automod error:", err));
    }
  }

  /**
   * channel.chat.notification — covers subs, raids-in-chat, host
   * announcements, bits-via-chat, etc. Old IRC USERNOTICE
   * equivalent. We forward to the chat log + bus so the panel's
   * chat tab still shows these inline.
   */
  private _handleChatNotification(e: any): void {
    const text = e.message?.text || e.system_message || e.notice_type || "";
    getStore().appendChatLog({
      at: Date.now(), kind: "event",
      userLogin: e.chatter_user_login || null,
      userName:  e.chatter_user_name  || null,
      color: null, badges: null,
      message: text, emotes: null,
    });
    publish("chat", { type: "event", noticeType: e.notice_type, message: text });
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
