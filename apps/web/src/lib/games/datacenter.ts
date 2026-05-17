/**
 * Twitch Plays Datacenter.
 *
 * A NOC-aesthetic management sim driven by chat. State lives in
 * `datacenter_state`; tick runs every 10s and:
 *   - heats up under load, cools under coolant
 *   - if temperature > 60°C, uptime drops
 *   - random attacks spawn occasionally; chat must !defend
 *   - successful uptime over time adds budget
 *
 * Chat commands:
 *   !add-server      — spend 200 to expand capacity by one server
 *   !defend          — clears one active attack
 *   !cool            — drops temperature, costs coolant
 *   !power+          — bumps power cap by 5 (costs 100)
 *   !restart         — full system restart (uptime to 100, temp -10)
 *   !invest          — spends 100, +10 reputation
 */

import { getDb } from "../db";
import { publish, subscribe } from "../bus";

const TICK_MS = 10_000;
const LOG_CAP = 40;

export interface DatacenterState {
  servers: number;
  serversMax: number;
  powerKw: number;
  powerKwCap: number;
  coolant: number;
  temperatureC: number;
  uptimePct: number;
  attacksActive: number;
  budget: number;
  reputation: number;
  tick: number;
  log: Array<{ at: number; kind: string; text: string }>;
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

class Datacenter {
  private timer: NodeJS.Timeout | null = null;
  private busUnsub: (() => void) | null = null;

  init(): void {
    this._ensureRow();
    if (!this.timer) this.timer = setInterval(() => this.tick(), TICK_MS);
    if (!this.busUnsub) this.busUnsub = subscribe("chat", (msg) => this._onChat(msg as any));
  }

  state(): DatacenterState {
    const r = getDb().prepare("SELECT * FROM datacenter_state WHERE id = 1").get() as any;
    return {
      servers: r.servers, serversMax: r.servers_max,
      powerKw: r.power_kw, powerKwCap: r.power_kw_cap,
      coolant: r.coolant, temperatureC: r.temperature_c,
      uptimePct: r.uptime_pct, attacksActive: r.attacks_active,
      budget: r.budget, reputation: r.reputation, tick: r.tick,
      log: JSON.parse(r.log_json),
    };
  }

  reset(): void {
    getDb().prepare("DELETE FROM datacenter_state WHERE id = 1").run();
    this._ensureRow();
    publish("datacenter", this.state());
  }

  // ---- Internals --------------------------------------------------

  private _ensureRow(): void {
    const row = getDb().prepare("SELECT id FROM datacenter_state WHERE id = 1").get();
    if (row) return;
    getDb().prepare(
      `INSERT INTO datacenter_state (id, last_tick_at) VALUES (1, 0)`
    ).run();
  }

  private tick(): void {
    const s = this.state();

    // Power scales with servers.
    s.powerKw = clamp(8 + s.servers * 2, 0, s.powerKwCap);

    // Heat: grows with power, falls with coolant.
    const heatDelta = Math.round((s.powerKw / 4) - (s.coolant / 25) - (s.attacksActive * 1.5));
    s.temperatureC = clamp(s.temperatureC + heatDelta, 18, 110);
    s.coolant = clamp(s.coolant - 1, 0, 100);

    // Attacks decay slowly without intervention (some fail by themselves).
    if (s.attacksActive > 0 && Math.random() < 0.1) {
      s.attacksActive = Math.max(0, s.attacksActive - 1);
      s.log = [...s.log.slice(-LOG_CAP), { at: Date.now(), kind: "attack-fade", text: "attack expired" }];
    }

    // Uptime: drops when too hot or under attack, recovers slowly.
    let uptimeDelta = 0;
    if (s.temperatureC > 60) uptimeDelta -= 3;
    if (s.temperatureC > 80) uptimeDelta -= 6;
    if (s.attacksActive > 0) uptimeDelta -= 2 * s.attacksActive;
    if (uptimeDelta === 0 && s.uptimePct < 100) uptimeDelta = 1;
    s.uptimePct = clamp(s.uptimePct + uptimeDelta, 0, 100);

    // Random attack spawn (5% per tick when not already at the cap).
    if (s.attacksActive < 3 && Math.random() < 0.05) {
      s.attacksActive++;
      s.log = [...s.log.slice(-LOG_CAP), { at: Date.now(), kind: "attack", text: "⚠ incoming attack — type !defend" }];
    }

    // Budget growth from healthy uptime.
    if (s.uptimePct >= 95) s.budget += 10;
    else if (s.uptimePct >= 75) s.budget += 5;
    else s.budget = Math.max(0, s.budget - 3);

    s.tick += 1;

    getDb().prepare(
      `UPDATE datacenter_state SET
         servers=?, servers_max=?, power_kw=?, power_kw_cap=?,
         coolant=?, temperature_c=?, uptime_pct=?, attacks_active=?,
         budget=?, reputation=?, tick=?, log_json=?, last_tick_at=?
       WHERE id = 1`
    ).run(
      s.servers, s.serversMax, s.powerKw, s.powerKwCap,
      s.coolant, s.temperatureC, s.uptimePct, s.attacksActive,
      s.budget, s.reputation, s.tick, JSON.stringify(s.log.slice(-LOG_CAP)),
      Date.now()
    );
    publish("datacenter", this.state());
  }

