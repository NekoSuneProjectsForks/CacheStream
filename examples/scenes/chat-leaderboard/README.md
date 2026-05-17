# Example scene · Chat Leaderboard ⭐⭐⭐

Live top-10 chatters scoreboard. Subscribes to `/api/chat/stream`
via Server-Sent Events, counts messages per user, animates the
rankings as they change.

## What it teaches

- **SSE inside a scene** (`new EventSource(...)`).
- Maintaining derived state in the browser without React.
- A simple animated list using CSS transitions on `transform: translateY`.
- Treating chat events vs system events distinctly.

## Install

1. Admin panel → **Scenes** tab → **+ Raw HTML / CSS**.
2. Name it `Chat Leaderboard`, slug `leaderboard`.
3. Paste [`scene.html`](scene.html) and [`scene.css`](scene.css).
4. Save → **Save as preset**.

Open `/scene/custom/leaderboard`. The leaderboard starts empty and
populates as chat fires.

## How it works

The CacheStream chat client publishes every parsed Twitch IRC
message to a public SSE stream at `/api/chat/stream`. Each event
looks like:

```json
{
  "type": "msg",
  "id": "ircmsgid",
  "login": "alice",
  "name": "Alice",
  "color": "#ff7700",
  "badges": "subscriber/12,moderator/1",
  "message": "hello chat",
  "isMod": true,
  "isSub": true
}
```

(There are also `"event"` types for subs / raids and a few
connection-state messages — we ignore those here.)

We keep a `Map<login, { count, name, color }>` in memory, increment
it on every message, and re-render the top 10 sorted by count.
List positions are absolute-positioned and updated via `style.transform =
translateY(...)` so the entries glide between ranks instead of
jumping.

## Customisation

- `TOP_N` — show top 5 vs top 10 vs top 20.
- `RESET_AFTER_MIN` — wipe the board every N minutes for a fresh
  session.
- The `.row` height / colour scheme in `scene.css`.

## Privacy heads-up

The chat stream is technically public, but the scoreboard will
show every chatter's display name on stream. That's the point —
just be aware your viewers' names + colours will be visible.

## Reset across container restarts

The current code keeps state in browser memory only, so a scene
reload (e.g. when the streamer switches scene and comes back)
resets the leaderboard. To persist, write a tiny owner-side API
that stores counts in SQLite — but that's beyond this example.
