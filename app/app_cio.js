  // ================================================================ CIO CONTROL: the fund the CIO sees and the changes it can make
  // Every change the CIO proposes is a typed action. It shows as a card the team applies with one tap, or applies at once
  // when the user told the CIO to go ahead. Actions are data validated here; nothing the model writes is executed as code.
  const FUND_ACTIONS = new Set(["create_desk", "update_desk", "close_desk", "assign_agent", "unassign_agent", "create_alert", "delete_alert", "watch", "unwatch", "set_book", "decide_orders"]);
  const numOr = (v, d) => { const n = Number(v); return Number.isFinite(n) ? n : d; };
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

  function fundBrief() {
    const b = bookSummary(), desks = [...S.desks.values()], agents = [...S.agents.values()].filter((a) => a.status !== "retired");
    const pend = S.ordersList.filter((o) => o.status === "pending"), nx = S.bookState?.next_session || nextSessionIso(), next = S.ordersList.filter((o) => o.session >= nx && o.status === "approved");
    const ordLine = (o) => `${o.id}: ${o.side} ${o.qty} ${o.sym} ≈₹${Math.round(o.value || 0)} (${deskName(o.desk)} / ${agentName(o.agent)}${o.checks?.length ? "; " + o.checks.join("; ") : ""})`;
    const pos = b ? b.positions.slice().sort((x, y) => Math.abs(y.value) - Math.abs(x.value)) : [];
    const bySec = {}; for (const p of pos) bySec[p.industry || "Other"] = (bySec[p.industry || "Other"] || 0) + p.value;
    return `THE FUND RIGHT NOW (paper; you run it)
Structure: CIO (you) → desks (sub-funds with capital, mandate, limits, approval rule, status active|paused|halted) → agents (strategies) with alloc_pct of their desk's capital. Each evening after the close, every paper-trading agent on an active desk turns its targets into orders for the next session, checked against the desk's limits (max_position_pct per name, max_gross_pct invested, max_dd_pct drawdown halt that flattens the desk, max_names). Manual desks' orders wait for the team's approval until 09:15 IST; auto desks' orders are approved. Fills are at the next open with costs. Options and intraday agents keep their own paper record and are mirrored into the book.
Book: ${b ? `equity ₹${Math.round(b.equity)} · capital ₹${Math.round(b.capital)} · since start ${b.since == null ? "–" : b.since.toFixed(2) + "%"} · today ${b.day == null ? "–" : b.day.toFixed(2) + "%"} · from peak ${b.dd.toFixed(2)}% · invested ₹${Math.round(b.gross)} (${b.equity ? (b.gross / b.equity * 100).toFixed(0) : 0}%) · cash ₹${Math.round(b.cash)} · marked ${b.asof || "–"}` : "no capital deployed yet"}. Kill switch: ${S.bookCfg?.kill_switch ? "ON (everything closes at the next open)" : "off"}${S.bookCfg?.max_dd_pct ? ` · book drawdown limit ${S.bookCfg.max_dd_pct}%` : ""}.
Desks: ${desks.length ? JSON.stringify(desks.map((d) => { const f = deskFigs(b, d.id); return { desk_id: d.id, name: d.name, mandate: d.mandate || "", capital: d.capital, status: d.status || "active", approval: d.approval || "auto", limits: O.limitsOf(d), equity: Math.round(f.equity) || null, invested: Math.round(f.gross) || 0, agents: agents.filter((a) => a.desk_id === d.id).map((a) => ({ agent_id: a.id, name: a.name, alloc_pct: a.alloc_pct || 0, status: a.status })) }; })) : "none yet"}
Agents not on a desk: ${JSON.stringify(agents.filter((a) => !a.desk_id || !S.desks.has(a.desk_id)).map((a) => ({ agent_id: a.id, name: a.name, type: a.type, status: a.status, cagr_pct: a.headline?.cagr, max_dd_pct: a.headline?.mdd })))}
Positions (${pos.length}, largest first): ${pos.slice(0, 60).map((p) => `${p.sym} ${p.qty}@${p.avg.toFixed(1)} now ${Number(p.price).toFixed(1)} ₹${Math.round(p.value)} ${p.pnl_pct >= 0 ? "+" : ""}${p.pnl_pct.toFixed(1)}% [${deskName(p.desk)}]`).join("; ") || "none"}
Exposure by industry: ${Object.entries(bySec).sort((x, y) => Math.abs(y[1]) - Math.abs(x[1])).slice(0, 12).map(([k, v]) => `${k} ₹${Math.round(v)}`).join("; ") || "none"}
Orders awaiting approval (${pend.length}): ${pend.slice(0, 40).map(ordLine).join(" | ") || "none"}
Approved for ${nx} (${next.length}): ${next.slice(0, 30).map(ordLine).join(" | ") || "none"}
Alert rules: ${JSON.stringify(S.alertRules.map((a) => ({ alert_id: a.id, name: a.name, kind: a.kind, sym: a.sym, expr: a.expr, scope: a.scope, id_ref: a.id_ref, pct: a.pct, active: a.active !== false })))}
Recent alerts: ${S.alertEvents.slice(0, 12).map((e) => `${e.date} ${e.title}`).join(" | ") || "none"}
Watchlist: ${(S.watch || DEFAULT_WATCH).join(", ")}

CONTROLLING THE FUND — put changes in "actions" (they show as cards; the team taps Apply, or they apply at once when you set "apply_now": true):
{"type":"create_desk","key":"short ref for later actions in this reply","name":"...","mandate":"one sentence","capital":2500000,"approval":"auto"|"manual","limits":{"max_position_pct":15,"max_gross_pct":100,"max_dd_pct":25,"max_names":60}}
{"type":"update_desk","desk_id":"... or a key","changes":{"name","mandate","capital","approval","status":"active"|"paused"|"halted","limits":{only the limits that change}},"note":"why"}
{"type":"close_desk","desk_id":"...","note":"why"}   (its agents leave and its positions close at the next open)
{"type":"assign_agent","agent_id":"...","desk_id":"existing id or a key from create_desk","alloc_pct":30}   (also use to change an allocation)
{"type":"unassign_agent","agent_id":"..."}
{"type":"create_alert","alert":{"kind":"price","sym":"RELIANCE","expr":"close < 1250","mode":"cross"|"while","name":"...","severity":"info"|"warning"|"critical"} or {"kind":"drawdown"|"move","scope":"book"|"desk"|"agent","id_ref":"desk or agent id (not for book)","pct":10} or {"kind":"signal","agent_id":"..."} or {"kind":"news","sym":"...","query":"order|acquisition"} or {"kind":"results","sym":"...","days":7}}
{"type":"delete_alert","alert_id":"..."}
{"type":"watch","syms":["..."]} / {"type":"unwatch","syms":["..."]}
{"type":"set_book","kill_switch":true|false,"max_dd_pct":number|null,"note":"why"}
{"type":"decide_orders","order_ids":["ids from the list above"] or "all_pending","decision":"approved"|"rejected","note":"why"}
Rules: capital sums are rupees. Allocations in a desk should add to ≤100%. To turn an agent on in the book it must be paper trading (set_status "paper") AND assigned to an active desk. Set "apply_now": true only when the user told you to make the change ("do it", "set it up", "go ahead", "approve them"); otherwise propose and let them apply. Always explain the structure in "reply" (mandates, capital split, limits, why) — the cards carry the mechanics.`;
  }

  // Clean one action from the model: right type, known ids, sane numbers. Returns null when it can't apply.
  function normFundAction(a, keys) {
    if (!a || !FUND_ACTIONS.has(a.type)) return null;
    const deskRef = (id) => id && (S.desks.has(id) || keys.has(id)) ? String(id) : null;
    const lim = (l) => { const o = {}; if (!l || typeof l !== "object") return o;
      if (l.max_position_pct != null) o.max_position_pct = clamp(numOr(l.max_position_pct, 15), 0.5, 100); if (l.max_gross_pct != null) o.max_gross_pct = clamp(numOr(l.max_gross_pct, 100), 1, 400);
      if (l.max_dd_pct != null) o.max_dd_pct = clamp(numOr(l.max_dd_pct, 25), 1, 95); if (l.max_names != null) o.max_names = clamp(Math.trunc(numOr(l.max_names, 60)), 1, 1000); return o; };
    const note = String(a.note || "").slice(0, 300);
    switch (a.type) {
      case "create_desk": { const key = String(a.key || a.name || "desk").slice(0, 40); keys.add(key);
        return { type: a.type, key, name: String(a.name || "New desk").slice(0, 60), mandate: String(a.mandate || "").slice(0, 300), capital: Math.max(0, Math.round(numOr(a.capital, 0))), approval: a.approval === "manual" ? "manual" : "auto", limits: { ...DESK_PRESETS, ...lim(a.limits) } }; }
      case "update_desk": { const id = deskRef(a.desk_id); if (!id) return null; const c = a.changes || {}, ch = {};
        if (c.name != null) ch.name = String(c.name).slice(0, 60); if (c.mandate != null) ch.mandate = String(c.mandate).slice(0, 300); if (c.capital != null) ch.capital = Math.max(0, Math.round(numOr(c.capital, 0)));
        if (c.approval != null) ch.approval = c.approval === "manual" ? "manual" : "auto"; if (["active", "paused", "halted"].includes(c.status)) ch.status = c.status; if (c.limits) ch.limits = lim(c.limits);
        return Object.keys(ch).length ? { type: a.type, desk_id: id, changes: ch, note } : null; }
      case "close_desk": { const id = deskRef(a.desk_id); return id ? { type: a.type, desk_id: id, note } : null; }
      case "assign_agent": { if (!S.agents.has(a.agent_id)) return null; const id = deskRef(a.desk_id); if (!id) return null; return { type: a.type, agent_id: a.agent_id, desk_id: id, alloc_pct: clamp(numOr(a.alloc_pct, 0), 0, 100) }; }
      case "unassign_agent": return S.agents.has(a.agent_id) ? { type: a.type, agent_id: a.agent_id } : null;
      case "create_alert": { const x = a.alert || {}, out = { kind: x.kind, name: String(x.name || "").slice(0, 80), severity: ["info", "warning", "critical"].includes(x.severity) ? x.severity : "warning" };
        if (x.kind === "price") { out.sym = E.symKey(String(x.sym || "")); out.expr = String(x.expr || ""); out.mode = x.mode === "while" ? "while" : "cross"; if (!S.man.symbols[out.sym]) return null; try { E.validate(out.expr); } catch (e) { return null; } }
        else if (x.kind === "drawdown" || x.kind === "move") { out.scope = ["book", "desk", "agent"].includes(x.scope) ? x.scope : "book"; if (out.scope !== "book") { out.id_ref = out.scope === "desk" ? deskRef(x.id_ref) : (S.agents.has(x.id_ref) ? x.id_ref : null); if (!out.id_ref) return null; } out.pct = Math.abs(numOr(x.pct, x.kind === "drawdown" ? 10 : 2)); }
        else if (x.kind === "signal") { if (!S.agents.has(x.agent_id)) return null; out.agent_id = x.agent_id; }
        else if (x.kind === "news") { out.sym = x.sym ? E.symKey(String(x.sym)) : null; out.query = x.query ? String(x.query).slice(0, 120) : null; }
        else if (x.kind === "results") { out.sym = E.symKey(String(x.sym || "")); if (!S.man.symbols[out.sym]) return null; out.days = clamp(Math.trunc(numOr(x.days, 7)), 1, 60); }
        else return null;
        return { type: a.type, alert: out }; }
      case "delete_alert": return S.alertRules.some((r) => r.id === a.alert_id) ? { type: a.type, alert_id: a.alert_id } : null;
      case "watch": case "unwatch": { const syms = (Array.isArray(a.syms) ? a.syms : [a.sym]).map((s) => E.symKey(String(s || ""))).filter((s) => S.man.symbols[s]).slice(0, 50); return syms.length ? { type: a.type, syms } : null; }
      case "set_book": { const o = { type: a.type, note }; if (typeof a.kill_switch === "boolean") o.kill_switch = a.kill_switch; if (a.max_dd_pct === null || a.max_dd_pct != null) o.max_dd_pct = a.max_dd_pct == null ? null : clamp(numOr(a.max_dd_pct, 20), 1, 95); return Object.keys(o).length > 2 ? o : null; }
      case "decide_orders": { const pend = S.ordersList.filter((o) => o.status === "pending").map((o) => o.id); const ids = a.order_ids === "all_pending" ? pend : (Array.isArray(a.order_ids) ? a.order_ids : []).filter((id) => pend.includes(id));
        return ids.length ? { type: a.type, order_ids: ids, decision: a.decision === "rejected" ? "rejected" : "approved", note } : null; }
    }
    return null;
  }
  function fundActionsFrom(list) {
    const keys = new Set(), raw = (Array.isArray(list) ? list : []).filter((a) => a && FUND_ACTIONS.has(a.type));
    const out = []; for (const a of raw.filter((x) => x.type === "create_desk").concat(raw.filter((x) => x.type !== "create_desk"))) { const n = normFundAction(a, keys); if (n) out.push(n); }
    return out.slice(0, 40);
  }
  const deskLabel = (id, m) => S.desks.get(id)?.name || (m?.actions || []).find((x) => x.type === "create_desk" && x.key === id)?.name || id;
  function fundActionText(a, m) {
    const L = (l) => Object.entries(l || {}).map(([k, v]) => `${{ max_position_pct: "per name", max_gross_pct: "invested", max_dd_pct: "halt at drawdown", max_names: "names" }[k] || k} ${v}${k === "max_names" ? "" : "%"}`).join(" · ");
    switch (a.type) {
      case "create_desk": return [`New desk: ${a.name}`, `${inrShort(a.capital)} · ${a.approval === "manual" ? "you approve orders" : "orders auto-approved"} · ${L(a.limits)}${a.mandate ? ` — ${a.mandate}` : ""}`];
      case "update_desk": { const c = a.changes; return [`Change desk: ${deskLabel(a.desk_id, m)}`, [c.name && `name “${c.name}”`, c.capital != null && `capital ${inrShort(c.capital)}`, c.approval && (c.approval === "manual" ? "you approve orders" : "orders auto-approved"), c.status && `status ${c.status}${c.status === "halted" ? " (positions close at the next open)" : ""}`, c.limits && L(c.limits), c.mandate && `mandate: ${c.mandate}`].filter(Boolean).join(" · ") + (a.note ? ` — ${a.note}` : "")]; }
      case "close_desk": return [`Close desk: ${deskLabel(a.desk_id, m)}`, `Its agents leave and its positions close at the next open${a.note ? ` — ${a.note}` : ""}`];
      case "assign_agent": { const ag = S.agents.get(a.agent_id); return [`${ag?.desk_id === a.desk_id ? "Re-allocate" : "Assign"} ${ag?.name || a.agent_id}`, `${deskLabel(a.desk_id, m)} · ${a.alloc_pct}% of the desk${ag && ag.status !== "paper" ? ` · it is ${ag.status}, so it trades once set to paper` : ""}`]; }
      case "unassign_agent": return [`Take ${agentName(a.agent_id)} off its desk`, "Its positions close at the next open"];
      case "create_alert": { const x = a.alert, who = x.scope === "desk" ? `The ${deskLabel(x.id_ref, m)} desk` : x.scope === "agent" ? agentName(x.id_ref) : x.scope === "book" ? "The book" : null;
        return [`New alert${x.name ? `: ${x.name}` : ""}`, who && (x.kind === "drawdown" || x.kind === "move") ? `${who} ${x.kind === "drawdown" ? `falls ${x.pct}% from its peak` : `moves ${x.pct}% in a day`}` : alertSummary(x)]; }
      case "delete_alert": return ["Delete alert", (() => { const r = S.alertRules.find((x) => x.id === a.alert_id); return r ? (r.name || alertSummary(r)) : a.alert_id; })()];
      case "watch": return ["Add to the watchlist", a.syms.join(", ")];
      case "unwatch": return ["Remove from the watchlist", a.syms.join(", ")];
      case "set_book": return ["Book controls", [a.kill_switch === true && "kill switch ON — every position closes at the next open", a.kill_switch === false && "kill switch off", "max_dd_pct" in a && (a.max_dd_pct == null ? "no book drawdown limit" : `book drawdown limit ${a.max_dd_pct}%`)].filter(Boolean).join(" · ") + (a.note ? ` — ${a.note}` : "")];
      case "decide_orders": return [`${a.decision === "approved" ? "Approve" : "Reject"} ${a.order_ids.length} order${a.order_ids.length > 1 ? "s" : ""}`, a.order_ids.slice(0, 6).map((id) => { const o = S.ordersList.find((x) => x.id === id); return o ? `${o.side} ${o.qty} ${o.sym}` : id; }).join(", ") + (a.order_ids.length > 6 ? "…" : "") + (a.note ? ` — ${a.note}` : "")];
    }
    return [a.type, ""];
  }
  // Apply one action. `ctx.keys` maps create_desk keys to the new desk ids so later actions in the same reply can use them.
  async function applyFundAction(a, ctx) {
    const did = (id) => ctx.keys[id] || id, stamp = { updated_at: nowIso(), updated_by: S.uid };
    switch (a.type) {
      case "create_desk": { const id = newId("d"); await S.db.doc(`desks/${id}`).set({ name: a.name, mandate: a.mandate, capital: a.capital, approval: a.approval, limits: a.limits, status: "active", created_at: nowIso(), created_by: S.uid, by_cio: true }); ctx.keys[a.key] = id; return { created_id: id }; }
      case "update_desk": { const d = S.desks.get(did(a.desk_id)); const ch = { ...a.changes }; if (ch.limits) ch.limits = { ...(d?.limits || {}), ...ch.limits }; if (ch.status === "active") ch.halted_reason = null;
        await S.db.doc(`desks/${did(a.desk_id)}`).update({ ...ch, ...stamp }); return {}; }
      case "close_desk": { const id = did(a.desk_id); for (const ag of [...S.agents.values()].filter((x) => x.desk_id === id)) await patchAgent(ag.id, { desk_id: null, alloc_pct: 0 }); await S.db.doc(`desks/${id}`).delete(); return {}; }
      case "assign_agent": await patchAgent(a.agent_id, { desk_id: did(a.desk_id), alloc_pct: a.alloc_pct }); return {};
      case "unassign_agent": await patchAgent(a.agent_id, { desk_id: null, alloc_pct: 0 }); return {};
      case "create_alert": { const al = { ...a.alert }; if (al.id_ref) al.id_ref = did(al.id_ref); await S.db.doc(`alerts/${newId("al")}`).set({ ...al, active: true, created_by: S.uid, created_at: nowIso(), by_cio: true }); return {}; }
      case "delete_alert": await S.db.doc(`alerts/${a.alert_id}`).delete(); return {};
      case "watch": { const cur = (S.watch || DEFAULT_WATCH).filter((s) => S.man.symbols[s]); await saveWatch([...cur, ...a.syms.filter((s) => !cur.includes(s))]); return {}; }
      case "unwatch": await saveWatch((S.watch || DEFAULT_WATCH).filter((s) => !a.syms.includes(s))); return {};
      case "set_book": { const c = { ...S.bookCfg }; if ("kill_switch" in a) { c.kill_switch = a.kill_switch; c.kill_reason = a.kill_switch ? `CIO, applied by ${nameOf(S.uid)}${a.note ? ": " + a.note : ""}` : null; c.kill_at = nowIso(); } if ("max_dd_pct" in a) c.max_dd_pct = a.max_dd_pct; await S.db.doc("book/config").set(c); return {}; }
      case "decide_orders": { let n = 0; for (const id of a.order_ids) { const o = S.ordersList.find((x) => x.id === id); if (!o || o.status !== "pending") continue; await S.db.doc(`orders/${id}`).update({ status: a.decision, decided_by: S.uid, decided_at: nowIso(), note: a.note ? `CIO: ${a.note}` : "on the CIO's advice" }); n++; } return { n }; }
    }
    return {};
  }
  // Apply a message's fund actions in order (desks first), marking each done. Used by Apply all and by apply_now.
  async function applyFundActions(m, only) {
    const ctx = { keys: {} }; for (const x of m.actions || []) if (x.type === "create_desk" && x.created_id) ctx.keys[x.key] = x.created_id;
    let acts = (m.actions || []).map((x) => ({ ...x })), n = 0, err = null;
    for (const a of acts) {
      if (!FUND_ACTIONS.has(a.type) || a.done || (only && a.id !== only)) continue;
      try { Object.assign(a, await applyFundAction(a, ctx), { done: true, done_at: nowIso() }); n++; }
      catch (e) { a.error = String(e.message || e).slice(0, 200); err = e; if (only) break; }
    }
    try { await mainCol().doc(m.id).update({ actions: acts }); } catch (e) { /* view-only */ }
    if (n) toast(`${n} change${n > 1 ? "s" : ""} applied`); if (err) toast(err.message || String(err));
    return n;
  }
  function fundActionCard(m, a) {
    const [title, detail] = fundActionText(a, m), aid = `${m.id}_${a.id}`;
    const icon = /desk/.test(a.type) ? "i-desks" : /agent/.test(a.type) ? "i-agent" : /alert/.test(a.type) ? "i-alerts" : /watch/.test(a.type) ? "i-markets" : a.type === "set_book" ? "i-stop" : "i-orders";
    const risky = a.type === "close_desk" || (a.type === "set_book" && a.kill_switch === true) || (a.type === "update_desk" && a.changes.status === "halted");
    return `<div class="ctl${a.done ? " done" : ""}${risky ? " risky" : ""}"><svg class="ico"><use href="#${icon}"/></svg><div class="txt"><b>${esc(title)}</b><span>${esc(detail)}</span>${a.error ? `<span class="flag bad">${esc(a.error)}</span>` : ""}</div>
      ${a.done ? '<span class="pill plain" style="background:var(--up-soft);color:var(--up)">Applied</span>' : S.readOnly ? "" : `<button class="btn small ${risky ? "danger" : "ghost"}" type="button" data-fapply="${esc(aid)}">Apply</button>`}</div>`;
  }
  function fundActionsBlock(m) {
    const acts = (m.actions || []).filter((a) => FUND_ACTIONS.has(a.type)); if (!acts.length) return "";
    const open = acts.filter((a) => !a.done).length;
    return `<section class="proposal ctlset"><div class="row"><span class="eyebrow">Changes to the fund</span><span class="grow"></span>${open > 1 && !S.readOnly ? `<button class="btn small" type="button" data-fapplyall="${esc(m.id)}">Apply all ${open}</button>` : !open ? '<span class="xs muted">All applied</span>' : ""}</div>${acts.map((a) => fundActionCard(m, a)).join("")}</section>`;
  }
  document.addEventListener("click", async (e) => {
    const one = e.target.closest("[data-fapply]"), all = e.target.closest("[data-fapplyall]"); if (!one && !all) return;
    const b = one || all; if (b.disabled) return; b.disabled = true;
    if (one) { const [mid, aid] = splitId(one.dataset.fapply), m = S.mainMsgs.find((x) => x.id === mid); if (m) await applyFundActions(m, aid); }
    else { const m = S.mainMsgs.find((x) => x.id === all.dataset.fapplyall); if (m) await applyFundActions(m); }
    if (b.isConnected) b.disabled = false;
  });
