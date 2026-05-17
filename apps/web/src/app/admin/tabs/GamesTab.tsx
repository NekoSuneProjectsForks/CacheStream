"use client";

import { useCallback, useEffect, useState } from "react";
import { apiJson } from "./util";

interface PetState {
  name: string; species: string;
  hunger: number; happiness: number; energy: number;
  intelligence: number; aggression: number; morality: number;
  ageMinutes: number; evolution: number;
  lastAction: string | null; lastActor: string | null;
}
interface DCState {
  servers: number; serversMax: number; powerKw: number; powerKwCap: number;
  coolant: number; temperatureC: number; uptimePct: number; attacksActive: number;
  budget: number; reputation: number; tick: number;
}

/**
 * Games tab — minimal admin surface for the game scenes.
 *
 * The games auto-run inside the web container regardless of
 * whether the streamer is broadcasting their scene; this tab
 * lets you view current state, rename the pet, and reset.
 */
export function GamesTab() {
  const [pet, setPet] = useState<PetState | null>(null);
  const [dc, setDc]   = useState<DCState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy]   = useState<string | null>(null);
  const [newName, setNewName] = useState("");

  const load = useCallback(async () => {
    try {
      const [p, d] = await Promise.all([
        apiJson("/api/games/pet/state"),
        apiJson("/api/games/datacenter/state"),
      ]);
      setPet(p.state); setDc(d.state);
    } catch (e: any) { setError(e.message); }
  }, []);
  useEffect(() => { load(); const id = setInterval(load, 5_000); return () => clearInterval(id); }, [load]);

  const rename = async () => {
    if (!newName.trim()) return;
    setBusy("rename");
    try {
      await apiJson("/api/games/pet/rename", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: newName }),
      });
      setNewName(""); load();
    } catch (e: any) { setError(e.message); }
    finally { setBusy(null); }
  };

  const resetPet = async () => {
    if (!confirm("Reset pet to a fresh Datablob?")) return;
    setBusy("reset-pet");
    try { await apiJson("/api/games/pet/reset", { method: "POST" }); load(); }
    catch (e: any) { setError(e.message); }
    finally { setBusy(null); }
  };

  const resetDc = async () => {
    if (!confirm("Reset datacenter to defaults?")) return;
    setBusy("reset-dc");
    try { await apiJson("/api/games/datacenter/reset", { method: "POST" }); load(); }
    catch (e: any) { setError(e.message); }
    finally { setBusy(null); }
  };

  return (
    <>
      {error && <div className="banner err">⚠ {error}</div>}

      <section className="card">
        <div className="card-head">
          <h2>AI Pet</h2>
          <span className="badge ok">scene: <code>http://web:7788/scene/pet</code></span>
        </div>
        <p className="hint">
          Chat commands: <code>!feed</code> <code>!pet</code> <code>!play</code>{" "}
          <code>!teach &lt;word&gt;</code> (mod) <code>!sleep</code> <code>!insult</code> /{" "}
          <code>!hit</code>.
        </p>

        {pet && (
          <div className="metrics">
            <div className="metric"><div className="metric-label">Name</div><div className="metric-value">{pet.name}</div></div>
            <div className="metric"><div className="metric-label">Species</div><div className="metric-value">{pet.species} · evo {pet.evolution}</div></div>
            <div className="metric"><div className="metric-label">Age</div><div className="metric-value">{pet.ageMinutes}m</div></div>
            <div className="metric"><div className="metric-label">Hunger</div><div className="metric-value">{pet.hunger}</div></div>
            <div className="metric"><div className="metric-label">Happiness</div><div className="metric-value">{pet.happiness}</div></div>
            <div className="metric"><div className="metric-label">Intelligence</div><div className="metric-value">{pet.intelligence}</div></div>
            <div className="metric"><div className="metric-label">Aggression</div><div className="metric-value">{pet.aggression}</div></div>
            <div className="metric"><div className="metric-label">Morality</div><div className="metric-value">{pet.morality}</div></div>
            {pet.lastAction && <div className="metric"><div className="metric-label">Last action</div><div className="metric-value">{pet.lastAction} ({pet.lastActor})</div></div>}
          </div>
        )}

        <div className="row gap" style={{ marginTop: ".75rem" }}>
          <input className="input grow" placeholder="Rename pet…" value={newName} onChange={(e) => setNewName(e.target.value)} maxLength={24} />
          <button className="btn-primary" disabled={!!busy || !newName.trim()} onClick={rename}>Rename</button>
          <button className="btn-danger"  disabled={!!busy} onClick={resetPet}>Reset pet</button>
        </div>
      </section>

      <section className="card">
        <div className="card-head">
          <h2>Twitch Plays Datacenter</h2>
          <span className="badge ok">scene: <code>http://web:7788/scene/datacenter</code></span>
        </div>
        <p className="hint">
          Chat commands: <code>!add-server</code> <code>!defend</code>{" "}
          <code>!cool</code> <code>!power+</code> <code>!invest</code> <code>!restart</code>.
        </p>

        {dc && (
          <div className="metrics">
            <div className="metric"><div className="metric-label">Servers</div><div className="metric-value">{dc.servers}/{dc.serversMax}</div></div>
            <div className="metric"><div className="metric-label">Power</div><div className="metric-value">{dc.powerKw}/{dc.powerKwCap}kW</div></div>
            <div className="metric"><div className="metric-label">Temp</div><div className={`metric-value ${dc.temperatureC > 80 ? "tone-err" : ""}`}>{dc.temperatureC}°C</div></div>
            <div className="metric"><div className="metric-label">Coolant</div><div className="metric-value">{dc.coolant}%</div></div>
            <div className="metric"><div className="metric-label">Uptime</div><div className="metric-value">{dc.uptimePct}%</div></div>
            <div className="metric"><div className="metric-label">Attacks</div><div className={`metric-value ${dc.attacksActive ? "tone-err" : ""}`}>{dc.attacksActive}</div></div>
            <div className="metric"><div className="metric-label">Budget</div><div className="metric-value">${dc.budget}</div></div>
            <div className="metric"><div className="metric-label">Reputation</div><div className="metric-value">{dc.reputation}</div></div>
          </div>
        )}

        <div className="actions" style={{ marginTop: ".75rem" }}>
          <button className="btn-danger" disabled={!!busy} onClick={resetDc}>Reset datacenter</button>
        </div>
      </section>
    </>
  );
}
