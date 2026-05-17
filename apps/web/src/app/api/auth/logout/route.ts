import { NextRequest, NextResponse } from "next/server";
import { SESSION_COOKIE, unsign, cookieOpts } from "@/lib/cookies";
import { getStore } from "@/lib/store";
import { config } from "@/lib/config";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const sid = unsign(req.cookies.get(SESSION_COOKIE)?.value);
  if (sid) getStore().destroySession(sid);
  const res = NextResponse.redirect(`${config.web.publicUrl}/`, 303);
  res.cookies.set(SESSION_COOKIE, "", cookieOpts(0));
  return res;
}
