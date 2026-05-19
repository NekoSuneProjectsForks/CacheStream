import { redirect } from "next/navigation";

/**
 * /login/invite?code=<staff-invite-code>
 *
 * Landing surface for a staff-invite URL. Server-renders nothing
 * meaningful — its only job is to forward the user into the Twitch
 * OAuth flow with the invite code in tow. The login route picks
 * the code out of the query, drops it on a signed cookie, and
 * the OAuth callback consumes it after the user authenticates.
 *
 * If the URL lacks ?code, we bounce to the panel (likely the
 * person was looking for /admin and mistyped).
 */
export const dynamic = "force-dynamic";

interface SearchParams {
  searchParams: Promise<{ code?: string }>;
}

export default async function InviteLanding({ searchParams }: SearchParams) {
  const { code } = await searchParams;
  if (!code) redirect("/admin");
  // The login route handles cookie signing + Twitch redirect.
  redirect(`/api/auth/twitch/login?code=${encodeURIComponent(code)}`);
}
