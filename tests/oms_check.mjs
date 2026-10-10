// Checks for the paper order manager (lab/oms.js): sleeves, targets, limits, approvals, fills, marking.
//   node tests/oms_check.mjs
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const O = require("../lab/oms.js");
let bad = 0; const ok = (c, m) => { console.log((c ? "ok   " : "FAIL ") + m); if (!c) bad++; };
const near = (a, b, t = 1e-6) => Math.abs(a - b) <= t * Math.max(1, Math.abs(b));

const meta = { AAA: { kind: "stock" }, BBB: { kind: "stock" }, CCC: { kind: "stock" }, NIFTY: { kind: "index" } };
const P = { AAA: 100, BBB: 200, CCC: 50, NIFTY: 20000 };
const px = (s) => P[s] ?? null;
const desks = [{ id: "d1", name: "Equity", capital: 1_000_000, status: "active", approval: "auto", limits: { max_position_pct: 20, max_gross_pct: 100, max_dd_pct: 20 } },
  { id: "d2", name: "Manual", capital: 500_000, status: "active", approval: "manual", limits: { max_position_pct: 100 } }];
const agents = [{ id: "a1", name: "Rot", type: "rotation", status: "paper", desk_id: "d1", alloc_pct: 60 }, { id: "a2", name: "Rule", type: "rule", status: "paper", desk_id: "d1", alloc_pct: 40 },
  { id: "a3", name: "Opt", type: "option_selling", status: "paper", desk_id: "d2", alloc_pct: 50 }, { id: "a4", name: "Rule2", type: "rule", status: "paper", desk_id: "d2", alloc_pct: 50 }];
const st = O.emptyState(0, "2026-10-01");
const ev = O.syncSleeves(st, desks, agents, "2026-10-01");
ok(Object.keys(st.sleeves).length === 4 && st.sleeves.a1.capital === 600000 && st.sleeves.a2.cash === 400000, "sleeves open with desk capital × allocation");
ok(st.sleeves.a3.oms === false && st.sleeves.a1.oms === true, "options agents are mirrored, not traded");
ok(ev.filter((e) => e.kind === "sleeve_opened").length === 4, "sleeve events reported");

// rotation targets: not a rebalance day -> current holdings; rebalance day -> next targets
const rotRes = { rotState: { holdings: [{ symbol: "AAA", value: 50, qty: 1 }, { symbol: "BBB", value: 50, qty: 1 }], equity: 100, nextTargets: { BBB: 0.5, CCC: 0.5 }, nextRebalance: "2026-11-02" } };
let p1 = O.agentTargets(agents[0], { type: "rotation" }, rotRes, 600000, px, meta, "2026-10-02");
ok(!p1.rebalance && p1.targets.AAA === Math.floor(600000 * 0.5 * 0.995 / 100) && !("CCC" in p1.targets), "rotation joins the current book between rebalances");
let p2 = O.agentTargets(agents[0], { type: "rotation" }, { rotState: { ...rotRes.rotState, nextRebalance: "2026-10-02" } }, 600000, px, meta, "2026-10-02");
ok(p2.rebalance && p2.targets.CCC > 0 && !("AAA" in p2.targets) && p2.scope.has("AAA"), "rotation uses next targets on its rebalance day and drops old names");
// rule targets
const ruleRes = { states: [{ symbol: "AAA", inPosition: true, pendingSell: true }, { symbol: "BBB", pendingBuy: true }, { symbol: "CCC" }] };
const p3 = O.agentTargets(agents[1], { type: "rule", symbols: ["AAA", "BBB", "CCC"], side: "long", position_size_pct: 100 }, ruleRes, 400000, px, meta, "2026-10-02");
ok(p3.targets.AAA === 0 && p3.targets.BBB === Math.floor(400000 / 3 * 0.995 / 200) && p3.targets.CCC === 0, "rule: exits to zero, entries get their slice");

