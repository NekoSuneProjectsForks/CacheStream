import { NextResponse } from "next/server";
import { staffRoute } from "@/lib/api-helpers";
import { busListenerCounts } from "@/lib/bus";

export const dynamic = "force-dynamic";

/**
 * GET /api/system/diag
 *
 * Runtime diagnostics — memory usage + active bus subscriber
 * counts. Use this to confirm SSE cleanup is working: the
 * "chat" / "alerts" / "pet" / "datacenter" counts should sit at
 * a small, stable number even after the streamer reloads scenes
 * many times. If they grow without bound, the cleanup path in
 * lib/sse.ts isn't firing for some clients — open an issue.
 *
 * Owner-only since it surfaces process internals.
 */
export const GET = staffRoute(async () => {
  const mem = process.memoryUsage();
  return NextResponse.json({
    uptimeS: Math.round(process.uptime()),
    memory: {
      rssMB:        Math.round(mem.rss / 1024 / 1024),
      heapUsedMB:   Math.round(mem.heapUsed / 1024 / 1024),
      heapTotalMB:  Math.round(mem.heapTotal / 1024 / 1024),
      externalMB:   Math.round(mem.external / 1024 / 1024),
    },
    busSubscribers: busListenerCounts(),
    node: {
      version: process.version,
      pid: process.pid,
    },
  });
});
