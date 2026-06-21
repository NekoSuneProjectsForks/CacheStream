import { NextResponse } from "next/server";
import crypto from "node:crypto";
import { ownerRoute, readJson } from "@/lib/api-helpers";
import { kvGet, kvSet } from "@/lib/db";
import { config } from "@/lib/config";

export const dynamic = "force-dynamic";

/**
 * Multi-key RTMP ingest registry (v1.11.0).
 *
 *   GET  /api/ingest/keys           — list keys + their liveness
 *   POST /api/ingest/keys { label } — create a new key
 *
 * The legacy single-key flow from v1.9.0 (kv `ingest_stream_key`,
 * default "cache") remains intact. The list-based multi-key
 * registry is purely additive; the default key is always
 * implicitly present in the list result. Each additional key
 * becomes its own scene preset via /scene/ingest?k=<key>.
 *
 * Storage:
 *   kv `ingest_stream_key` — string, default "cache" (legacy)
 *   kv `ingest:keys:list`  — JSON array of { key, label, createdAt }
 *
 * Liveness is checked the same way the single-key flow does:
 * HEAD against the nginx-rtmp HLS playlist for that key.
 */

interface IngestKeyRow {
  key: string;
  label: string;
  createdAt: number;
}

function readKeys(): IngestKeyRow[] {
  const raw = kvGet("ingest:keys:list");
  if (!raw) return [];
  try { return JSON.parse(raw) as IngestKeyRow[]; }
  catch { return []; }
}
function writeKeys(rows: IngestKeyRow[]): void {
  kvSet("ingest:keys:list", JSON.stringify(rows));
}

/** All keys, including the implicit default. */
function listAllKeys(): IngestKeyRow[] {
  const def = kvGet("ingest_stream_key") || "cache";
  const extra = readKeys().filter((r) => r.key !== def);
  return [
    { key: def, label: "Default", createdAt: 0 },
    ...extra,
  ];
}

async function checkLive(key: string): Promise<boolean> {
  try {
    const r = await fetch(`${config.ingest.httpUrl}/hls/${encodeURIComponent(key)}.m3u8`,
      { method: "HEAD", cache: "no-store" });
    return r.ok;
  } catch { return false; }
}

export const GET = ownerRoute(async () => {
  const rows = listAllKeys();
  const out = await Promise.all(rows.map(async (r) => ({
    ...r,
    live: await checkLive(r.key),
    startedAt: null as number | null,
  })));
  return NextResponse.json(out);
});

export const POST = ownerRoute(async (req) => {
  const body = await readJson<{ label?: string; key?: string }>(req);
  const label = (body.label || "").trim().slice(0, 40);
  if (!label) return NextResponse.json({ error: "label required" }, { status: 400 });

  // Auto-generate a long random key unless the operator pinned
  // one. Random keys are safer (16 bytes hex = unguessable); pinned
  // keys are convenient for things like "phone" / "screen" mnemonic
  // pushing-from-where-you-remember workflows.
  let key = (body.key || "").trim();
  if (key) {
    if (!/^[A-Za-z0-9_-]{3,64}$/.test(key)) {
      return NextResponse.json(
        { error: "key must be 3-64 chars: letters, digits, _ or -" },
        { status: 400 },
      );
    }
  } else {
    key = crypto.randomBytes(12).toString("hex");
  }

  const all = listAllKeys();
  if (all.some((r) => r.key === key)) {
    return NextResponse.json({ error: "key already exists" }, { status: 409 });
  }

  const rows = readKeys();
  rows.push({ key, label, createdAt: Date.now() });
  writeKeys(rows);
  return NextResponse.json({ key, label });
});
