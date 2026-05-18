import { NextResponse } from "next/server";
import crypto from "node:crypto";
import { ownerRoute, readJson } from "@/lib/api-helpers";
import { kvGet, kvSet } from "@/lib/db";

export const dynamic = "force-dynamic";

/**
 * RTMP ingest configuration (auth-gated).
 *
 *   GET  → current key + enable flag
 *   POST → { key?, enabled?, rotateKey? } partial update
 *
 * A long random key (32 hex chars) is the default — guessable
 * keys like "cache" are convenient for first-boot but should be
 * rotated before going live, since anyone with the host's RTMP
 * port + key can hijack your scene feed.
 */
export const GET = ownerRoute(async () => {
  return NextResponse.json({
    key: kvGet("ingest_stream_key") || "cache",
    enabled: (kvGet("ingest_enabled") ?? "1") === "1",
  });
});

export const POST = ownerRoute(async (req) => {
  const body = await readJson<{ key?: string; enabled?: boolean; rotateKey?: boolean }>(req);

  if (body.rotateKey) {
    const k = crypto.randomBytes(16).toString("hex");
    kvSet("ingest_stream_key", k);
  } else if (typeof body.key === "string") {
    const trimmed = body.key.trim();
    if (!/^[A-Za-z0-9_-]{3,64}$/.test(trimmed)) {
      return NextResponse.json(
        { error: "key must be 3-64 chars: letters, digits, _ or -" },
        { status: 400 },
      );
    }
    kvSet("ingest_stream_key", trimmed);
  }
  if (typeof body.enabled === "boolean") {
    kvSet("ingest_enabled", body.enabled ? "1" : "0");
  }

  return NextResponse.json({
    key: kvGet("ingest_stream_key") || "cache",
    enabled: (kvGet("ingest_enabled") ?? "1") === "1",
  });
});
