/**
 * Next.js boot hook.
 *
 * Runs exactly once on server startup. We use it to bring up the
 * long-lived background workers (chat IRC, EventSub WebSocket)
 * if the broadcaster already has stored OAuth tokens.
 *
 * If tokens are missing the workers stay idle until the admin
 * panel triggers them after a successful login.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;

  const { getStore } = await import("./lib/store");
  const { startChat } = await import("./lib/twitch/chat");
  const { startEventSub } = await import("./lib/twitch/eventsub");

  const store = getStore();

  // Boot game engines unconditionally — they subscribe to the chat
  // bus during init(), so they must be alive BEFORE chat connects.
  // Previously this lived inside the tokens-present branch, which
  // meant a fresh install (no tokens yet) booted chat later via the
  // admin panel but the games never woke up to hear it.
  const { pet } = await import("./lib/games/pet");
  const { datacenter } = await import("./lib/games/datacenter");
  try { pet(); } catch (err) { console.warn("[boot] pet init:", err); }
  try { datacenter(); } catch (err) { console.warn("[boot] datacenter init:", err); }

  const tokens = store.getTokens();
  if (!tokens) {
    console.log("[boot] no broadcaster tokens — skipping chat/eventsub startup");
    return;
  }

  Promise.allSettled([startChat(), startEventSub()]).then((results) => {
    for (const r of results) {
      if (r.status === "rejected") console.warn("[boot] worker start error:", r.reason);
    }
  });

  // Seed scene presets for built-in scenes on first boot. We only
  // add ones the operator doesn't already have (matched by URL).
  // This means deleting a built-in preset is sticky — it won't be
  // re-added on restart.
  try {
    const existing = new Set(store.listScenes().map((s) => s.url));
    const builtins: Array<{ name: string; url: string }> = [
      { name: "Hello World",   url: "http://web:7788/scene" },
      { name: "Starting Soon", url: "http://web:7788/scene/starting-soon" },
      { name: "BRB",           url: "http://web:7788/scene/brb" },
      { name: "Ending",        url: "http://web:7788/scene/ending" },
      { name: "Offline",       url: "http://web:7788/scene/offline" },
      { name: "Music / Radio", url: "http://web:7788/scene/music" },
      { name: "AI Pet",        url: "http://web:7788/scene/pet" },
      { name: "Datacenter",    url: "http://web:7788/scene/datacenter" },
    ];
    let added = 0;
    for (const b of builtins) {
      if (!existing.has(b.url)) { store.addScene(b.name, b.url); added++; }
    }
    if (added > 0) console.log(`[boot] seeded ${added} built-in scene presets`);
  } catch (err) {
    console.warn("[boot] preset seed failed:", err);
  }

  // Push the dashboard-stored ingest credentials (if any) to the
  // streamer. Handles the case where the streamer container
  // restarted and lost its in-memory copy of the runtime override.
  // Wrapped in a short delay so the streamer's API has time to
  // come up.
  setTimeout(() => {
    import("./lib/twitchIngest")
      .then((mod) => mod.pushIngestToStreamer())
      .catch((err) => console.warn("[boot] ingest push failed:", err));
  }, 3_000);
}
