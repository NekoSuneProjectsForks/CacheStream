"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { apiJson } from "./util";

interface Channel {
  broadcaster_id: string;
  broadcaster_name: string;
  title: string;
  game_id: string;
  game_name: string;
  broadcaster_language: string;
  tags: string[];
}
interface StreamInfo {
  type: string; title: string; game_name: string;
  viewer_count: number; started_at: string;
}

/**
 * Stream Info tab — title, category (Helix search), tags, language.
 * Edits are applied via PATCH /api/twitch/channel. Live stream info
 * (viewer count etc.) is shown alongside.
 */
export function StreamInfoTab() {
  const [channel, setChannel] = useState<Channel | null>(null);
  const [stream, setStream] = useState<StreamInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const [title, setTitle] = useState("");
  const [game, setGame] = useState<{ id: string; name: string } | null>(null);
  const [language, setLanguage] = useState("en");
  const [tagsInput, setTagsInput] = useState("");

  const [search, setSearch] = useState("");
  const [searchResults, setSearchResults] = useState<Array<{ id: string; name: string }>>([]);
  const debounceRef = useRef<NodeJS.Timeout | null>(null);

  const load = useCallback(async () => {
    setBusy("load"); setError(null);
    try {
      const { channel, stream } = await apiJson("/api/twitch/channel");
      setChannel(channel);
      setStream(stream);
      if (channel) {
        setTitle(channel.title || "");
        setGame(channel.game_id ? { id: channel.game_id, name: channel.game_name } : null);
        setLanguage(channel.broadcaster_language || "en");
        setTagsInput((channel.tags || []).join(", "));
      }
    } catch (e: any) { setError(e.message); }
    finally { setBusy(null); }
  }, []);

  useEffect(() => { load(); }, [load]);

  // Debounced category search.
  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    if (!search.trim()) { setSearchResults([]); return; }
    debounceRef.current = setTimeout(async () => {
      try {
        const { games } = await apiJson(`/api/twitch/categories/search?q=${encodeURIComponent(search)}`);
        setSearchResults(games || []);
      } catch {}
    }, 250);
    return () => { if (debounceRef.current) clearTimeout(debounceRef.current); };
  }, [search]);

  const save = async () => {
    setBusy("save"); setError(null);
    try {
      const tags = tagsInput.split(",").map((t) => t.trim()).filter(Boolean);
      const body: any = { title, tags, broadcaster_language: language };
      if (game?.id) body.game_id = game.id;
      const { channel } = await apiJson("/api/twitch/channel", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      setChannel(channel);
    } catch (e: any) { setError(e.message); }
    finally { setBusy(null); }
  };

  return (
    <>
      {error && <div className="banner err">⚠ {error}</div>}

      <section className="card">
        <div className="card-head">
          <h2>Stream info</h2>
          {stream?.type === "live" ? (
            <span className="badge ok">LIVE · {stream.viewer_count.toLocaleString()} viewers</span>
          ) : (
            <span className="badge mute">offline</span>
          )}
        </div>

        {!channel && <div className="muted">{busy === "load" ? "Loading…" : "No channel info — log in if you haven't."}</div>}

        {channel && (
          <>
            <Field label="Title">
              <input className="input grow" maxLength={140} value={title} onChange={(e) => setTitle(e.target.value)} />
              <span className="hint sm">{title.length}/140</span>
            </Field>

            <Field label="Category">
              <input
                className="input grow"
                placeholder={game ? game.name : "Search categories…"}
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
              {game && (
                <span className="tag ok" style={{ marginLeft: 6 }}>{game.name}</span>
              )}
            </Field>
            {searchResults.length > 0 && (
              <ul className="list" style={{ marginTop: ".5rem" }}>
                {searchResults.map((g) => (
                  <li key={g.id} className="list-row">
                    <div className="grow"><div className="row-title">{g.name}</div></div>
                    <button className="btn-primary sm" onClick={() => { setGame(g); setSearch(""); setSearchResults([]); }}>Pick</button>
                  </li>
                ))}
              </ul>
            )}

            <Field label="Tags">
              <input
                className="input grow"
                placeholder="comma separated (e.g. coding, dashboards, ambient)"
                value={tagsInput}
                onChange={(e) => setTagsInput(e.target.value)}
              />
            </Field>

            <Field label="Language">
              <select className="input" value={language} onChange={(e) => setLanguage(e.target.value)}>
                {["en","es","fr","de","ja","ko","pt","it","ru","zh"].map((l) => <option key={l} value={l}>{l}</option>)}
              </select>
            </Field>

            <div className="actions" style={{ marginTop: ".75rem" }}>
              <button className="btn-primary" disabled={!!busy} onClick={save}>
                {busy === "save" ? "Saving…" : "Save changes"}
              </button>
              <button className="btn-ghost" disabled={!!busy} onClick={load}>Reload</button>
            </div>
          </>
        )}
      </section>

      <StreamKeyCard />
    </>
  );
}

