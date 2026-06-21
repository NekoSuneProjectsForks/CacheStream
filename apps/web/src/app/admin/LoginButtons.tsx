"use client";

import { useEffect, useState } from "react";

/**
 * Login affordances, progressively enhanced for the desktop app.
 *
 * In a normal browser this is just the one "Login with Twitch" link.
 * Inside the Electron desktop app (detected via the Electron UA) we
 * also offer "open in your browser instead": the main process
 * intercepts a navigation to the login URL and opens it as a separate
 * popup window by default, or — when the link carries `?desktop=external`
 * — hands it to the system browser and then syncs the session back into
 * the app. The extra query param is ignored by the login route, so this
 * degrades to a plain login if ever clicked in a real browser.
 */
export function LoginButtons({ loginUrl }: { loginUrl: string }) {
  const [isDesktop, setIsDesktop] = useState(false);

  useEffect(() => {
    setIsDesktop(/electron/i.test(navigator.userAgent));
  }, []);

  const externalUrl =
    loginUrl + (loginUrl.includes("?") ? "&" : "?") + "desktop=external";

  return (
    <>
      <a href={loginUrl} className="btn-primary login-btn">
        <TwitchGlyph />
        <span>Login with Twitch{isDesktop ? " (popup window)" : ""}</span>
      </a>

      {isDesktop && (
        <a
          href={externalUrl}
          className="btn-ghost-link"
          style={{ marginTop: ".4rem" }}
        >
          Open login in your browser instead
        </a>
      )}
    </>
  );
}

function TwitchGlyph() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" aria-hidden focusable="false">
      <path
        fill="currentColor"
        d="M4.265 0L1.5 5.526v17.105h5.79V26h3.156l3.158-3.369h4.737L24 16.95V0H4.265zm17.473 15.79l-3.158 3.368h-5.789l-3.157 3.368v-3.368H4.79V2.105h16.948V15.79zM18.581 6.317h-2.105v6.317h2.105V6.317zm-5.262 0H11.21v6.317h2.105V6.317z"
      />
    </svg>
  );
}
