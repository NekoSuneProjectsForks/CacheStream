# Example game · !8ball ⭐

The smallest possible chat-driven "game" in CacheStream: a
classic Magic 8-Ball that replies with a random answer whenever
anyone types `!8ball <question>` in chat.

## What it teaches

- Subscribing to the chat bus from a backend module.
- Filtering chat events for a specific command.
- Sending a reply back through the Twitch IRC client.
- Where to hook a brand-new game into the rest of the app.

No SQLite, no scene route, no tick loop, no SSE. If you're trying
to figure out how the chat plumbing works, start here.

## Install

This example is implemented as a single file you drop into the
web container's source tree:

```
apps/web/src/lib/games/8ball.ts
```

Then add **one line** to
[`apps/web/src/instrumentation.ts`](../../../apps/web/src/instrumentation.ts)
so it boots with the rest of the workers:

```ts
const { eightball } = await import("./lib/games/8ball");
try { eightball(); } catch (err) { console.warn("[boot] 8ball init:", err); }
```

Rebuild + restart the web container:

```bash
docker compose up -d --build web
```

That's it. Anyone who types `!8ball will it rain tomorrow?` in
your Twitch chat will get a reply from the broadcaster account.

## How it works

The CacheStream chat client parses every Twitch IRC message and
publishes it to the in-process bus on the `"chat"` topic. Any
module can subscribe; this game's whole job is:

1. Subscribe to `"chat"`.
2. Filter for messages whose first word is `!8ball`.
3. Pick a random reply.
4. Send it via the IRC client.

That's the canonical pattern. The AI Pet and the Datacenter games
use the same hook, just with more state.

## Customising

Edit the `ANSWERS` array in [`8ball.ts`](./8ball.ts) — add your
own catchphrases, in-jokes, anything. Edit `COOLDOWN_MS` if you
want to slow down spammers (default: 3 seconds per user).

## Removing it

Delete `apps/web/src/lib/games/8ball.ts` and the one line you
added to `instrumentation.ts`. No DB rows to clean up — this game
holds zero persistent state.
