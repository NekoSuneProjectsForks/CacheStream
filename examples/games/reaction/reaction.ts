/**
 * Example game · Reaction Race
 *
 * Tick loop pattern:
 *   - Every ~10s, decide whether to start a new round.
 *   - When a round starts, pick a random target word, publish a
 *     chat message ("GO! Type X"), and arm a ROUND_TIMEOUT_MS
 *     deadline.
 *   - When a chatter types the target word during the round, they
 *     win — credit their score, end the round, broadcast.
 *   - If nobody types it in time, the round ends with no winner.
 *
 * Copy to: apps/web/src/lib/games/reaction.ts
 *
 * Persistent state: reaction_scores table (login PK, wins INT).
 * Add the migration to apps/web/src/lib/db.ts — see the README.
 *
 * Boot from apps/web/src/instrumentation.ts:
 *
 *   const { reaction } = await import("./lib/games/reaction");
 *   try { reaction(); } catch (err) { console.warn("[boot] reaction init:", err); }
 */

import { getDb } from "../db";
import { publish, subscribe } from "../bus";
import { sendChat } from "../twitch/chat";

const TICK_MS               = 5_000;
const MIN_BETWEEN_ROUNDS_MS = 25_000;
const MAX_BETWEEN_ROUNDS_MS = 60_000;
const ROUND_TIMEOUT_MS      = 15_000;
const SCOREBOARD_SIZE       = 10;

// Picking a target from a short list of distinctive words keeps
// the game fair (no half-matches) and makes the chat reply easy
// to scan. Swap in your own theme if you want.
const WORDS = [
  "neon", "vault", "echo", "drift", "pulse", "ghost", "wire",
  "spark", "haze", "rift", "static", "burst", "void", "ember",
];

interface ChatEvent {
  type?: string;
  login?: string | null;
  name?: string | null;
  message?: string;
}

interface ScoreRow {
  login: string;
  name: string;
  wins: number;
  last_won_at: number;
}

export interface ReactionState {
  phase: "idle" | "active";
  target: string | null;           // the word to type
  startedAt: number | null;        // round start (ms)
  endsAt: number | null;           // round deadline (ms)
  lastWinner: { login: string; name: string; ms: number } | null;
  nextRoundAt: number;             // ms when we'll consider starting
  top: Array<{ login: string; name: string; wins: number }>;
}

class Reaction {
  private timer: NodeJS.Timeout | null = null;
  private booted = false;

  // Current round state (in-memory). Persistent only when nobody
  // is racing.
  private phase: "idle" | "active" = "idle";
  private target: string | null = null;
  private roundStartedAt: number | null = null;
  private roundEndsAt: number | null = null;
  private lastWinner: ReactionState["lastWinner"] = null;
  private nextRoundAt: number = Date.now() + 5_000;

  boot(): void {
    if (this.booted) return;
    this.booted = true;
    subscribe("chat", (msg) => this._onChat(msg as ChatEvent));
    this.timer = setInterval(() => this._tick(), TICK_MS);
    this._publish();
    console.log("[reaction] ready");
  }

  state(): ReactionState {
    return {
      phase: this.phase,
      target: this.phase === "active" ? this.target : null,
      startedAt: this.roundStartedAt,
      endsAt: this.roundEndsAt,
      lastWinner: this.lastWinner,
      nextRoundAt: this.nextRoundAt,
      top: this._topScores(),
    };
  }

  reset(): void {
    getDb().prepare("DELETE FROM reaction_scores").run();
    this.phase = "idle";
    this.target = null;
    this.roundStartedAt = null;
    this.roundEndsAt = null;
    this.lastWinner = null;
    this.nextRoundAt = Date.now() + 5_000;
    this._publish();
  }

  // ---- Internals ----------------------------------------------

  private _tick(): void {
    const now = Date.now();

    if (this.phase === "active") {
      if (now >= (this.roundEndsAt || 0)) {
        // Time ran out, no winner.
        this._endRound(null);
      }
      return;
    }

    // Idle — start a new round when nextRoundAt elapses.
    if (now >= this.nextRoundAt) {
      this._startRound();
    }
  }

  private _startRound(): void {
    const target = WORDS[Math.floor(Math.random() * WORDS.length)];
    this.phase = "active";
    this.target = target;
    this.roundStartedAt = Date.now();
    this.roundEndsAt = this.roundStartedAt + ROUND_TIMEOUT_MS;

    // Broadcast in chat. Failure is non-fatal (we still run the
    // round — viewers can see the prompt on the scene).
    try {
      sendChat(`🟢 REACTION ROUND — first to type "${target}" wins!`);
    } catch {}

    this._publish();
  }

  private _endRound(winner: { login: string; name: string; ms: number } | null): void {
    if (winner) {
      // Credit the win.
      const db = getDb();
      db.prepare(
        `INSERT INTO reaction_scores (login, name, wins, last_won_at)
           VALUES (?, ?, 1, ?)
         ON CONFLICT(login) DO UPDATE SET
           wins        = wins + 1,
           name        = excluded.name,
           last_won_at = excluded.last_won_at`
      ).run(winner.login, winner.name, Date.now());

      try {
        sendChat(`⚡ ${winner.name} won in ${(winner.ms / 1000).toFixed(2)}s.`);
      } catch {}
    } else {
      try {
        sendChat(`💤 nobody got "${this.target}" in time.`);
      } catch {}
    }

    this.phase = "idle";
    this.target = null;
    this.roundStartedAt = null;
    this.roundEndsAt = null;
    this.lastWinner = winner;
    this.nextRoundAt = Date.now() + randBetween(MIN_BETWEEN_ROUNDS_MS, MAX_BETWEEN_ROUNDS_MS);

    this._publish();
  }

  private _onChat(msg: ChatEvent): void {
    if (this.phase !== "active") return;
    if (msg.type !== "msg" || !msg.login || !msg.message) return;

    const text = msg.message.trim().toLowerCase();
    // Strict match: the message must BE the target word (no extra
    // text). Loosen to `text.includes(this.target)` if you want
    // "ooh, neon!" to count.
    if (text !== this.target) return;

    const ms = Date.now() - (this.roundStartedAt || Date.now());
    this._endRound({
      login: msg.login,
      name: msg.name || msg.login,
      ms,
    });
  }

  private _topScores(): ReactionState["top"] {
    const rows = getDb()
      .prepare(`SELECT login, name, wins FROM reaction_scores ORDER BY wins DESC LIMIT ?`)
      .all(SCOREBOARD_SIZE) as Pick<ScoreRow, "login" | "name" | "wins">[];
    return rows.map((r) => ({ login: r.login, name: r.name, wins: r.wins }));
  }

  private _publish(): void {
    publish("reaction", this.state());
  }
}

function randBetween(lo: number, hi: number): number {
  return lo + Math.floor(Math.random() * (hi - lo));
}

let _instance: Reaction | null = null;
export function reaction(): Reaction {
  if (!_instance) {
    _instance = new Reaction();
    _instance.boot();
  }
  return _instance;
}
