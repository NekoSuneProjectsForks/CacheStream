"use client";

/**
 * Browser-source scene — renders a configured embed URL inside
 * a sandboxed full-bleed iframe. Headless Chromium loads this
 * route as part of the broadcast; the streamer captures the
 * page as normal so overlays + chat games still composite on
 * top via the panel's existing widget infra.
 *
 * The iframe is sandboxed with `allow-scripts allow-same-origin`
 * — scripts can run (needed for Streamlabs/Stream Elements alert
 * widgets), but the frame can't reach the parent's cookies via
 * postMessage to /api/* (different origins) so untrusted embed
 * sources can't elevate themselves to the OAuth session. Still,
 * only embed widget URLs you trust; a malicious script inside an
 * embed can render arbitrary visuals over your broadcast.
 *
 * Layout: full-bleed by default. If `width` + `height` were set
 * on the embed (e.g. for a chat box that doesn't want to be
 * stretched to 1080p), the iframe gets pinned to that pixel size
 * centered inside the scene; the rest of the scene is the same
 * cyberpunk gradient as the other built-ins.
 */

import { useEffect, useState } from "react";
import { use } from "react";
import ClientSceneOverlays from "../../_shared/ClientSceneOverlays";

interface Embed {
  slug: string;
  name: string;
  url: string;
  width: number | null;
  height: number | null;
  transparent: boolean;
}

export default function EmbedScene({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = use(params);
  const [embed, setEmbed] = useState<Embed | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const r = await fetch(`/api/embeds/${encodeURIComponent(slug)}`, { cache: "no-store" });
        if (!r.ok) {
          setErr(`embed not found: ${slug}`);
          return;
        }
        const data = await r.json();
        if (!cancelled) setEmbed(data);
      } catch (e: any) {
        setErr(e?.message || String(e));
      }
    })();
    return () => { cancelled = true; };
  }, [slug]);

  return (
    <>
      <style>{`
        html, body {
          margin: 0; padding: 0; height: 100%;
          background: ${embed?.transparent ? "transparent" : "#05060a"};
          overflow: hidden;
          font-family: "Segoe UI", system-ui, -apple-system, sans-serif;
        }
        .embed-wrap {
          position: fixed; inset: 0;
          display: grid;
          place-items: ${embed?.width && embed?.height ? "center" : "stretch"};
          background:
            radial-gradient(circle at 50% 30%, rgba(0,240,255,.06), transparent 60%),
            #05060a;
        }
        .embed-frame {
          border: 0;
          background: ${embed?.transparent ? "transparent" : "#05060a"};
          ${embed?.width && embed?.height
            ? `width: ${embed.width}px; height: ${embed.height}px;`
            : "width: 100%; height: 100%;"}
        }
        .embed-err {
          color: #f87171; padding: 32px;
          font-family: 'JetBrains Mono', monospace; font-size: 14px;
          letter-spacing: .12em;
        }
      `}</style>

      <div className="embed-wrap">
        {err && <div className="embed-err">⚠ {err}</div>}
        {embed && (
          <iframe
            className="embed-frame"
            src={embed.url}
            // allow-scripts: most alert widgets need JS.
            // allow-same-origin: needed for widgets that use cookies
            //   on their own domain (e.g. logged-in dashboards).
            //   The parent origin is *different* so /api/* cookies
            //   stay safe. allow-popups, allow-forms kept off.
            sandbox="allow-scripts allow-same-origin allow-presentation"
            allow="autoplay; encrypted-media"
            referrerPolicy="no-referrer-when-downgrade"
            title={embed.name}
          />
        )}
      </div>
      <ClientSceneOverlays />
    </>
  );
}
