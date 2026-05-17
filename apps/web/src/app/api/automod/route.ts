import { NextResponse } from "next/server";
import { ownerRoute, readJson } from "@/lib/api-helpers";
import { getStore, type AutoModRule } from "@/lib/store";

export const dynamic = "force-dynamic";

export const GET = ownerRoute(async () => {
  return NextResponse.json({ rules: getStore().listAutoModRules() });
});

export const POST = ownerRoute(async (req) => {
  const body = await readJson<Partial<AutoModRule>>(req);
  if (!body.matchType || !body.pattern || !body.action) {
    return NextResponse.json({ error: "matchType, pattern, action required" }, { status: 400 });
  }
  if (!["contains", "regex", "startswith"].includes(body.matchType)) {
    return NextResponse.json({ error: "invalid matchType" }, { status: 400 });
  }
  if (!["delete", "timeout", "ban"].includes(body.action)) {
    return NextResponse.json({ error: "invalid action" }, { status: 400 });
  }
  const rule = getStore().addAutoModRule({
    matchType: body.matchType,
    pattern: body.pattern,
    action: body.action,
    durationS: body.durationS ?? null,
    reason: body.reason ?? null,
    enabled: body.enabled !== false,
  });
  return NextResponse.json({ rule });
});
