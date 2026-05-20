import { NextResponse } from "next/server";
import crypto from "node:crypto";
import { ownerRoute } from "@/lib/api-helpers";
import { kvGet, kvSet } from "@/lib/db";

export const dynamic = "force-dynamic";

/**
 * POST /api/ingest/keys/<key>/regenerate
 *
 * Rotates the key value while preserving its label + created-at.
 * Used by the panel's "Regenerate" button so an operator can
 * invalidate a leaked key without losing the scene preset that
 * references it (the preset URL is keyed on the OLD value, so
 * the operator still has to update the preset URL afterwards —
 * the response includes both the old + new key so the UI can
 * walk the scene-preset table and bump matching URLs).
 *
 * Both the default key (kv `ingest_stream_key`) and additional
 * multi-key entries (`ingest:keys:list`) are supported. The
 * default key is identified by being the value of
 * `ingest_stream_key` rather than appearing in the list.
 *
 * Owner-only — rotating a key has the same blast radius as
 * inviting a moderator (whoever has the new value can publish).
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

export const POST = ownerRoute(async (_req, { params }: { params: { key: string } }) => {
  const oldKey = params.key;
  // Long random value — same length as the default key generator.
  const newKey = crypto.randomBytes(12).toString("hex");

  // Default-key path: rewrite the dedicated kv slot.
  const def = kvGet("ingest_stream_key") || "cache";
  if (oldKey === def) {
    kvSet("ingest_stream_key", newKey);
    // Default doesn't live in the list, so we're done.
    kvSet(`ingest_started_at:${oldKey}`, "");
    return NextResponse.json({ oldKey, newKey, label: "Default" });
  }

  // Multi-key path: find the row, replace the `key` field in place
  // (label + createdAt preserved). Clear the old per-key started-at.
  const list = readKeys();
  const idx = list.findIndex((r) => r.key === oldKey);
  if (idx < 0) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }
  const label = list[idx].label;
  list[idx] = { ...list[idx], key: newKey };
  writeKeys(list);
  kvSet(`ingest_started_at:${oldKey}`, "");

  return NextResponse.json({ oldKey, newKey, label });
});
