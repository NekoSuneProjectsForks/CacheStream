import { NextResponse } from "next/server";
import { staffRoute, readJson } from "@/lib/api-helpers";
import { getStore, type CustomCommand } from "@/lib/store";

export const dynamic = "force-dynamic";

export const GET = staffRoute(async () => {
  return NextResponse.json({ commands: getStore().listCommands() });
});

export const POST = staffRoute(async (req) => {
  const body = await readJson<Partial<CustomCommand>>(req);
  if (!body.trigger || !body.response) {
    return NextResponse.json({ error: "trigger and response required" }, { status: 400 });
  }
  const cmd = getStore().addCommand({
    trigger: body.trigger,
    response: body.response,
    cooldownS: body.cooldownS ?? 5,
    modOnly: !!body.modOnly,
    subOnly: !!body.subOnly,
    enabled: body.enabled !== false,
  });
  return NextResponse.json({ command: cmd });
});
