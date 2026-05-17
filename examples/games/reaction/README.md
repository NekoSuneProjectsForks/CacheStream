# Example game · Reaction Race ⭐⭐⭐

A first-to-type-wins reaction game, end-to-end. Chatters watch
the scene for a "GO!" trigger, race to type a target word, the
first to do so wins. Wins accumulate in a persistent scoreboard.

This is the **full pattern** for a CacheStream chat game:

```
┌─ schema migration ─┐  ┌─ tick loop / engine ─┐  ┌─ API + SSE ─┐
│   reaction_scores  │  │  - random round timer │  │  state      │
│   (login, wins)    │  │  - chat hook          │  │  stream     │
└────────────────────┘  │  - bus publish        │  │  reset      │
                        └───────────────────────┘  └─────────────┘
                                                          │
                                                          ▼
                                                 ┌─ scene route ─┐
                                                 │ /scene/        │
                                                 │ reaction       │
                                                 │ (SSE consumer) │
                                                 └────────────────┘
```

If you can read this example, you can write a Tamagotchi game,
a Twitch Plays sim, a leaderboard quiz, a viewer poll — anything
that lives on the SQLite + chat-bus + SSE foundation.

## What it teaches

- **Schema migrations** done the CacheStream way (append a function
  to `SCHEMA_VERSIONS`, never edit existing migrations).
- **Engine lifecycle**: tick loop, chat subscription, state mutation,
  pub/sub broadcast.
- **API routes**: public state snapshot, SSE stream, owner-only reset.
- **A live scene** that consumes the game state via `EventSource`.
- The whole **boot wiring** in `instrumentation.ts`.

## Install

Five steps. All paths relative to the repo root.

### 1. Append a schema migration

In [`apps/web/src/lib/db.ts`](../../../apps/web/src/lib/db.ts),
add a new function to the **end** of the `SCHEMA_VERSIONS` array:

```ts
// ---- vN: reaction game ----
(db) => {
  db.exec(`
    CREATE TABLE IF NOT EXISTS reaction_scores (
      login TEXT PRIMARY KEY,
      name  TEXT NOT NULL,
      wins  INTEGER NOT NULL DEFAULT 0,
      last_won_at INTEGER NOT NULL DEFAULT 0
    );
  `);
},
```

The `applySchema()` runner picks it up automatically on next boot.

### 2. Drop in the engine

Copy [`reaction.ts`](./reaction.ts) to
`apps/web/src/lib/games/reaction.ts`.

### 3. Add the API routes

Three small route files, mirroring the pet/datacenter pattern:

| Path | File |
|---|---|
| `apps/web/src/app/api/games/reaction/state/route.ts`  | [state route](./api/state.ts) |
| `apps/web/src/app/api/games/reaction/stream/route.ts` | [stream route](./api/stream.ts) |
| `apps/web/src/app/api/games/reaction/reset/route.ts`  | [reset route](./api/reset.ts) |

(The `.ts` extensions match what you'd rename them to in your tree.)

### 4. Drop in the scene

Copy [`page.tsx`](./scene/page.tsx) to
`apps/web/src/app/scene/reaction/page.tsx`. Serves at
`/scene/reaction`.

### 5. Boot the engine

In
[`apps/web/src/instrumentation.ts`](../../../apps/web/src/instrumentation.ts),
add next to the pet/datacenter imports:

```ts
const { reaction } = await import("./lib/games/reaction");
try { reaction(); } catch (err) { console.warn("[boot] reaction init:", err); }
```

Rebuild + restart:

```bash
docker compose up -d --build web
```

## Playing

1. Open the panel → **Scenes** → save `http://web:7788/scene/reaction`
   as a preset.
2. Activate the preset (or just point the streamer at the URL).
3. Wait 10-30 seconds. The engine picks a random word and posts
   "GO! Type X" in chat.
4. First chatter to type `X` wins. Their score persists across
   restarts.
5. Top 10 shown on the scene, updates in real time via SSE.

## File-by-file walkthrough

### `reaction.ts` — the engine

The full pattern in ~150 lines:

- **Singleton boot**: `reaction()` is idempotent. Mirrors the
  pet/datacenter pattern.
- **Tick loop**: `setInterval` running every 10s decides whether
  to start a new round, end an active round on timeout, etc.
- **Chat subscription**: `subscribe("chat", …)` checks every
  incoming message for the current round's target word.
- **Persistence**: scores live in `reaction_scores` — a tiny
  table keyed by login. Updates use prepared statements.
- **Broadcast**: every state change publishes to `bus` on topic
  `"reaction"` so the SSE route can forward it.

### `api/*.ts` — the routes

- **state**: public GET, no auth. Returns current round + top 10.
  The scene needs this on first paint before the SSE subscription
  catches its first event.
- **stream**: public GET, SSE. Pushes `{ type, state }` envelopes
  on every state change.
- **reset**: owner-only POST. Wipes the scoreboard.

### `scene/page.tsx` — the visual

Subscribes to `/api/games/reaction/stream`. Big "GO!" banner
during an active round, scoreboard during idle. Pure CSS animation,
no canvas, no WebGL — the streamer's headless Chromium renders
it at whatever fps you've configured.

## Customising

| Idea | What to change |
|---|---|
| Different reaction word list | `WORDS` array in `reaction.ts` |
| Faster / slower rounds | `MIN_BETWEEN_ROUNDS_MS` / `ROUND_TIMEOUT_MS` |
| Cooldown between same chatter winning twice | Add `last_won_at` check before crediting a win |
| Show only top N | `LIMIT 10` in the state query |
| Award bits / points instead of just wins | Add an `points` column to `reaction_scores`, award N per win |
| Tie into the EventSub alerts | Boost the next round's prize on a follow/sub |

## Why this example matters

Every CacheStream game lives at this same intersection: chat
events come in, state changes, a scene reflects the state.
The Tamagotchi pet and the Twitch Plays Datacenter sim are both
this pattern with richer state machines. Once you understand the
five steps above, you can build your own without reading the
rest of the codebase.