// ─── Stream Key + Ingest URL ─────────────────────────────────
//
// Lives in the Stream Info tab because it's broadcaster-account
// data. Backed by /api/twitch/ingest — values are stored in the
// kv table and pushed to the streamer container at runtime, so
// rotating a key is a single Save + ~5 s broadcast reconnect.
//
// The full key is never returned to the browser; we only see a
// masked preview ("live_…1234") + the byte length. To update,
// type the new key and Save. To clear (and fall back to whatever
// .env has) leave the field blank and click Save.

interface IngestSnap {
  streamKey: string;            // masked
  streamKeyLength: number;
  ingestUrl: string;            // dashboard kv value (or "" if none)
  source: {
    streamKey: "kv" | "env-or-unset";
    ingestUrl: "kv" | "env-or-default";
  };
  /** What the streamer actually thinks it's using right now. */
  streamerKeyConfigured: boolean;
  streamerIngestUrl: string;
}

function StreamKeyCard() {
  const [snap, setSnap] = useState<IngestSnap | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [keyDraft, setKeyDraft] = useState("");
  const [urlDraft, setUrlDraft] = useState("");
  const [showKey, setShowKey] = useState(false);

  const load = useCallback(async () => {
    try {
      const data = await apiJson("/api/twitch/ingest");
      setSnap(data);
      setUrlDraft(data.ingestUrl);
    } catch (e: any) { setError(e.message); }
  }, []);

  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    if (!info) return;
    const t = setTimeout(() => setInfo(null), 3500);
    return () => clearTimeout(t);
  }, [info]);

  const save = async () => {
    setBusy("save"); setError(null);
    try {
      // Send streamKey only if the user typed something. Sending
      // an empty string clears the kv override and falls back to env.
      const body: { streamKey?: string | null; ingestUrl?: string | null } = {};
      if (keyDraft.length > 0)            body.streamKey = keyDraft;
      if (urlDraft !== snap?.ingestUrl)   body.ingestUrl = urlDraft;
      const data = await apiJson("/api/twitch/ingest", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      setSnap(data);
      setKeyDraft("");
      setInfo("Saved. Broadcast reconnects in ~5 s if it was live.");
    } catch (e: any) { setError(e.message); }
    finally { setBusy(null); }
  };

  const clearKey = async () => {
    if (!confirm("Clear the dashboard key and fall back to whatever's in .env?")) return;
    setBusy("clear"); setError(null);
    try {
      const data = await apiJson("/api/twitch/ingest", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ streamKey: null }),
      });
      setSnap(data);
      setInfo("Dashboard key cleared. Streamer now uses the .env value.");
    } catch (e: any) { setError(e.message); }
    finally { setBusy(null); }
  };

  // Fetch the current stream key from Twitch directly using the
  // stored OAuth token. No manual copy/paste — eliminates the
  // class of bugs where the key in .env / dashboard / Twitch are
  // out of sync.
  const fetchFromTwitch = async () => {
    setBusy("fetch"); setError(null);
    try {
      const data = await apiJson("/api/twitch/ingest/fetch-key", { method: "POST" });
      // Endpoint returns the same shape as the regular GET plus
      // a `fetched: true` flag — reuse it as the local snapshot.
      setSnap((prev) => ({
        ...(prev as IngestSnap),
        ...data,
      }));
      setInfo("Pulled current key from Twitch. Broadcast reconnects in ~5 s if it was live.");
    } catch (e: any) {
      // The endpoint returns 412 with a missingScopes payload if
      // the operator's token predates v1.6.1. Tell them to re-auth.
      if (/missing channel:read:stream_key/i.test(e.message)) {
        setError("Your login is missing the channel:read:stream_key scope. Re-authorize via the Chat tab, then try again.");
      } else {
        setError(e.message);
      }
    }
    finally { setBusy(null); }
  };

  const usingKv = snap?.source.streamKey === "kv";
  const usingEnv = !usingKv && snap?.streamerKeyConfigured;
  const tagText = usingKv ? "dashboard" : usingEnv ? "from .env" : "missing";

  // The "current" line we display: dashboard key takes priority,
  // otherwise show what the streamer reports (effectively .env).
  const currentDisplay = snap?.streamKey
    ? snap.streamKey
    : usingEnv ? "(set in .env — managed by streamer)" : "—";

  const currentUrl = snap?.ingestUrl || snap?.streamerIngestUrl || "rtmp://live.twitch.tv/app";

  return (
    <section className="card">
      <div className="card-head">
        <h2>Stream key & ingest</h2>
        <span className="tag">{tagText}</span>
      </div>

      <div className="banner" style={{ borderColor: "rgba(0,240,255,.35)" }}>
        ↗ Twitch is now also managed in the <b>Multistream</b> tab (it’s auto-added
        there as a target). Use Multistream to stream to several platforms at once;
        this card still lets you fetch/clear the Twitch key.
      </div>

      {info  && <div className="banner ok">✓ {info}</div>}
      {error && <div className="banner err">⚠ {error}</div>}

      <p className="hint">
        Get a key at{" "}
        <a href="https://dashboard.twitch.tv/settings/stream" target="_blank" rel="noreferrer">
          dashboard.twitch.tv/settings/stream
        </a>. Saving here hot-restarts the broadcast — no container restart needed.
        Leave the new-key field blank and click <em>Clear dashboard key</em> to fall back to whatever's in your <code>.env</code>.
      </p>

      <div className="row gap" style={{ marginTop: ".75rem", alignItems: "center" }}>
        <div style={{ minWidth: 110, color: "var(--text-dim)", textTransform: "uppercase", fontSize: ".7rem", letterSpacing: ".2em" }}>
          Current
        </div>
        <code className="mono" style={{ color: "var(--neon-cyan)" }}>
          {currentDisplay}
        </code>
        {snap?.streamKey && (
          <span className="muted" style={{ fontSize: ".75rem" }}>
            {snap.streamKeyLength} chars · dashboard override
          </span>
        )}
      </div>

      <div className="row gap" style={{ marginTop: ".75rem", alignItems: "center" }}>
        <div style={{ minWidth: 110, color: "var(--text-dim)", textTransform: "uppercase", fontSize: ".7rem", letterSpacing: ".2em" }}>
          New key
        </div>
        <input
          className="input grow mono"
          type={showKey ? "text" : "password"}
          placeholder="live_…  (paste the value from your Twitch dashboard)"
          value={keyDraft}
          autoComplete="off"
          spellCheck={false}
          onChange={(e) => setKeyDraft(e.target.value)}
        />
        <button className="btn-ghost sm" onClick={() => setShowKey((s) => !s)}>
          {showKey ? "Hide" : "Show"}
        </button>
      </div>

      <div className="row gap" style={{ marginTop: ".75rem", alignItems: "center" }}>
        <div style={{ minWidth: 110, color: "var(--text-dim)", textTransform: "uppercase", fontSize: ".7rem", letterSpacing: ".2em" }}>
          Ingest URL
        </div>
        <input
          className="input grow mono"
          value={urlDraft}
          placeholder={currentUrl}
          onChange={(e) => setUrlDraft(e.target.value)}
        />
        <span className="muted" style={{ fontSize: ".75rem" }}>
          {snap?.source.ingestUrl === "kv" ? "dashboard override" : "from .env"}
        </span>
      </div>

      <div className="actions" style={{ marginTop: "1rem" }}>
        <button
          className="btn-primary"
          disabled={!!busy}
          onClick={fetchFromTwitch}
          title="Pull the current key from Twitch using your OAuth login. No copy/paste."
        >
          {busy === "fetch" ? "Fetching…" : "Fetch from Twitch"}
        </button>
        <button
          className="btn-ghost"
          disabled={!!busy || (keyDraft.length === 0 && urlDraft === (snap?.ingestUrl || ""))}
          onClick={save}
        >
          {busy === "save" ? "Saving…" : "Save manual entry"}
        </button>
        {usingKv && (
          <button className="btn-ghost" disabled={!!busy} onClick={clearKey}>
            {busy === "clear" ? "Clearing…" : "Clear"}
          </button>
        )}
        <button className="btn-ghost" disabled={!!busy} onClick={load}>Reload</button>
      </div>
    </section>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="row gap" style={{ marginTop: ".75rem", alignItems: "center" }}>
      <div style={{ minWidth: 110, color: "var(--text-dim)", textTransform: "uppercase", fontSize: ".7rem", letterSpacing: ".2em" }}>
        {label}
      </div>
      {children}
    </div>
  );
}
