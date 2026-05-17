# Examples

Drop-in templates for making your own CacheStream scenes and games.
Each example is **heavily commented** and **self-contained** — copy
the file(s), tweak, deploy.

## What's here

```
examples/
├── scenes/
│   ├── countdown-poster/      ⭐  Full-screen poster + countdown
│   ├── now-playing-card/      ⭐⭐ Music card you can drop on any scene
│   └── chat-leaderboard/      ⭐⭐⭐ Live top chatters scoreboard
└── games/
    ├── 8ball/                 ⭐  Minimal command-response
    └── reaction/              ⭐⭐⭐ Multi-player reaction game
```

---

## How scenes work

A **scene** is just a webpage rendered by headless Chromium at
1920×1080. The streamer captures every frame and pushes it to Twitch.
Anything CSS / HTML / JS / canvas / WebGL can do, a scene can do.

There are two ways to ship a scene:

1. **In-tree scene route** — add a folder under
   `apps/web/src/app/scene/<your-name>/page.tsx`. Bundled with the
   app, served at `/scene/<your-name>`. Rebuild required.
2. **Custom scene via the admin panel** — go to the Scenes tab →
   "+ Raw HTML / CSS" → paste your HTML and CSS in. Served at
   `/scene/custom/<slug>`. No rebuild required; survives container
   restarts. This is what every example in `examples/scenes/` is
   designed for.

### Lifecycle inside Chromium

```
1.  Streamer's puppeteer-core launches headless Chromium.
2.  Chromium loads your scene URL (e.g. http://web:7788/scene/custom/my-scene).
3.  Your <script> runs — fetch() works, EventSource works,
    Web Audio API works, requestAnimationFrame works.
4.  CDP's Page.startScreencast captures every painted frame as JPEG.
5.  Streamer pipes the JPEGs into FFmpeg → libx264/HW → RTMP.
```

So you can `fetch('/api/games/datacenter/state')` from inside a
scene to read live state, `new EventSource('/api/chat/stream')` to
react to chat in real time, or even `new Audio()` to drive a
visualiser (though audio playback from the scene won't be heard —
the broadcast audio comes from the music engine via the FIFO).

### Public scene-side endpoints

These are the endpoints your scene can hit **without** an owner
session cookie:

| Endpoint | What |
|---|---|
| `GET /api/chat/stream` | SSE of every chat message + Twitch events |
| `GET /api/alerts/stream` | SSE of follows / subs / cheers / raids |
| `GET /api/music/now` | Now-playing snapshot (title / artist / cover) |
| `GET /api/music/file/:id` | Raw audio bytes of a track (for Web Audio analysis) |
| `GET /api/music/cover/:id` | Embedded cover art (image) |
| `GET /api/branding` | Display name / tagline / accent / logo URL |
| `GET /api/branding/logo` | Logo image |
| `GET /api/games/pet/state` | AI Pet snapshot |
| `GET /api/games/pet/stream` | SSE pet state updates |
| `GET /api/games/datacenter/state` | Datacenter snapshot |
| `GET /api/games/datacenter/stream` | SSE datacenter updates |

If you need access to other data from a scene, expose a new
`/api/.../public` route in the web container that doesn't go
through `ownerRoute()`.

---

## How games work

A **game** in CacheStream is two things:

1. A **state machine** that lives in the web container as a TypeScript
   module under `apps/web/src/lib/games/<name>.ts`. It owns its own
   ticker (`setInterval`), persistence (SQLite), and chat subscription.
2. A **scene route** that subscribes to the game's SSE stream and
   renders its state visually.

The chat subscription is the only special piece — see
[`apps/web/src/lib/games/pet.ts`](../apps/web/src/lib/games/pet.ts)
for the canonical pattern:

```ts
import { subscribe } from "../bus";

class Pet {
  init() {
    this.busUnsub = subscribe("chat", (msg) => this._onChat(msg));
  }
  _onChat(msg) {
    if (msg?.type !== "msg") return;       // ignore non-message events
    const text = String(msg.message || "").trim().toLowerCase();
    const cmd  = (text.startsWith("!") ? text.slice(1) : text).split(/\s+/)[0];
    if (cmd === "feed") { /* mutate state */ }
  }
}
```

The chat client publishes every parsed IRC message to the in-process
`bus` on the `"chat"` topic. Your game subscribes, filters for the
commands it cares about, mutates state in SQLite, and republishes on
its own topic (e.g. `"reaction"`) so the scene route can pick it up
via SSE.

### To wire a new game into the app

1. **Add the table.** Open
   [`apps/web/src/lib/db.ts`](../apps/web/src/lib/db.ts), append a
   new function to the `SCHEMA_VERSIONS` array that creates your
   table. Don't edit existing migrations.
2. **Add the engine.** Drop a new file in
   [`apps/web/src/lib/games/`](../apps/web/src/lib/games/) following
   the Pet / Datacenter pattern.
3. **Boot it at startup.** In
   [`apps/web/src/instrumentation.ts`](../apps/web/src/instrumentation.ts),
   add `const { yourGame } = await import("./lib/games/yourGame");
   yourGame();` next to the existing imports.
4. **Add API routes.** Mirror the Pet routes under
   `apps/web/src/app/api/games/<your-game>/{state,stream,reset}/route.ts`.
5. **Add the scene route.** Drop a new folder under
   `apps/web/src/app/scene/<your-game>/page.tsx` that subscribes to
   your SSE stream.

The `examples/games/reaction/` example walks all five steps end-to-end.

---

## Difficulty levels

- ⭐ — Just HTML / CSS. Drop in via the Custom Scene editor.
- ⭐⭐ — Adds a `fetch()` poll or SSE subscription.
- ⭐⭐⭐ — Touches the web container's code (new module, new tables).

---

## What to read next

Start with the simplest scene
([`scenes/countdown-poster/`](scenes/countdown-poster/)) to see how a
custom scene is structured, then graduate to
[`scenes/chat-leaderboard/`](scenes/chat-leaderboard/) to see SSE
in action. Once you're comfortable, [`games/reaction/`](games/reaction/)
shows the full end-to-end game pattern.
