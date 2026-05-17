/** JSON-aware fetch helper that throws on non-2xx with the API error message. */
export async function apiJson(input: RequestInfo, init?: RequestInit): Promise<any> {
  const r = await fetch(input, { cache: "no-store", ...init });
  const text = await r.text();
  const body = text ? (() => { try { return JSON.parse(text); } catch { return text; } })() : {};
  if (!r.ok) {
    const msg = (body && typeof body === "object" && (body as any).error) || `HTTP ${r.status}`;
    throw new Error(String(msg));
  }
  return body;
}
