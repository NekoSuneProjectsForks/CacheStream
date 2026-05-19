"use client";

/**
 * RTMP ingest scene.
 *
 * Plays back an HLS feed produced by the `ingest` nginx-rtmp
 * container, which itself transmuxes whatever OBS (or any other
 * RTMP encoder) pushes to rtmp://<host>:1935/live/<key>.
 *
 * Workflow:
 *   1. Operator configures their RTMP encoder to push to the URL
 *      shown on the Stream Info card.
 *   2. nginx-rtmp wraps the bitstream as HLS chunks under
 *      /tmp/hls/<key>.m3u8 + segment .ts files.
 *   3. This page polls /api/ingest/status to learn the stream key
 *      and whether the feed is actually live, then loads the
 *      playlist via hls.js (Chromium doesn't natively play HLS).
 *   4. The streamer's headless Chromium captures this page at
 *      30fps and feeds Twitch. Scene overlays + Now Playing
 *      composite on top.
 *
 * Latency: typically 3-5s OBS → Twitch. Acceptable for chat-driven
 * streams; not great for action gameplay where 100ms matters.
 */

import { useEffect, useRef, useState } from "react";
import ClientSceneOverlays from "../_shared/ClientSceneOverlays";

interface IngestStatus {
  key: string;
  enabled: boolean;
  live: boolean;
  hlsUrl: string | null;
  pushUrl: string;
  startedAt: number | null;
}

