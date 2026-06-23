# Design: Multi-Platform Accounts (Twitch + Kick + YouTube + VPzone)

Status: **Draft for approval** · Owner: NekoSuneVR · Target: post-1.18

## 1. Goal

Today CacheStream is **single-provider, single-broadcaster**: the first person to
log in via Twitch OAuth becomes the one Owner, their tokens drive every Helix /
EventSub call, and chat + alerts only exist for Twitch. We want:

- **One Owner account** established on fresh install (not necessarily tied to a
  Twitch identity).
- The Owner can **link multiple platforms** — Twitch, Kick, YouTube, VPzone (and
  more later) — each with its own OAuth tokens.
- **Chat and alerts work per-platform**, merged into the existing overlay bus so
  scenes show a unified chat/alert feed tagged by platform.
- Outbound chat send can target any linked platform.

This is the account/identity + ingestion half. The **output** half (sending the
video to multiple platforms at once) is a separate doc: `multistream.md`.

## 2. Current state (verified)

- Auth is Twitch-only: `apps/web/src/app/api/auth/twitch/login|callback/route.ts`,
  `lib/oauth.ts`, `lib/auth.ts`, `lib/cookies.ts`.
- Owner is a singleton row `owner` (id=1), claimed first-login-wins
  (`store.claimOwnerIfUnset`, `lib/store.ts:283`). `isOwner()` matches by Twitch
  id or login.
- Broadcaster tokens live in singleton `oauth_tokens` (id=1) — **one provider, one
  account** (`lib/db.ts:107`, `store.saveTokens/getTokens`).
- Sessions: `sessions` table, cookie `cs_session` (14d, HMAC-signed).
- Moderators/invites: `moderators`, `staff_invites` tables (Twitch identities).
- Chat/alerts ingestion is EventSub WebSocket → `publish("chat"|"alerts", …)` on
  the in-process bus (`lib/bus.ts`), consumed by SSE routes
  (`/api/chat/stream`, `/api/alerts/stream`) and overlays. Twitch-specific code:
  `lib/twitch/eventsub.ts`, `lib/twitch/chat.ts`.
- Outbound send: `sendChat()` → Helix `POST /chat/messages` (`lib/twitch/chat.ts`).
- Boot wiring: `lib/boot.ts` `startServicesIfReady()` → `startChat()` +
  `startEventSub()`.

Good news: **commands + automod already consume a platform-neutral
`ChatMsgEvent` shape** and the bus topics (`chat`, `alerts`) are already a clean
abstraction seam. Most consumer code needs no change beyond a `platform` tag.

## 3. Target architecture

### 3.1 Identity model

Decouple "Owner account" from "platform identity".

New tables:

```sql
-- The local owner account (replaces relying on a Twitch identity for owner).
CREATE TABLE account (
  id            INTEGER PRIMARY KEY CHECK (id = 1),  -- singleton owner
  username      TEXT NOT NULL,        -- local display name chosen at setup
  pass_hash     TEXT,                 -- optional: local password (scrypt) for
                                      -- panel login when no platform is linked
  created_at    INTEGER NOT NULL
);

-- One row per linked platform identity.
CREATE TABLE platform_links (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  platform        TEXT NOT NULL,        -- 'twitch' | 'kick' | 'youtube' | 'vpzone'
  platform_user_id TEXT NOT NULL,       -- provider's user id
  login           TEXT,                 -- provider login/handle
  display_name    TEXT,
  avatar_url      TEXT,
  scopes_json     TEXT NOT NULL DEFAULT '[]',
  linked_at       INTEGER NOT NULL,
  UNIQUE(platform, platform_user_id)
);

-- Tokens per linked platform (replaces the singleton oauth_tokens for new code;
-- keep oauth_tokens working via a migration shim — see §6).
CREATE TABLE platform_tokens (
  platform      TEXT PRIMARY KEY,       -- one active token set per platform
  access_token  TEXT NOT NULL,
  refresh_token TEXT,
  expires_at    INTEGER NOT NULL,
  scopes_json   TEXT NOT NULL,
  platform_user_id TEXT NOT NULL,
  updated_at    INTEGER NOT NULL
);
```

Ownership becomes: "the session belongs to the single `account` row". Platform
links are *capabilities* the owner attaches, not the owner's identity. Moderators
remain Twitch-keyed for now (out of scope to generalize in phase 1).

### 3.2 Provider abstraction

Create `apps/web/src/lib/platform/` with a small interface every provider
implements:

```ts
export type Platform = "twitch" | "kick" | "youtube" | "vpzone";

export interface PlatformChatMessage {
  platform: Platform;
  channelId: string;
  id: string;
  login: string | null;
  name: string | null;
  color?: string | null;
  badges?: string | null;     // keep Twitch "set/ver,set/ver" string format
  message: string;
  isMod: boolean;
  isSub: boolean;
  isOwner: boolean;
  at: number;
}

export interface PlatformAlert {
  platform: Platform;
  channelId: string;
  type: "follow" | "sub" | "gift" | "resub" | "cheer" | "raid" | "host" | "other";
  userName: string;
  raw: Record<string, unknown>;  // provider payload for advanced overlays
  at: number;
}

export interface PlatformClient {
  readonly platform: Platform;
  start(): Promise<void>;
  stop(): void;
  send(text: string): Promise<void>;
  status(): { state: "idle" | "connecting" | "connected" | "closed"; lastError: string | null };
}
```

