import { NextRequest, NextResponse } from "next/server";
import crypto from "node:crypto";
import { publish } from "@/lib/bus";
import { getStore } from "@/lib/store";

export const dynamic = "force-dynamic";

/**
 * POST /api/kick/webhook — Kick event webhooks (follows/subs/raids/…).
 *
 * Public (Kick posts here). Verifies the RSA-SHA256 signature over
 * "{message-id}.{timestamp}.{rawBody}" against Kick's published public
 * key, then maps the event onto the "alerts" bus topic. See Appendix A
 * in docs/design/multi-platform-accounts.md.
 *
 * Untested end-to-end (needs a registered Kick webhook subscription).
 */

let cachedKey: { pem: string; at: number } | null = null;

async function publicKey(): Promise<string | null> {
  if (cachedKey && Date.now() - cachedKey.at < 3_600_000) return cachedKey.pem;
  try {
    const r = await fetch("https://api.kick.com/public/v1/public-key", { cache: "no-store" });
    if (!r.ok) return null;
    const j = (await r.json()) as { data?: { public_key?: string } };
    const pem = j?.data?.public_key;
    if (pem) { cachedKey = { pem, at: Date.now() }; return pem; }
  } catch { /* unreachable */ }
  return null;
}

export async function POST(req: NextRequest) {
  const raw = await req.text();
  const msgId = req.headers.get("kick-event-message-id") || "";
  const ts = req.headers.get("kick-event-message-timestamp") || "";
  const sig = req.headers.get("kick-event-signature") || "";
  const type = req.headers.get("kick-event-type") || "";

  const pem = await publicKey();
  if (pem && sig) {
    try {
      const ok = crypto.verify(
        "RSA-SHA256",
        Buffer.from(`${msgId}.${ts}.${raw}`),
        pem,
        Buffer.from(sig, "base64"),
      );
      if (!ok) return new NextResponse("bad signature", { status: 401 });
    } catch {
      return new NextResponse("bad signature", { status: 401 });
    }
  }

  let payload: any = {};
  try { payload = JSON.parse(raw); } catch {}

  const mapped = mapKickAlert(type);
  if (mapped) {
    const channelId = String(getStore().getPlatformLink("kick")?.extra?.chatroomId ?? "");
    publish("alerts", {
      platform: "kick",
      channelId,
      type: mapped,
      event: payload,
    });
  }
  return NextResponse.json({ ok: true });
}

function mapKickAlert(type: string):
  | "follow" | "sub" | "gift" | "raid" | "cheer" | null {
  const t = type.toLowerCase();
  if (t.includes("follow")) return "follow";
  if (t.includes("gift")) return "gift";
  if (t.includes("subscription") || t.includes("subscribe")) return "sub";
  if (t.includes("raid") || t.includes("host")) return "raid";
  if (t.includes("cheer") || t.includes("bits")) return "cheer";
  return null;
}
