/* TradeOS order management on paper: the book → desks → agent sleeves → orders → fills.
   Agents generate target books; each agent with a desk and an allocation gets a sleeve of the desk's capital that tracks
   its target book. Orders are the differences, checked against the desk's limits and the book's kill switch, approved
   automatically or by a person, and filled on paper at the next session's open (or its close when approved after the open).
   Works in the browser (window.TradeOMS) and in Node (module.exports). Pure functions: no storage, no network. */
(function (root) {
  "use strict";
  const DEFAULT_LIMITS = { max_position_pct: 15, max_gross_pct: 100, max_dd_pct: 25, max_names: 60 };
  const COST_PCT = 0.1, SLIP_PCT = 0.05;       // per side, % of traded value
  const OMS_TYPES = new Set(["rule", "rotation", "watchlist"]); // options and intraday agents keep their own paper records
  const r2 = (x) => Math.round(x * 100) / 100;
  const limitsOf = (desk) => ({ ...DEFAULT_LIMITS, ...((desk && desk.limits) || {}) });
  const isWhole = (meta, s) => !meta || !meta[s] || meta[s].kind === "stock" || meta[s].kind == null;
  const roundQty = (q, whole) => whole ? (q < 0 ? -Math.floor(-q) : Math.floor(q)) : Math.round(q * 100) / 100;

  function emptyState(capital, date) {
    return { asof: date || null, sleeves: {}, desk_peaks: {}, book_peak: null, realized_total: 0, fills_total: 0 };
  }
  function sleeveEquity(sl, px) {
    let v = sl.cash;
    for (const [s, p] of Object.entries(sl.positions || {})) { const x = px(s); v += p.qty * (x != null ? x : p.last ?? p.avg); }
    return v;
  }
  function grossOf(sl, px) { let g = 0; for (const [s, p] of Object.entries(sl.positions || {})) { const x = px(s); g += Math.abs(p.qty * (x != null ? x : p.last ?? p.avg)); } return g; }

  // Capital follows the desks: a sleeve exists for every agent with a desk and an allocation; capital changes move cash in
  // or out; an agent that leaves (unassigned, retired, desk removed) is wound down and its sleeve closes once flat.
  function syncSleeves(state, desks, agents, date) {
    const D = Object.fromEntries(desks.map((d) => [d.id, d])), events = [];
    for (const a of agents) {
      const d = a.desk_id && D[a.desk_id], alloc = Number(a.alloc_pct) || 0;
      const live = d && alloc > 0 && a.status !== "retired";
      const cap = live ? Math.round(d.capital * alloc / 100) : 0;
      let sl = state.sleeves[a.id];
      if (!sl && !live) continue;
      if (!sl) { sl = state.sleeves[a.id] = { desk: d.id, capital: cap, cash: cap, positions: {}, peak: cap, realized: 0, opened: date, oms: OMS_TYPES.has(a.type), type: a.type, name: a.name }; events.push({ kind: "sleeve_opened", agent: a.id, desk: d.id, capital: cap }); continue; }
      sl.name = a.name; sl.type = a.type; sl.oms = OMS_TYPES.has(a.type);
      if (live) {
        if (sl.desk !== d.id) { events.push({ kind: "sleeve_moved", agent: a.id, from: sl.desk, to: d.id }); sl.desk = d.id; }
        if (cap !== sl.capital) { sl.cash += cap - sl.capital; sl.peak = (sl.peak || sl.capital) + (cap - sl.capital); events.push({ kind: "capital_changed", agent: a.id, from: sl.capital, to: cap }); sl.capital = cap; }
        sl.closing = false;
      } else if (!sl.closing) { sl.closing = true; events.push({ kind: "sleeve_closing", agent: a.id }); }
    }
    for (const [id, sl] of Object.entries(state.sleeves)) {
      if (!agents.some((a) => a.id === id) && !sl.closing) { sl.closing = true; events.push({ kind: "sleeve_closing", agent: id }); }
      if (sl.closing && !Object.keys(sl.positions || {}).length) { events.push({ kind: "sleeve_closed", agent: id, cash: r2(sl.cash) }); delete state.sleeves[id]; }
    }
    return events;
  }

  // What an agent wants to hold (shares/units per symbol), from its latest backtest state.
  //   rotation: its target weights on a rebalance day, otherwise its current holdings (so a new sleeve joins the book now)
  //   rule:     every symbol it holds or will buy at the next open gets its slice; pending exits go to zero
  // Returns {targets: {sym: qty}, rebalance: bool, scope: Set(symbols the agent speaks for)} or null.
  function agentTargets(agent, spec, res, sleeveEq, px, meta, nextSession) {
    if (!res || !OMS_TYPES.has(spec.type)) return null;
    const out = {}, scope = new Set();
    if (spec.type === "rotation") {
      const rs = res.rotState; if (!rs) return null;
      const due = rs.nextRebalance === nextSession;
      const w = due ? rs.nextTargets : Object.fromEntries(rs.holdings.map((h) => [h.symbol, rs.equity ? h.value / rs.equity : 0]));
      for (const h of rs.holdings) scope.add(h.symbol);
      for (const [s, x] of Object.entries(w || {})) { scope.add(s); const p = px(s); if (p > 0) out[s] = roundQty(sleeveEq * x * 0.995 / p, isWhole(meta, s)); }
      return { targets: out, rebalance: due, scope };
    }
    if (spec.type === "watchlist") { // today's calls on the names sent: BUY gets a slot, HOLD keeps what the sleeve has, SELL goes to zero
      for (const r of res.watch || []) {
        const s = r.symbol, p = px(s); scope.add(s);
        if (r.action === "SELL") out[s] = 0;
        else if (r.action === "HOLD") out[s] = r.qty;
        else if (r.action === "BUY" && p > 0) out[s] = roundQty(sleeveEq * spec.position_pct / 100 * 0.995 / p, isWhole(meta, s));
      }
      return { targets: out, rebalance: false, scope };
    }
    const states = res.states || [], n = Math.max(1, spec.symbols.length);
    const slice = spec.max_positions ? (spec.position_size_pct || 100 / spec.max_positions) / 100 : (spec.position_size_pct || 100) / 100 / n;
    for (const st of states) {
      const s = st.symbol; scope.add(s);
      const want = st.pendingSell ? 0 : st.pendingBuy && st.slotOk !== false ? 1 : st.inPosition ? 1 : 0;
      const p = px(s); if (!(p > 0)) continue;
      out[s] = want ? roundQty((spec.side === "short" ? -1 : 1) * sleeveEq * slice * 0.995 / p, isWhole(meta, s)) : 0;
    }
    return { targets: out, rebalance: false, scope };
  }

  // Orders for the next session. inputs:
  //   state, book {kill_switch, max_dd_pct}, desks [{id, capital, status, approval, limits}], agents [{id, type, desk_id, alloc_pct, status}],
  //   plans {agentId: agentTargets(...)}, px(sym) -> last close, meta, date (signal date), nextSession, band_pct
  function buildOrders({ state, book = {}, desks, agents, plans, px, meta, date, nextSession, band_pct = 2 }) {
    const D = Object.fromEntries(desks.map((d) => [d.id, d])), A = Object.fromEntries(agents.map((a) => [a.id, a]));
    const orders = [], events = [], deskUpdates = {};
    // desk equity, drawdown and status
    const deskEq = {};
    for (const sl of Object.values(state.sleeves)) deskEq[sl.desk] = (deskEq[sl.desk] || 0) + sleeveEquity(sl, px);
    let bookEq = 0; for (const v of Object.values(deskEq)) bookEq += v;
    const bookPeak = Math.max(state.book_peak || 0, bookEq), bookDD = bookPeak > 0 ? (bookEq / bookPeak - 1) * 100 : 0;
    let kill = !!book.kill_switch;
    if (!kill && book.max_dd_pct && bookDD <= -Math.abs(book.max_dd_pct)) { kill = true; events.push({ kind: "book_kill", severity: "critical", title: `Book drawdown ${bookDD.toFixed(1)}% breached the ${book.max_dd_pct}% limit`, detail: "Kill switch on: every position is being closed at the next open." }); }
    const status = {};
    for (const d of desks) {
      const L = limitsOf(d), eq = deskEq[d.id] || 0, peak = Math.max(state.desk_peaks[d.id] || 0, eq), dd = peak > 0 ? (eq / peak - 1) * 100 : 0;
      status[d.id] = kill ? "halted" : d.status || "active";
      if (status[d.id] === "active" && L.max_dd_pct && dd <= -Math.abs(L.max_dd_pct)) {
        status[d.id] = "halted"; deskUpdates[d.id] = { status: "halted", halted_reason: `drawdown ${dd.toFixed(1)}% breached ${L.max_dd_pct}%`, halted_at: date };
        events.push({ kind: "desk_halted", desk: d.id, severity: "critical", title: `${d.name} halted: drawdown ${dd.toFixed(1)}%`, detail: `Limit ${L.max_dd_pct}%. Its positions are being closed at the next open; set it active again to resume.` });
      }
    }
    // raw differences per sleeve
    const raw = [];
    for (const [aid, sl] of Object.entries(state.sleeves)) {
      const a = A[aid], st = status[sl.desk] || "active", eq = sleeveEquity(sl, px), cur = sl.positions || {};
      if (!sl.oms) continue;
      let tg = null, why = "";
      if (sl.closing || st === "halted") { tg = {}; why = sl.closing ? "agent left the desk" : "desk halted"; for (const s of Object.keys(cur)) tg[s] = 0; }
      else if (st === "paused" || (a && a.status !== "paper")) continue;
      else { const p = plans[aid]; if (!p) continue; tg = {}; for (const s of p.scope) tg[s] = p.targets[s] ?? 0; for (const s of Object.keys(cur)) if (!(s in tg) && !p.scope.has(s)) tg[s] = 0; why = p.rebalance ? "rebalance" : "signal"; }
      for (const [s, q] of Object.entries(tg)) {
        const have = cur[s]?.qty || 0, dq = r2(q - have), p = px(s); if (!(p > 0) || Math.abs(dq) < 1e-9) continue;
        const crosses = (have === 0) !== (q === 0) || Math.sign(have) !== Math.sign(q);
        if (!crosses && Math.abs(dq * p) < eq * band_pct / 100 && why !== "rebalance") continue; // drift, not a decision
        if (!crosses && why === "rebalance" && Math.abs(dq * p) < eq * 0.5 / 100) continue;
        raw.push({ agent: aid, desk: sl.desk, sym: s, have, target: q, dq, price: p, why });
      }
    }
    // desk limits: max names, max position (per symbol across the desk), max gross
    for (const d of desks) {
      const L = limitsOf(d), eq = deskEq[d.id] || 0, mine = raw.filter((o) => o.desk === d.id);
      if (!mine.length) continue;
      const pos = {}; for (const sl of Object.values(state.sleeves)) if (sl.desk === d.id) for (const [s, p] of Object.entries(sl.positions || {})) pos[s] = (pos[s] || 0) + p.qty * (px(s) ?? p.last ?? p.avg);
      const after = { ...pos }; for (const o of mine) after[o.sym] = (after[o.sym] || 0) + o.dq * o.price;
      // max position: clip buys that push a symbol above its limit
      const cap = eq * L.max_position_pct / 100;
      for (const o of mine) {
        const tot = after[o.sym]; if (Math.abs(tot) <= cap * 1.0001 || Math.sign(o.dq) !== Math.sign(tot)) continue;
        const over = Math.abs(tot) - cap, cut = Math.min(Math.abs(o.dq * o.price), over), nq = roundQty((Math.abs(o.dq * o.price) - cut) / o.price, isWhole(meta, o.sym)) * Math.sign(o.dq);
        o.check = (o.check || []).concat(`clipped to ${L.max_position_pct}% per name`); after[o.sym] -= (o.dq - nq) * o.price; o.dq = nq;
      }
      // max names
      const names = new Set(Object.keys(pos).filter((s) => Math.abs(pos[s]) > 0));
      for (const o of mine) if (o.have === 0 && o.dq !== 0 && !names.has(o.sym)) { if (names.size >= L.max_names) { o.check = (o.check || []).concat(`blocked: desk already holds ${L.max_names} names`); o.blocked = true; } else names.add(o.sym); }
      // max gross: scale new buying down proportionally
      let gross = 0; for (const v of Object.values(after)) gross += Math.abs(v);
      const gcap = eq * L.max_gross_pct / 100;
      if (gross > gcap * 1.0001) {
        const adds = mine.filter((o) => !o.blocked && Math.abs(o.have + o.dq) > Math.abs(o.have));
        const addVal = adds.reduce((t, o) => t + Math.abs(o.dq * o.price), 0), k = addVal > 0 ? Math.max(0, 1 - (gross - gcap) / addVal) : 1;
        for (const o of adds) { const nq = roundQty(o.dq * k, isWhole(meta, o.sym)); if (nq !== o.dq) { o.check = (o.check || []).concat(`scaled to ${Math.round(k * 100)}% (gross limit ${L.max_gross_pct}%)`); o.dq = nq; } }
      }
    }
    for (const o of raw) {
      if (!o.dq && !o.blocked) continue;
      const d = D[o.desk], manual = (d && d.approval) === "manual";
      const side = o.dq > 0 ? (o.have < 0 ? "COVER" : "BUY") : (o.have > 0 ? "SELL" : "SHORT");
      orders.push({ id: `${nextSession}_${o.agent}_${o.sym}`.replace(/[^A-Za-z0-9_\-.~:@+]/g, "-"), date, session: nextSession, desk: o.desk, agent: o.agent, sym: o.sym, side,
        qty: Math.abs(o.dq), price: r2(o.price), value: Math.round(Math.abs(o.dq * o.price)), from_qty: o.have, to_qty: r2(o.have + o.dq), reason: o.why, checks: o.check || [],
        status: o.blocked ? "blocked" : manual && o.why !== "desk halted" && o.why !== "agent left the desk" ? "pending" : "approved", auto: !manual, created_at: new Date().toISOString() });
    }
    return { orders, events, deskUpdates, deskEq, bookEq, bookDD, kill };
  }

  // Fill approved orders at the session's open (or its close when approved after the open, 09:15 IST).
  //   bar(sym, sessionIso) -> {date, open, close} for the first trading day on/after the session, or null if no data yet
  function fillOrders({ state, orders, bar, today }) {
    const fills = [], updates = [];
    for (const o of orders) {
      if (!["approved", "pending"].includes(o.status)) continue;
      const b = bar(o.sym, o.session);
      if (!b) { if (today && daysBetween(o.session, today) > 6) updates.push({ id: o.id, status: "expired", note: "no price data for the session" }); continue; }
      if (o.status === "pending") { updates.push({ id: o.id, status: "expired", note: "not approved before the session" }); continue; }
      const sl = state.sleeves[o.agent]; if (!sl) { updates.push({ id: o.id, status: "cancelled", note: "sleeve closed" }); continue; }
      const late = o.decided_at && o.decided_at > `${b.date}T03:45:00Z`; // after 09:15 IST on the fill day
      const ref = late ? b.close : b.open, sign = o.side === "BUY" || o.side === "COVER" ? 1 : -1;
      const fpx = r2(ref * (1 + sign * SLIP_PCT / 100)), q = o.qty * sign, fee = Math.abs(q * fpx) * COST_PCT / 100;
      const p = sl.positions[o.sym] || { qty: 0, avg: 0 };
      let realized = 0;
      if (p.qty !== 0 && Math.sign(q) !== Math.sign(p.qty)) { const closed = Math.min(Math.abs(q), Math.abs(p.qty)); realized = closed * (fpx - p.avg) * Math.sign(p.qty); }
      const nq = r2(p.qty + q);
      if (Math.abs(nq) < 1e-9) delete sl.positions[o.sym];
      else { const avg = Math.sign(nq) === Math.sign(p.qty) && Math.abs(nq) > Math.abs(p.qty) ? (p.avg * Math.abs(p.qty) + fpx * Math.abs(q)) / Math.abs(nq) : Math.sign(nq) !== Math.sign(p.qty) ? fpx : p.avg; sl.positions[o.sym] = { qty: nq, avg: r2(avg), last: fpx, since: p.qty ? p.since : b.date }; }
      sl.cash -= q * fpx + fee; sl.realized = r2((sl.realized || 0) + realized - fee); state.realized_total = r2((state.realized_total || 0) + realized - fee); state.fills_total = (state.fills_total || 0) + 1;
      const f = { id: o.id, fill_date: b.date, fill_price: fpx, fill_at: late ? "close" : "open", fee: r2(fee), realized: r2(realized) };
      fills.push({ ...o, ...f }); updates.push({ id: o.id, status: "filled", ...f });
    }
    return { fills, updates };
  }
  const daysBetween = (a, b) => Math.round((Date.parse(b) - Date.parse(a)) / 864e5);

  // Mark the book to the latest closes; keeps peaks for drawdowns. Returns the day's snapshot row for the history.
  function markBook(state, px, date) {
    const desks = {}, sleeves = {}; let total = 0, gross = 0;
    for (const [id, sl] of Object.entries(state.sleeves)) {
      for (const [s, p] of Object.entries(sl.positions || {})) { const x = px(s); if (x != null) p.last = x; }
      const eq = sleeveEquity(sl, px); sl.peak = Math.max(sl.peak || 0, eq); sleeves[id] = Math.round(eq);
      desks[sl.desk] = (desks[sl.desk] || 0) + eq; total += eq; gross += grossOf(sl, px);
    }
    for (const [d, v] of Object.entries(desks)) { state.desk_peaks[d] = Math.max(state.desk_peaks[d] || 0, v); desks[d] = Math.round(v); }
    state.book_peak = Math.max(state.book_peak || 0, total); state.asof = date;
    return { date, equity: Math.round(total), gross: Math.round(gross), desks, sleeves };
  }

  // Positions across the book with what they're worth now (for the Book view and the CIO)
  function bookPositions(state, px, meta) {
    const out = [];
    for (const [aid, sl] of Object.entries(state.sleeves)) for (const [s, p] of Object.entries(sl.positions || {})) {
      const x = px(s) ?? p.last ?? p.avg; out.push({ sym: s, agent: aid, desk: sl.desk, qty: p.qty, avg: p.avg, price: x, value: p.qty * x, pnl: p.qty * (x - p.avg), pnl_pct: p.avg ? (x / p.avg - 1) * 100 * Math.sign(p.qty) : 0, since: p.since, industry: meta?.[s]?.industry || meta?.[s]?.group || "" });
    }
    return out;
  }

  const api = { DEFAULT_LIMITS, COST_PCT, SLIP_PCT, OMS_TYPES, limitsOf, emptyState, sleeveEquity, syncSleeves, agentTargets, buildOrders, fillOrders, markBook, bookPositions };
  if (typeof module !== "undefined" && module.exports) module.exports = api; else root.TradeOMS = api;
})(typeof window !== "undefined" ? window : globalThis);