- `lib/platform/twitch.ts` — wraps the existing `eventsub.ts` + `chat.ts`,
  emitting the normalized shapes (badges/colors already match).
- `lib/platform/kick.ts` — Kick OAuth2 + Pusher-style WebSocket (see §4).
- `lib/platform/youtube.ts` — YouTube Live Chat API polling (see §5).
- `lib/platform/vpzone.ts` — stub until their API is confirmed.
- `lib/platform/manager.ts` — instantiates clients for every linked platform with
  valid tokens, starts/stops them, and fans `send()` out.

**Bus contract stays the same** — clients publish to existing `chat` / `alerts`
topics, now with `platform` + `channelId` fields. SSE routes and overlays already
forward arbitrary payloads, so the only consumer change is **rendering a small
platform badge** (Twitch/Kick/YT glyph) in `ChatOverlay.tsx` / `AlertsTicker.tsx`.

### 3.3 Boot + lifecycle

`lib/boot.ts` `startServicesIfReady()` → `platformManager().startAll()` instead of
hardcoded Twitch calls. Each client is idempotent (no-op if already
connecting/connected), mirroring today's behavior. Token refresh moves behind a
per-platform `getAccessToken(platform)` helper modeled on
`lib/twitch/tokens.ts` (coalesced in-flight refresh, dead-token flag).

## 4. Kick integration

Kick exposes OAuth2 (Authorization Code + PKCE) and a public chat WebSocket.

- **OAuth**: new routes `app/api/auth/kick/login|callback/route.ts`, mirroring the
  Twitch pair. Store CSRF state in a signed `cs_oauth_state` cookie (reuse
  `lib/cookies.ts`), PKCE verifier in a second signed cookie. On callback,
  exchange code → write `platform_tokens('kick', …)` + `platform_links`.
- **Chat in**: Kick chatrooms broadcast over a Pusher-protocol WebSocket
  (`wss://ws-us2.pusher.com/...`), subscribing to channel `chatrooms.<id>.v2`.
  Parse `App\\Events\\ChatMessageEvent` → `PlatformChatMessage`. Reconnect with
  backoff, same lifecycle states as EventSub.
- **Chat out / mod actions**: Kick public API endpoints for sending messages and
  moderation, authorized with the stored token.
- **Alerts**: Kick follows/subs/gifts arrive as additional Pusher events on the
  channel; map to `PlatformAlert`.

Risk: Kick's official API surface is still maturing — isolate all Kick specifics
behind `lib/platform/kick.ts` so churn doesn't leak.

## 5. YouTube integration

- **OAuth**: Google OAuth2, routes `app/api/auth/youtube/login|callback`. Scope
  `youtube.readonly` + `youtube.force-ssl` (send messages).
- **Chat in**: `liveChatMessages.list` polling against the active broadcast's
  `liveChatId` (resolved via `liveBroadcasts.list`). Poll interval honors the
  `pollingIntervalMillis` the API returns.
- **Quota**: YouTube Data API has a daily quota (default 10k units;
  `liveChatMessages.list` ≈ 5 units/call). At the returned cadence this is the
  main constraint. Phase YouTube **last** and gate it behind a clear "uses your
  Google quota" notice. Plan to apply for a quota increase before GA (tracked
  separately).
- **Alerts**: Superchats/new-members surface through the same `liveChatMessages`
  feed (`snippet.type`), mapped to `PlatformAlert`.

## 6. Migration & back-compat

- Keep the Twitch singleton `oauth_tokens` (id=1) working: on boot, if
  `platform_tokens('twitch')` is empty but `oauth_tokens` has a row, copy it over
  (one-time shim). New code reads `platform_tokens`; `lib/twitch/tokens.ts`
  becomes a thin adapter over `getAccessToken('twitch')`.
- Existing owner row: create the `account` row from it on first boot (username =
  owner display name; no password until the owner sets one).
- Setup wizard (`app/setup/SetupWizard.tsx`) gains a first step: "Create your
  owner account" (username, optional password), then "Link a platform" with
  buttons per provider. Twitch link reuses today's flow.

## 7. Staged rollout

1. **Schema + account model** — new tables, migration shim, `account` creation,
   panel login still via Twitch. No behavior change yet.
2. **Provider abstraction** — extract `lib/platform/twitch.ts` from
   `eventsub.ts`/`chat.ts`; route bus publishes through normalized shapes; add
   `platform` badge rendering in overlays. Twitch still the only provider.
3. **Linking UI** — Settings → "Connections" tab listing linked platforms with
   link/unlink buttons; `platform_links` CRUD.
4. **Kick** — OAuth + WebSocket chat + alerts + send.
5. **YouTube** — OAuth + polling chat + alerts (quota-gated).
6. **VPzone** — once their API is documented.

Each stage ships independently and leaves the app working.

## 8. Open questions

- VPzone API capabilities (OAuth? chat transport?) — needs docs/contact.
- Do moderators need to be generalized beyond Twitch in phase 1? (Proposed: no.)
- Per-platform "primary chat" for outbound send default vs. explicit target
  picker in the panel.
