import { NextResponse } from "next/server";
import { ownerRoute } from "@/lib/api-helpers";
import { kvGet, kvSet } from "@/lib/db";

export const dynamic = "force-dynamic";

/**
 * DELETE /api/ingest/keys/<key> — remove a multi-key entry.
 *
 * The default key (kv `ingest_stream_key`, typically "cache")
 * can't be deleted via this route — rotating the default is a
 * different workflow handled by /api/ingest/config.
 */

interface IngestKeyRow {
  key: string;
  label: string;
  createdAt: number;
}

export const DELETE = ownerRoute(async (_req, { params }: { params: { key: string } }) => {
  const def = kvGet("ingest_stream_key") || "cache";
  if (params.key === def) {
    return NextResponse.json({ error: "default key not deletable here" }, { status: 400 });
  }
  const raw = kvGet("ingest:keys:list");
  let list: IngestKeyRow[] = [];
  try { list = raw ? JSON.parse(raw) : []; } catch { list = []; }
  const next = list.filter((r) => r.key !== params.key);
  if (next.length === list.length) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }
  kvSet("ingest:keys:list", JSON.stringify(next));
  return NextResponse.json({ ok: true });
});