export default function IngestScene() {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const [status, setStatus] = useState<IngestStatus | null>(null);
  const [playerErr, setPlayerErr] = useState<string | null>(null);

  // Poll ingest status so we can show "waiting" when the encoder
  // isn't pushing yet, and auto-load the playlist when it goes live.
  useEffect(() => {
    let cancelled = false;
    const tick = async () => {
      try {
        const r = await fetch("/api/ingest/status", { cache: "no-store" });
        if (!r.ok) return;
        const data = await r.json();
        if (!cancelled) setStatus(data);
      } catch {}
    };
    tick();
    const id = setInterval(tick, 2000);
    return () => { cancelled = true; clearInterval(id); };
  }, []);

  // Attach hls.js to the <video> element whenever the playlist URL
  // becomes available. hls.js is loaded from a CDN inside the
  // headless Chromium — same trick the music scene uses for AC.
  useEffect(() => {
    const video = videoRef.current;
    const hlsUrl = status?.hlsUrl;
    if (!video || !hlsUrl) return;

    // Some browsers (Safari) can play HLS natively without hls.js.
    // Chromium can't, but checking first lets the same code work
    // when previewing the scene from a Mac during dev.
    if (video.canPlayType("application/vnd.apple.mpegurl")) {
      video.src = hlsUrl;
      video.play().catch(() => {});
      return;
    }

    let hls: any = null;
    let mounted = true;
    (async () => {
      try {
        // hls.js is an npm dep. Dynamic-imported so it doesn't get
        // bundled into routes that don't need it (every other
        // scene). Next's code-splitter resolves this to a separate
        // chunk that loads when /scene/ingest is first visited.
        const mod = await import("hls.js");
        if (!mounted) return;
        const Hls = mod.default;
        if (!Hls.isSupported()) {
          setPlayerErr("hls.js not supported in this browser");
          return;
        }
        // Low-latency profile (v1.10.2). The defaults wait for
        // ~30s of segments before starting playback and keep ~60s
        // of buffer behind the playhead, which is exactly what we
        // DON'T want for a live ingest. The values below pin
        // playback as close to the live edge as the segment cadence
        // allows. Combined with the 1s nginx-rtmp fragments this
        // gets us ~2s of player-side latency.
        hls = new Hls({
          lowLatencyMode: true,
          backBufferLength: 4,        // keep 4s of seek history (was 10)
          maxBufferLength: 3,         // never buffer more than 3s ahead (was 8)
          maxMaxBufferLength: 6,      // hard cap on dynamic buffer growth
          liveSyncDuration: 1,        // chase the edge: stay within 1 segment
          liveMaxLatencyDuration: 4,  // panic-seek if we fall >4s behind
          highBufferWatchdogPeriod: 1,
          // Skip the default ABR ramp-up; the source is a single
          // bitrate from nginx-rtmp so there's nothing to switch to.
          startLevel: 0,
          // Aggressive front-buffer fetch so a fresh playlist load
          // doesn't sit waiting for the player's normal cadence.
          maxLoadingDelay: 1,
          manifestLoadingTimeOut: 4000,
          manifestLoadingMaxRetry: 6,
          fragLoadingTimeOut: 4000,
        });
        hls.loadSource(hlsUrl);
        hls.attachMedia(video);
        hls.on(Hls.Events.ERROR, (_e: unknown, data: any) => {
          if (data?.fatal) setPlayerErr(`hls fatal: ${data.type} ${data.details}`);
        });
        // Aggressively snap to the live edge whenever the player
        // falls more than 2s behind (e.g. after a brief network
        // stall). Without this, dropped segments compound into
        // permanent extra latency over hours.
        video.addEventListener("waiting", () => {
          if (!hls) return;
          const live = hls.liveSyncPosition;
          if (typeof live === "number" && video.currentTime < live - 2) {
            video.currentTime = live;
          }
        });
        video.muted = false;
        video.play().catch(() => {});
      } catch (err: any) {
        setPlayerErr(err?.message || String(err));
      }
    })();

    return () => {
      mounted = false;
      try { hls?.destroy(); } catch {}
    };
  }, [status?.hlsUrl]);

  const showWaiting = !status?.live;

  return (
    <>
      <style>{`
        html, body { margin: 0; padding: 0; height: 100%; background: #000; overflow: hidden;
          font-family: 'JetBrains Mono', 'Segoe UI', monospace; color: #e6f7ff; }
        .ingest-wrap { position: fixed; inset: 0; }
        video {
          width: 100%; height: 100%;
          object-fit: contain;
          background: #000;
        }
        .waiting {
          position: absolute; inset: 0;
          display: grid; place-items: center;
          background: radial-gradient(circle at 50% 50%, rgba(0,240,255,0.05), #000 70%);
        }
        .waiting .card {
          text-align: center;
          padding: 48px 64px;
          border: 1px solid rgba(0,240,255,.25);
          border-radius: 8px;
          background: rgba(10,13,24,.7);
          backdrop-filter: blur(6px);
        }
        .waiting .pulse {
          display: inline-block;
          width: 12px; height: 12px; border-radius: 50%;
          background: #00f0ff; box-shadow: 0 0 16px #00f0ff;
          margin-right: 12px; vertical-align: middle;
          animation: pulse 1.6s ease-in-out infinite;
        }
        @keyframes pulse { 0%,100% { opacity: 1; transform: scale(1); } 50% { opacity: .35; transform: scale(.85); } }
        .waiting .title {
          font-size: 16px; letter-spacing: .35em; text-transform: uppercase;
          margin-bottom: 18px;
        }
        .waiting .url {
          font-size: 12px; color: rgba(230,247,255,.7);
          letter-spacing: .12em;
        }
        .waiting .err {
          margin-top: 14px;
          font-size: 11px; color: #f87171;
        }
      `}</style>

      <div className="ingest-wrap">
        <video ref={videoRef} autoPlay playsInline />
        {showWaiting && (
          <div className="waiting">
            <div className="card">
              <div className="title"><span className="pulse" /> WAITING FOR ENCODER</div>
              <div className="url">push to {status?.pushUrl || "rtmp://<host>:1935/live"}</div>
              {playerErr && <div className="err">{playerErr}</div>}
            </div>
          </div>
        )}
      </div>
      <ClientSceneOverlays nowPlayingCorner="tr" />
    </>
  );
}
