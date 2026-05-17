/**
 * Twitch IRC chat client (over WebSocket).
 *
 * Lives as a singleton inside the web container. Reads messages,
 * dispatches them to:
 *   - the SSE bus (so /api/chat/stream and the panel see them live)
 *   - the chat_log table (recent history)
 *   - the custom-commands engine (auto-replies + cooldowns)
 *   - the AutoMod engine (deletes / timeouts / bans)
 *
 * Auto-reconnects with exponential backoff. Handles ping/pong so
 * Twitch doesn't disconnect us for being idle.
 *
 * IRC tag parsing is hand-rolled — pulling tmi.js would add ~1MB
 * of deps for a couple hundred lines we can write ourselves.
 */

import WebSocket from "ws";
import { getStore } from "../store";
import { getAccessToken } from "./tokens";
import { publish } from "../bus";
import { runCommandIfMatch } from "../commands";
import { evaluateAutoMod } from "../automod";

const IRC_URL = "wss://irc-ws.chat.twitch.tv";
const MAX_BACKOFF_MS = 30_000;

type State = "idle" | "connecting" | "connected" | "closed";

interface Status {
  state: State;
  channel: string | null;
  connectedAt: number | null;
  lastError: string | null;
}

class ChatClient {
  private ws: WebSocket | null = null;
  private state: State = "idle";
  private channel: string | null = null;
  private connectedAt: number | null = null;
  private lastError: string | null = null;
  private backoff = 1000;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private wantOnline = false;

  status(): Status {
    return { state: this.state, channel: this.channel,
             connectedAt: this.connectedAt, lastError: this.lastError };
  }

  async start(): Promise<void> {
    this.wantOnline = true;
    if (this.state === "connecting" || this.state === "connected") return;
    await this._connect();
  }

  stop(): void {
    this.wantOnline = false;
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
    if (this.ws) {
      try { this.ws.close(); } catch {}
      this.ws = null;
    }
    this.state = "closed";
  }

  /** Tear down and reopen the connection (e.g. after token refresh). */
  async restart(): Promise<void> {
    this.stop();
    this.wantOnline = true;
    await this._connect();
  }

  /** Send a chat message. Throws if not connected. */
  send(text: string): void {
    if (!this.ws || this.state !== "connected" || !this.channel) {
      throw new Error("chat not connected");
    }
    // IRC line length is conventionally <=500 chars; Twitch's limit is 500.
    const truncated = text.length > 480 ? text.slice(0, 480) + "…" : text;
    this.ws.send(`PRIVMSG #${this.channel} :${truncated}\r\n`);
  }

  // ----------------------------------------------------------------