// orders: auto desk approved, limits clip, manual desk pending
const b1 = O.buildOrders({ state: st, desks, agents, plans: { a1: p2, a2: p3, a4: { targets: { CCC: 4000 }, scope: new Set(["CCC"]), rebalance: false } }, px, meta, date: "2026-10-01", nextSession: "2026-10-02" });
const byId = Object.fromEntries(b1.orders.map((o) => [o.agent + ":" + o.sym, o]));
ok(byId["a1:CCC"] && byId["a1:CCC"].status === "approved" && byId["a1:CCC"].side === "BUY", "auto desk: orders approved");
ok(byId["a4:CCC"] && byId["a4:CCC"].status === "pending", "manual desk: orders wait for approval");
const deskCCC = (byId["a1:CCC"]?.qty || 0) * 50;
ok(deskCCC <= 1_000_000 * 0.20 + 1 && byId["a1:CCC"].checks.some((c) => /clipped/.test(c)), "max position per name clips the order");
ok(!byId["a2:AAA"], "no order to sell what the sleeve doesn't hold");
ok(byId["a4:CCC"].value === 4000 * 50 && byId["a4:CCC"].qty === 4000, "order value and quantity");

// fills: approved at the open (+slippage, −fees), pending expires, late approval fills at the close
const bars = { CCC: { date: "2026-10-02", open: 52, close: 49 }, BBB: { date: "2026-10-02", open: 198, close: 205 } };
const ord = b1.orders.map((o) => ({ ...o }));
const late = ord.find((o) => o.agent === "a2" && o.sym === "BBB"); late.decided_at = "2026-10-02T06:00:00Z";
const { fills, updates } = O.fillOrders({ state: st, orders: ord, bar: (s) => bars[s] || null, today: "2026-10-02" });
const fC = fills.find((f) => f.agent === "a1" && f.sym === "CCC");
ok(fC && near(fC.fill_price, Math.round(52 * 1.0005 * 100) / 100) && fC.fill_at === "open", "fills at the open with slippage");
ok(updates.find((u) => u.id === byId["a4:CCC"].id)?.status === "expired", "unapproved order expires");
const fB = fills.find((f) => f.agent === "a2" && f.sym === "BBB"); ok(fB && fB.fill_at === "close" && near(fB.fill_price, Math.round(205 * 1.0005 * 100) / 100), "approval after the open fills at the close");
const slA1 = st.sleeves.a1, qC = slA1.positions.CCC.qty;
const spent = fills.filter((f) => f.agent === "a1").reduce((t, f) => t + f.qty * f.fill_price * (f.side === "BUY" ? 1 : -1) + f.fee, 0);
ok(near(slA1.cash, 600000 - spent, 1e-9) && qC === fC.qty, "sleeve cash pays price and fees");
// mark and drawdown halt
P.CCC = 20; P.BBB = 80;
const snap = O.markBook(st, px, "2026-10-02");
ok(snap.equity < 1_500_000 && snap.desks.d1 < 1_000_000, "marking the book to new prices");
st.desk_peaks.d1 = 1_000_000;
const b2 = O.buildOrders({ state: st, desks, agents, plans: {}, px, meta, date: "2026-10-02", nextSession: "2026-10-05" });
ok(b2.deskUpdates.d1?.status === "halted" && b2.orders.every((o) => o.desk !== "d1" || o.to_qty === 0) && b2.orders.some((o) => o.desk === "d1" && o.side === "SELL"), "drawdown beyond the limit halts the desk and flattens it");
ok(b2.events.some((e) => e.kind === "desk_halted"), "halt raises an alert");
// kill switch
const b3 = O.buildOrders({ state: st, book: { kill_switch: true }, desks, agents, plans: {}, px, meta, date: "2026-10-02", nextSession: "2026-10-05" });
ok(b3.orders.length && b3.orders.every((o) => o.to_qty === 0), "kill switch closes everything");
// allocation change moves cash, leaving closes the sleeve when flat
O.syncSleeves(st, desks, agents.map((a) => a.id === "a3" ? { ...a, alloc_pct: 20 } : a.id === "a4" ? { ...a, desk_id: null } : a), "2026-10-03");
ok(st.sleeves.a3.capital === 100000, "allocation change resizes the sleeve");
ok(!st.sleeves.a4, "a flat sleeve that left its desk closes");
console.log(bad ? `${bad} failed` : "all good"); process.exit(bad ? 1 : 0);
