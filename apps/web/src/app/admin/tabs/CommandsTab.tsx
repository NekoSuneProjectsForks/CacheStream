"use client";

import { useCallback, useEffect, useState } from "react";
import { apiJson } from "./util";
import type { CustomCommand, AutoModRule } from "@/lib/store";

/**
 * Commands + AutoMod tab.
 *
 * Custom commands fire from chat messages (`!trigger` or bare
 * `trigger`). AutoMod rules match on text and apply Twitch
 * moderation (delete / timeout / ban).
 */
export function CommandsTab() {
  const [commands, setCommands] = useState<CustomCommand[]>([]);
  const [rules, setRules] = useState<AutoModRule[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [c, r] = await Promise.all([apiJson("/api/commands"), apiJson("/api/automod")]);
      setCommands(c.commands || []);
      setRules(r.rules || []);
    } catch (e: any) { setError(e.message); }
  }, []);
  useEffect(() => { load(); }, [load]);

  // ---- Commands ----------------------------------------------
  const [draftCmd, setDraftCmd] = useState({
    trigger: "", response: "", cooldownS: 5, modOnly: false, subOnly: false, enabled: true,
  });
  const addCmd = async () => {
    setBusy("cmd-add"); setError(null);
    try {
      const { command } = await apiJson("/api/commands", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(draftCmd),
      });
      setCommands((s) => [...s, command]);
      setDraftCmd({ trigger: "", response: "", cooldownS: 5, modOnly: false, subOnly: false, enabled: true });
    } catch (e: any) { setError(e.message); }
    finally { setBusy(null); }
  };
  const toggleCmd = async (c: CustomCommand) => {
    setBusy("cmd-tog"); setError(null);
    try {
      const { command } = await apiJson(`/api/commands/${c.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: !c.enabled }),
      });
      setCommands((s) => s.map((x) => (x.id === c.id ? command : x)));
    } catch (e: any) { setError(e.message); }
    finally { setBusy(null); }
  };
  const removeCmd = async (id: string) => {
    setBusy("cmd-del"); setError(null);
    try {
      await apiJson(`/api/commands/${id}`, { method: "DELETE" });
      setCommands((s) => s.filter((x) => x.id !== id));
    } catch (e: any) { setError(e.message); }
    finally { setBusy(null); }
  };

  // ---- AutoMod -----------------------------------------------
  const [draftRule, setDraftRule] = useState<Partial<AutoModRule>>({
    matchType: "contains", pattern: "", action: "delete", durationS: 60, reason: "", enabled: true,
  });
  const addRule = async () => {
    setBusy("rule-add"); setError(null);
    try {
      const { rule } = await apiJson("/api/automod", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(draftRule),
      });
      setRules((s) => [...s, rule]);
      setDraftRule({ matchType: "contains", pattern: "", action: "delete", durationS: 60, reason: "", enabled: true });
    } catch (e: any) { setError(e.message); }
    finally { setBusy(null); }
  };
  const toggleRule = async (r: AutoModRule) => {
    setBusy("rule-tog"); setError(null);
    try {
      const { rule } = await apiJson(`/api/automod/${r.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: !r.enabled }),
      });
      setRules((s) => s.map((x) => (x.id === r.id ? rule : x)));
    } catch (e: any) { setError(e.message); }
    finally { setBusy(null); }
  };
  const removeRule = async (id: string) => {
    setBusy("rule-del"); setError(null);
    try {
      await apiJson(`/api/automod/${id}`, { method: "DELETE" });
      setRules((s) => s.filter((x) => x.id !== id));
    } catch (e: any) { setError(e.message); }
    finally { setBusy(null); }
  };

  return (
    <>
      {error && <div className="banner err">⚠ {error}</div>}

      <section className="card">
        <div className="card-head"><h2>Custom chat commands</h2></div>
        <p className="hint">
          Triggers match the first word of a chat message (with or without leading <code>!</code>).
        </p>
        <details className="hint" style={{ marginTop: 4 }}>
          <summary style={{ cursor: "pointer" }}>Available response variables</summary>
          <ul style={{ margin: "8px 0 0", padding: "0 0 0 18px", lineHeight: 1.6 }}>
            <li><code>{"{user}"}</code> — chatter's display name</li>
            <li><code>{"{channel}"}</code> — broadcaster login</li>
            <li><code>{"{arg1}"}</code>…<code>{"{argN}"}</code> — individual words after the trigger</li>
            <li><code>{"{args}"}</code> — everything after the trigger, joined</li>
            <li><code>{"{uptime}"}</code> — stream uptime, e.g. <em>1h 23m</em> (or <em>offline</em>)</li>
            <li><code>{"{viewers}"}</code> — current viewer count</li>
            <li><code>{"{game}"}</code> — current category</li>
            <li><code>{"{title}"}</code> — broadcast title</li>
            <li><code>{"{followers}"}</code> — total follower count</li>
          </ul>
          <div className="muted" style={{ marginTop: 6, fontSize: 11 }}>
            Live-stat variables ({"{uptime}"}, {"{viewers}"}, {"{game}"},
            {" "}{"{title}"}, {"{followers}"}) hit Helix with a 5-second snapshot
            cache. Commands that don't reference them are zero-cost.
          </div>
        </details>

        <ul className="list">
          {commands.length === 0 && <li className="muted">No commands yet — add one below.</li>}
          {commands.map((c) => (
            <li key={c.id} className="list-row">
              <div className="grow">
                <div className="row-title">
                  <code>{c.trigger}</code>
                  {c.modOnly && <span className="tag warn">mod only</span>}
                  {c.subOnly && <span className="tag">sub only</span>}
                  {!c.enabled && <span className="tag warn">disabled</span>}
                </div>
                <div className="row-sub">{c.response}</div>
                <div className="row-sub muted">cooldown {c.cooldownS}s</div>
              </div>
              <button className="btn-ghost sm" disabled={!!busy} onClick={() => toggleCmd(c)}>{c.enabled ? "Disable" : "Enable"}</button>
              <button className="btn-ghost sm" disabled={!!busy} onClick={() => removeCmd(c.id)}>×</button>
            </li>
          ))}
        </ul>

        <div className="row gap">
          <input className="input"      placeholder="trigger (e.g. discord)" value={draftCmd.trigger}  onChange={(e) => setDraftCmd({ ...draftCmd, trigger: e.target.value })} />
          <input className="input grow" placeholder="response"               value={draftCmd.response} onChange={(e) => setDraftCmd({ ...draftCmd, response: e.target.value })} />
          <input type="number" className="input sm" placeholder="cooldown s" value={draftCmd.cooldownS} onChange={(e) => setDraftCmd({ ...draftCmd, cooldownS: Number(e.target.value) || 0 })} />
          <label className="row" style={{ gap: 4 }}>
            <input type="checkbox" checked={draftCmd.modOnly} onChange={(e) => setDraftCmd({ ...draftCmd, modOnly: e.target.checked })} />
            <span>mod</span>
          </label>
          <label className="row" style={{ gap: 4 }}>
            <input type="checkbox" checked={draftCmd.subOnly} onChange={(e) => setDraftCmd({ ...draftCmd, subOnly: e.target.checked })} />
            <span>sub</span>
          </label>
          <button className="btn-primary" disabled={!!busy || !draftCmd.trigger || !draftCmd.response} onClick={addCmd}>Add</button>
        </div>
      </section>

      <section className="card">
        <div className="card-head"><h2>AutoMod rules</h2></div>
        <p className="hint">
          Rules evaluate every incoming chat message. First match wins.
          Actions use the Twitch moderation API; you must be the broadcaster (or moderator).
        </p>

        <ul className="list">
          {rules.length === 0 && <li className="muted">No rules yet.</li>}
          {rules.map((r) => (
            <li key={r.id} className="list-row">
              <div className="grow">
                <div className="row-title">
                  <span className="tag">{r.matchType}</span>
                  <code>{r.pattern}</code>
                  <span className="tag warn">{r.action}{r.action === "timeout" && r.durationS ? ` ${r.durationS}s` : ""}</span>
                  {!r.enabled && <span className="tag warn">disabled</span>}
                </div>
                {r.reason && <div className="row-sub">reason: {r.reason}</div>}
              </div>
              <button className="btn-ghost sm" disabled={!!busy} onClick={() => toggleRule(r)}>{r.enabled ? "Disable" : "Enable"}</button>
              <button className="btn-ghost sm" disabled={!!busy} onClick={() => removeRule(r.id)}>×</button>
            </li>
          ))}
        </ul>

        <div className="row gap">
          <select className="input sm" value={draftRule.matchType} onChange={(e) => setDraftRule({ ...draftRule, matchType: e.target.value as any })}>
            <option value="contains">contains</option>
            <option value="startswith">starts with</option>
            <option value="regex">regex</option>
          </select>
          <input className="input grow" placeholder="pattern" value={draftRule.pattern || ""} onChange={(e) => setDraftRule({ ...draftRule, pattern: e.target.value })} />
          <select className="input sm" value={draftRule.action} onChange={(e) => setDraftRule({ ...draftRule, action: e.target.value as any })}>
            <option value="delete">delete</option>
            <option value="timeout">timeout</option>
            <option value="ban">ban</option>
          </select>
          {draftRule.action === "timeout" && (
            <input type="number" className="input sm" placeholder="seconds" value={draftRule.durationS ?? 60} onChange={(e) => setDraftRule({ ...draftRule, durationS: Number(e.target.value) || 0 })} />
          )}
          <input className="input" placeholder="reason (opt)" value={draftRule.reason || ""} onChange={(e) => setDraftRule({ ...draftRule, reason: e.target.value })} />
          <button className="btn-primary" disabled={!!busy || !draftRule.pattern} onClick={addRule}>Add</button>
        </div>
      </section>
    </>
  );
}
