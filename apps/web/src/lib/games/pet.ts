/**
 * AI Pet creature.
 *
 * One persistent creature per CacheStream instance. State lives in
 * the `pet_state` table; an in-process tick advances age, drains
 * hunger/energy, drifts personality, and decides whether the pet
 * evolves to a new form.
 *
 * Chat hooks:
 *   !feed             — hunger +20, happiness +5, morality drift +1
 *   !pet, !pat        — happiness +6, aggression -1
 *   !play             — happiness +8, energy -10, intelligence +1
 *   !teach <word>     — intelligence +3 (mod-only)
 *   !insult, !hit     — aggression +5, morality -2, happiness -8
 *   !sleep            — energy +25, happiness +2
 *
 * Stats are clamped 0..100. When intelligence crosses thresholds
 * (30, 60, 90) the pet evolves; species name and label change.
 * Mutations are recorded with timestamp + cause so the overlay
 * scene can flash them.
 *
 * Broadcasts updates over the in-process bus on topic "pet".
 */

import { getDb } from "../db";
import { publish, subscribe } from "../bus";

const TICK_MS = 15_000;

export interface PetState {
  name: string;
  species: string;
  hunger: number;
  happiness: number;
  energy: number;
  intelligence: number;
  aggression: number;
  morality: number;
  ageMinutes: number;
  evolution: number;
  mutations: Array<{ at: number; kind: string; detail: string }>;
  lastAction: string | null;
  lastActor: string | null;
  bornAt: number;
}

const SPECIES = [
  { tier: 0, name: "Datablob" },
  { tier: 1, name: "Loglurker" },
  { tier: 2, name: "Cachewyrm" },
  { tier: 3, name: "Stackwraith" },
];

function clamp(n: number): number { return Math.max(0, Math.min(100, n)); }

class Pet {
  private timer: NodeJS.Timeout | null = null;
  private busUnsub: (() => void) | null = null;

  init(): void {
    this._ensureRow();
    if (!this.timer) this.timer = setInterval(() => this.tick(), TICK_MS);
    if (!this.busUnsub) this.busUnsub = subscribe("chat", (msg) => this._onChat(msg as any));
  }

  state(): PetState {
    const row = getDb().prepare("SELECT * FROM pet_state WHERE id = 1").get() as any;
    return {
      name: row.name, species: row.species,
      hunger: row.hunger, happiness: row.happiness, energy: row.energy,
      intelligence: row.intelligence, aggression: row.aggression, morality: row.morality,
      ageMinutes: row.age_minutes, evolution: row.evolution,
      mutations: JSON.parse(row.mutations_json),
      lastAction: row.last_action, lastActor: row.last_actor,
      bornAt: row.born_at,
    };
  }

  rename(name: string): void {
    getDb().prepare("UPDATE pet_state SET name = ? WHERE id = 1").run(name.slice(0, 24));
    publish("pet", this.state());
  }

  reset(name = "Cache"): void {
    const now = Date.now();
    getDb().prepare("DELETE FROM pet_state WHERE id = 1").run();
    getDb().prepare(
      `INSERT INTO pet_state (id, name, species, hunger, happiness, energy,
                              intelligence, aggression, morality, age_minutes,
                              evolution, mutations_json, last_action, last_actor,
                              last_tick_at, born_at)
       VALUES (1, ?, ?, 50, 50, 50, 50, 50, 50, 0, 0, '[]', NULL, NULL, ?, ?)`
    ).run(name, SPECIES[0].name, now, now);
    publish("pet", this.state());
  }

  // ---- Internals --------------------------------------------------

  private _ensureRow(): void {
    const row = getDb().prepare("SELECT id FROM pet_state WHERE id = 1").get();
    if (!row) this.reset("Cache");
  }

  private tick(): void {
    const s = this.state();
    const now = Date.now();
    const lastTick = (getDb().prepare("SELECT last_tick_at FROM pet_state WHERE id = 1").get() as any).last_tick_at;
    const dtMin = lastTick ? Math.max(0, Math.round((now - lastTick) / 60_000)) : 0;

    s.ageMinutes += dtMin;
    s.hunger     = clamp(s.hunger - 1);
    s.energy     = clamp(s.energy - 1);
    s.happiness  = clamp(s.happiness + (s.hunger > 30 ? 0 : -2) + (s.energy > 30 ? 0 : -1));
    // Slow personality decay back toward 50.
    s.aggression = clamp(s.aggression + (s.aggression > 50 ? -1 : 0));

    // Evolution thresholds (intelligence-gated).
    const targetTier = s.intelligence >= 90 ? 3 : s.intelligence >= 60 ? 2 : s.intelligence >= 30 ? 1 : 0;
    if (targetTier > s.evolution) {
      s.evolution = targetTier;
      s.species = SPECIES[targetTier].name;
      s.mutations = [
        ...s.mutations.slice(-20),
        { at: now, kind: "evolution", detail: `evolved to ${s.species}` },
      ];
    }

    getDb().prepare(
      `UPDATE pet_state SET hunger=?, happiness=?, energy=?, intelligence=?, aggression=?, morality=?,
              age_minutes=?, evolution=?, species=?, mutations_json=?, last_tick_at=?
       WHERE id = 1`
    ).run(
      s.hunger, s.happiness, s.energy, s.intelligence, s.aggression, s.morality,
      s.ageMinutes, s.evolution, s.species, JSON.stringify(s.mutations), now
    );
    publish("pet", this.state());
  }

  private _onChat(msg: any): void {
    if (msg?.type !== "msg") return;
    const text = String(msg.message || "").trim().toLowerCase();
    if (!text) return;
    const head = (text.startsWith("!") ? text.slice(1) : text).split(/\s+/);
    const cmd = head[0];

    const apply = (mut: Partial<Record<keyof PetState, number>>, kind: string, detail: string) => {
      const cur = this.state();
      const next = { ...cur };
      for (const [k, v] of Object.entries(mut)) {
        (next as any)[k] = clamp(((cur as any)[k] || 0) + (v as number));
      }
      const mutations = [
        ...cur.mutations.slice(-30),
        { at: Date.now(), kind, detail: `${msg.name || msg.login}: ${detail}` },
      ];
      getDb().prepare(
        `UPDATE pet_state SET hunger=?, happiness=?, energy=?, intelligence=?, aggression=?, morality=?,
                last_action=?, last_actor=?, mutations_json=? WHERE id = 1`
      ).run(
        next.hunger, next.happiness, next.energy, next.intelligence, next.aggression, next.morality,
        detail, msg.name || msg.login || null, JSON.stringify(mutations)
      );
      publish("pet", this.state());
    };

    switch (cmd) {
      case "feed":   return apply({ hunger:   20, happiness:  5, morality: 1 }, "feed", "feed");
      case "pet":
      case "pat":    return apply({ happiness:  6, aggression: -1 },           "pet", "pet");
      case "play":   return apply({ happiness:  8, energy:    -10, intelligence: 1 }, "play", "play");
      case "teach":
        if (!msg.isMod) return;
        return apply({ intelligence: 3 }, "teach", `teach ${head.slice(1).join(" ").slice(0, 24)}`);
      case "insult":
      case "hit":    return apply({ aggression: 5, morality: -2, happiness: -8 }, "abuse", cmd);
      case "sleep":  return apply({ energy:    25, happiness:  2 },              "sleep", "sleep");
    }
  }
}

let _pet: Pet | null = null;
export function pet(): Pet {
  if (!_pet) { _pet = new Pet(); _pet.init(); }
  return _pet;
}