  private async _connect(): Promise<void> {
    const owner = getStore().getOwner();
    if (!owner?.twitchLogin) { this.lastError = "no owner set"; this.state = "idle"; return; }

    let token: string;
    try { token = await getAccessToken(); }
    catch (err: any) { this.lastError = err.message; this._scheduleReconnect(); return; }

    this.channel = owner.twitchLogin.toLowerCase();
    this.state = "connecting";

    const ws = new WebSocket(IRC_URL);
    this.ws = ws;

    ws.on("open", () => {
      // Request IRC v3 capabilities so we get message-ids, badges, etc.
      ws.send("CAP REQ :twitch.tv/tags twitch.tv/commands twitch.tv/membership\r\n");
      ws.send(`PASS oauth:${token}\r\n`);
      ws.send(`NICK ${this.channel}\r\n`);
      ws.send(`JOIN #${this.channel}\r\n`);
    });

    ws.on("message", (raw) => {
      const lines = raw.toString().split("\r\n").filter(Boolean);
      for (const line of lines) this._handleLine(line);
    });

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

  private _handleLine(line: string): void {
    // PING from Twitch → must reply with same payload.
    if (line.startsWith("PING ")) {
      this.ws?.send(line.replace(/^PING/, "PONG") + "\r\n");
      return;
    }

    const parsed = parseIrc(line);
    if (!parsed) return;

    switch (parsed.command) {
      case "001": // RPL_WELCOME → fully logged in
        this.state = "connected";
        this.connectedAt = Date.now();
        this.lastError = null;
        this.backoff = 1000;
        getStore().appendChatLog({
          at: Date.now(), kind: "system",
          userLogin: null, userName: null, color: null, badges: null,
          message: `connected to #${this.channel}`, emotes: null,
        });
        publish("chat", { type: "connected", channel: this.channel });
        return;

      case "PRIVMSG":
        this._handleMessage(parsed);
        return;

      case "USERNOTICE": // subs, raids, etc — chat-visible events
        this._handleUserNotice(parsed);
        return;

      case "CLEARCHAT":
      case "CLEARMSG":
        publish("chat", { type: parsed.command.toLowerCase(), tags: parsed.tags, params: parsed.params });
        return;
    }
  }

  private _handleMessage(parsed: ParsedIrc): void {
    const message = parsed.trailing || "";
    const login   = parsed.prefix?.split("!")[0] || null;
    const tags = parsed.tags || {};
    const userName = tags["display-name"] || login;
    const color    = tags["color"] || null;
    const badges   = tags["badges"] || null;
    const msgId    = tags["id"];

    getStore().appendChatLog({
      at: Date.now(), kind: "msg",
      userLogin: login, userName,
      color, badges, message,
      emotes: tags["emotes"] ? [tags["emotes"]] : null,
    });

    const event = {
      type: "msg",
      id: msgId,
      login, name: userName, color, badges,
      message,
      isMod: /(^|\/)moderator/.test(badges || "") || tags["mod"] === "1",
      isSub: /(^|\/)subscriber/.test(badges || "") || tags["subscriber"] === "1",
    };
    publish("chat", event);

    // Custom commands (cooldown + role-gated, fire-and-forget).
    if (login) {
      Promise.resolve(runCommandIfMatch(event, (text) => this.send(text)))
        .catch((err) => console.warn("[chat] command handler error:", err));
    }

    // AutoMod (delete/timeout/ban, fire-and-forget).
    if (login && msgId) {
      Promise.resolve(evaluateAutoMod(event)).catch((err) =>
        console.warn("[chat] automod error:", err)
      );
    }
  }

  private _handleUserNotice(parsed: ParsedIrc): void {
    const tags = parsed.tags || {};
    const systemMsg = (tags["system-msg"] || "").replace(/\\s/g, " ");
    const message = systemMsg || parsed.trailing || "";

    getStore().appendChatLog({
      at: Date.now(), kind: "event",
      userLogin: tags["login"] || null,
      userName: tags["display-name"] || null,
      color: null, badges: null,
      message, emotes: null,
    });
    publish("chat", { type: "event", msgId: tags["msg-id"], message, tags });
  }

  private _scheduleReconnect(): void {
    if (!this.wantOnline) return;
    const delay = this.backoff;
    this.backoff = Math.min(this.backoff * 2, MAX_BACKOFF_MS);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this._connect().catch((err) => {
        this.lastError = err.message;
        this._scheduleReconnect();
      });
    }, delay);
  }
}

// ---- Tiny IRC parser -------------------------------------------

interface ParsedIrc {
  tags?: Record<string, string>;
  prefix?: string;
  command: string;
  params: string[];
  trailing?: string;
}

function parseIrc(line: string): ParsedIrc | null {
  let pos = 0;
  let tags: Record<string, string> | undefined;
  let prefix: string | undefined;

  if (line[pos] === "@") {
    const sp = line.indexOf(" ", pos);
    tags = {};
    for (const kv of line.slice(1, sp).split(";")) {
      const eq = kv.indexOf("=");
      if (eq < 0) tags[kv] = "";
      else tags[kv.slice(0, eq)] = kv.slice(eq + 1);
    }
    pos = sp + 1;
  }

  if (line[pos] === ":") {
    const sp = line.indexOf(" ", pos);
    prefix = line.slice(pos + 1, sp);
    pos = sp + 1;
  }

  let trailing: string | undefined;
  const colonAt = line.indexOf(" :", pos);
  let paramsStr = "";
  if (colonAt >= 0) {
    paramsStr = line.slice(pos, colonAt);
    trailing = line.slice(colonAt + 2);
  } else {
    paramsStr = line.slice(pos);
  }
  const parts = paramsStr.split(" ").filter(Boolean);
  if (parts.length === 0) return null;
  return { tags, prefix, command: parts[0], params: parts.slice(1), trailing };
}

// ---- Singleton + helpers --------------------------------------

let _client: ChatClient | null = null;
function client(): ChatClient { return _client ||= new ChatClient(); }

export async function startChat(): Promise<void> { await client().start(); }
export function stopChat(): void { client().stop(); }
export function chatStatus() { return client().status(); }
export function sendChat(text: string): void { client().send(text); }

/** Reconnect only if the client is already running (e.g. after refresh). */
export async function reconnectChatIfRunning(): Promise<void> {
  const c = client();
  if (c.status().state === "idle" || c.status().state === "closed") return;
  await c.restart();
}
