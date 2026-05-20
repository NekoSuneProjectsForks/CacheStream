import { NextResponse } from "next/server";
import { ownerRoute } from "@/lib/api-helpers";
import { kvGet, kvSet } from "@/lib/db";

export const dynamic = "force-dynamic";

/**
 * Per-key operations.
 *
 *   DELETE /api/ingest/keys/<key>            — remove a multi-key entry
 *   POST   /api/ingest/keys/<key>/regenerate — rotate to a new random value
 *
 * The default key (kv `ingest_stream_key`, typically "cache")
 * can be regenerated here (it'll update the default kv slot in
 * place) but not deleted — there's always a default.
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

export const DELETE = ownerRoute(async (_req, { params }: { params: { key: string } }) => {
  const def = kvGet("ingest_stream_key") || "cache";
  if (params.key === def) {
    return NextResponse.json({ error: "default key not deletable here" }, { status: 400 });
  }
  const list = readKeys();
  const next = list.filter((r) => r.key !== params.key);
  if (next.length === list.length) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }
  writeKeys(next);
  // Clear any cached "started at" timestamp for the removed key
  // (cosmetic — keeps the kv tidy).
  kvSet(`ingest_started_at:${params.key}`, "");
  return NextResponse.json({ ok: true });
});
