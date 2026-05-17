"use client";

import { useEffect, useState } from "react";

interface Props {
  /** Target ISO timestamp the countdown elapses to. */
  to: string;
  /** Optional label above the digits. */
  label?: string;
  /** Hide the days cell entirely when the target is < 24h away. */
  compact?: boolean;
}

/**
 * Pure-CSS counter card. Re-renders once a second on the wall
 * clock; in headless Chromium that's effectively the next paint
 * cycle. Stops at 00:00:00 (never shows negatives).
 */
export function Countdown({ to, label, compact }: Props) {
  const target = new Date(to).getTime();
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  const ms = Math.max(0, target - now);
  const totalSec = Math.floor(ms / 1000);
  const d = Math.floor(totalSec / 86400);
  const h = Math.floor((totalSec % 86400) / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;

  const showDays = !compact && d > 0;

  return (
    <div className="cs-countdown" aria-label={label || "countdown"}>
      {showDays && <Cell n={d} lbl="DAYS" />}
      <Cell n={h} lbl="HOURS" />
      <Cell n={m} lbl="MIN" />
      <Cell n={s} lbl="SEC" />
    </div>
  );
}

function Cell({ n, lbl }: { n: number; lbl: string }) {
  return (
    <div className="cs-cell">
      <div className="cs-num">{String(n).padStart(2, "0")}</div>
      <div className="cs-lbl">{lbl}</div>
    </div>
  );
}
