import fs from "node:fs";
import { NextRequest, NextResponse } from "next/server";
import { ownerRoute } from "@/lib/api-helpers";
import {
  clearLogo,
  logoMimeFor,
  resolveLogoPath,
  saveLogoBytes,
} from "@/lib/branding";

export const dynamic = "force-dynamic";

/**
 * GET /api/branding/logo — public binary stream of the current logo.
 * Returns 404 when none is uploaded so callers can fall back to a
 * text wordmark cheaply.
 */
export async function GET() {
  const p = resolveLogoPath();
  if (!p) return new NextResponse("no logo", { status: 404 });
  const buf = fs.readFileSync(p);
  return new NextResponse(buf, {
    headers: {
      "Content-Type": logoMimeFor(p),
      "Cache-Control": "public, max-age=300",
    },
  });
}

/** POST /api/branding/logo — multipart upload of a single logo file. */
export const POST = ownerRoute(async (req: NextRequest) => {
  const form = await req.formData();
  const file = form.get("file");
  if (!(file instanceof File)) {
    return NextResponse.json({ error: "no file" }, { status: 400 });
  }
  const bytes = new Uint8Array(await file.arrayBuffer());
  try {
    const next = await saveLogoBytes(file.name, bytes);
    return NextResponse.json(next);
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: err.status || 500 });
  }
});

/** DELETE /api/branding/logo — remove the logo. */
export const DELETE = ownerRoute(async () => {
  return NextResponse.json(clearLogo());
});
