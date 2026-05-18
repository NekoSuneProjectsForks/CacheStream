import Link from "next/link";
import { redirect } from "next/navigation";
import { getBranding } from "@/lib/branding";
import { isSetupComplete } from "@/lib/settings";

/**
 * Public landing page. Two CTAs:
 *   1. View the scene that's currently being streamed.
 *   2. Log in to the admin control panel.
 *
 * Fresh deploys (setup wizard not completed) are redirected to
 * /setup. Once the wizard is done this becomes the normal landing.
 *
 * Branding (display name, logo, tagline, accent) flows in from the
 * kv-backed branding store so it stays consistent with the broadcast.
 */
export const dynamic = "force-dynamic";

export default function Landing() {
  if (!isSetupComplete()) redirect("/setup");

  const b = getBranding();
  const accent = b.accent || "#00f0ff";

  return (
    <main
      style={{
        minHeight: "100vh",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        gap: "1.25rem",
        padding: "2rem",
        textAlign: "center",
        background:
          "radial-gradient(ellipse at 50% 30%, rgba(138,43,255,.18) 0%, transparent 60%)," +
          "radial-gradient(ellipse at 50% 90%, rgba(0,240,255,.12) 0%, transparent 70%)," +
          "var(--bg-0)",
      }}
    >
      {b.logoUrl && (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={b.logoUrl}
          alt=""
          style={{
            height: 120,
            width: "auto",
            maxWidth: 360,
            objectFit: "contain",
            filter: `drop-shadow(0 0 24px ${accent}66)`,
            marginBottom: ".5rem",
          }}
        />
      )}

      <h1
        style={{
          fontSize: "clamp(2.5rem, 6vw, 5rem)",
          fontWeight: 800,
          letterSpacing: "0.05em",
          textTransform: "uppercase",
          color: "var(--text)",
          textShadow: `0 0 8px ${accent}a6, 0 0 22px ${accent}73, 0 0 60px rgba(138,43,255,.35)`,
        }}
      >
        {b.displayName}
      </h1>
      <p style={{ color: "var(--text-dim)", maxWidth: 480 }}>
        {b.tagline || "Headless Twitch streamer · Next.js control panel · Cyberpunk render pipeline."}
      </p>
      <nav style={{ display: "flex", gap: "0.75rem", marginTop: "0.5rem" }}>
        <Link href="/scene" style={{ ...btnPrimary, borderColor: accent, background: accent }}>
          View live scene
        </Link>
        <Link href="/admin" style={btnGhost}>Control panel</Link>
      </nav>
    </main>
  );
}

const btnPrimary: React.CSSProperties = {
  padding: "0.7rem 1.4rem",
  border: "1px solid var(--neon-cyan)",
  borderRadius: 4,
  color: "var(--bg-0)",
  background: "var(--neon-cyan)",
  fontWeight: 700,
  textTransform: "uppercase",
  letterSpacing: "0.12em",
};

const btnGhost: React.CSSProperties = {
  padding: "0.7rem 1.4rem",
  border: "1px solid var(--line)",
  borderRadius: 4,
  color: "var(--text)",
  background: "transparent",
  fontWeight: 600,
  textTransform: "uppercase",
  letterSpacing: "0.12em",
};