  private _onChat(msg: any): void {
    if (msg?.type !== "msg") return;
    const text = String(msg.message || "").trim().toLowerCase();
    if (!text) return;
    const head = (text.startsWith("!") ? text.slice(1) : text).split(/\s+/);
    const cmd = head[0];
    const actor = msg.name || msg.login || "anon";
    const s = this.state();
    let logged: string | null = null;
    let changed = false;

    const log = (text: string, kind = "act") => {
      s.log = [...s.log.slice(-LOG_CAP), { at: Date.now(), kind, text: `${actor}: ${text}` }];
      logged = text;
      changed = true;
    };

    switch (cmd) {
      case "add-server":
      case "addserver":
        if (s.budget < 200) { log("can't afford server (need 200)"); break; }
        if (s.serversMax >= 12) { log("rack full"); break; }
        s.budget -= 200; s.servers += 1; s.serversMax += 1;
        log(`+1 server (now ${s.servers})`);
        break;
      case "defend":
        if (s.attacksActive === 0) { log("no active attacks"); break; }
        s.attacksActive -= 1; s.reputation = clamp(s.reputation + 1, 0, 100);
        log("defended attack");
        break;
      case "cool":
        if (s.coolant >= 100) { log("coolant already full"); break; }
        if (s.budget < 25) { log("can't afford coolant"); break; }
        s.budget -= 25; s.coolant = clamp(s.coolant + 30, 0, 100); s.temperatureC = clamp(s.temperatureC - 6, 18, 110);
        log("+30 coolant");
        break;
      case "power+":
      case "boostpower":
        if (s.budget < 100) { log("can't afford power upgrade"); break; }
        s.budget -= 100; s.powerKwCap += 5;
        log(`power cap +5 (now ${s.powerKwCap}kW)`);
        break;
      case "restart":
        s.uptimePct = 100; s.temperatureC = clamp(s.temperatureC - 10, 18, 110);
        log("system restart");
        break;
      case "invest":
        if (s.budget < 100) { log("can't afford investment"); break; }
        s.budget -= 100; s.reputation = clamp(s.reputation + 10, 0, 100);
        log("+10 reputation");
        break;
    }

    if (changed) {
      getDb().prepare(
        `UPDATE datacenter_state SET servers=?, servers_max=?, power_kw_cap=?,
                coolant=?, temperature_c=?, uptime_pct=?, attacks_active=?,
                budget=?, reputation=?, log_json=? WHERE id = 1`
      ).run(
        s.servers, s.serversMax, s.powerKwCap,
        s.coolant, s.temperatureC, s.uptimePct, s.attacksActive,
        s.budget, s.reputation, JSON.stringify(s.log.slice(-LOG_CAP))
      );
      publish("datacenter", this.state());
    }
  }
}

let _dc: Datacenter | null = null;
export function datacenter(): Datacenter {
  if (!_dc) { _dc = new Datacenter(); _dc.init(); }
  return _dc;
}
