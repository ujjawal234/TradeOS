// Intraday engine checks on hand-made bars (exact fills, stops, targets, square-off, ranking, shorts, variables).
//   node tests/intraday_check.mjs
import path from "node:path"; import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const E = require(path.join(path.dirname(new URL(import.meta.url).pathname), "..", "lab", "engine.js"));
let fail = 0;
const near = (a, b, tol = 1e-6) => Math.abs(a - b) <= tol * Math.max(1, Math.abs(b));
function check(label, cond, info = "") { if (!cond) fail++; console.log(`${cond ? "ok  " : "FAIL"} ${label}${cond ? "" : "  " + info}`); }
const D = E.dayOf("2026-09-01");
// packed format: [day, b0, c0 (paise), close deltas, open-close, high-close, low-close, volume]
function pack(day, bars) { // bars: [o,h,l,c,v]
  const c = bars.map((b) => Math.round(b[3] * 100));
  return [day, 0, c[0], c.map((x, i) => (i ? x - c[i - 1] : 0)), bars.map((b, i) => Math.round(b[0] * 100) - c[i]), bars.map((b, i) => Math.round(b[1] * 100) - c[i]),
    bars.map((b, i) => Math.round(b[2] * 100) - c[i]), bars.map((b) => b[4])];
}
const flat = (n, p, v = 1000) => Array.from({ length: n }, () => [p, p, p, p, v]);
// AAA: opening range high 101, breakout at bar 3 close 101.5, target hit on bar 4
const aaa = [[100, 101, 99, 100, 5000], [100, 100.8, 99.5, 100.5, 1000], [100.5, 100.9, 100, 100.2, 1000], [100.3, 101.6, 100.2, 101.5, 3000], [101.5, 103.6, 101.4, 103, 2000], ...flat(70, 103)];
// BBB: breakout at bar 3 too (ranked lower), then gaps below its stop on bar 6
const bbb = [[50, 50.5, 49.8, 50, 1000], [50, 50.4, 49.9, 50.1, 1000], [50.1, 50.3, 50, 50.2, 1000], [50.2, 50.8, 50.2, 50.7, 1500], [50.7, 50.8, 50.6, 50.7, 1000], [50.7, 50.7, 50.6, 50.6, 1000], [49.9, 50, 49.5, 49.6, 1000], ...flat(68, 49.6)];
// CCC: breakout but never exits: squared off at the 15:15 bar close
const ccc = [[200, 201, 199, 200, 1000], [200, 200.5, 199.5, 200, 1000], [200, 200.5, 199.8, 200, 1000], [200, 201.4, 200, 201.2, 1000], ...Array.from({ length: 71 }, (_, i) => { const p = 201.2 + i * 0.01; return [p, p, p, p, 1000]; })];
E.setIntraday("AAA", { step: 5, days: [pack(D, aaa)] });
E.setIntraday("BBB", { step: 5, days: [pack(D, bbb)] });
E.setIntraday("CCC", { step: 5, days: [pack(D, ccc)] });
const base = { type: "intraday", symbols: ["AAA", "BBB", "CCC"], entry: "close > or_high", stop_loss_pct: 1, target_pct: 2, slippage_pct: 0, cost_pct: 0, capital: 1000000, position_pct: 25, max_positions: 4, rank_by: "day_ret", start_after: "09:30" };
let sp = E.normalize(base, {}), r = E.run(sp, {}, {}, {});
const T = (s) => r.trades.find((t) => t.symbol === s);
check("three trades", r.trades.length === 3, JSON.stringify(r.trades));
const a = T("AAA");
check("AAA entry at the 09:35 close", a && a.entry_time === "09:35" && near(a.entry_price, 101.5), JSON.stringify(a));
check("AAA target fill at entry +2%", a && a.reason === "target" && near(a.exit_price, 103.53) && a.exit_time === "09:40", JSON.stringify(a));
check("AAA qty = floor(25% of capital / price)", a && a.qty === Math.floor(250000 / 101.5));
const b = T("BBB");
check("BBB gap below stop fills at the open", b && b.reason === "stop" && near(b.exit_price, 49.9) && b.exit_time === "09:50", JSON.stringify(b));
const c = T("CCC");
check("CCC squared off at 15:15", c && c.reason === "square-off" && c.exit_time === "15:15" && near(c.exit_price, 201.2 + 68 * 0.01, 1e-4), JSON.stringify(c));
const pnl = r.trades.reduce((s, t) => s + t.pnl, 0);
check("equity = capital + P&L", near(r.eq[r.eq.length - 1], 1000000 + pnl), `${r.eq[r.eq.length - 1]} vs ${1000000 + pnl}`);
// max_positions 1: the higher day_ret wins (AAA +1.5% vs BBB +1.4% vs CCC +0.6%)
r = E.run(E.normalize({ ...base, max_positions: 1 }, {}), {}, {}, {});
check("ranking picks AAA with one slot, then the next breakout once the slot frees", r.trades[0].symbol === "AAA" && r.trades.length >= 1, JSON.stringify(r.trades.map((t) => [t.symbol, t.entry_time])));
// costs and slippage
r = E.run(E.normalize({ ...base, symbols: ["AAA"], slippage_pct: 0.01, cost_pct: 0.05 }, {}), {}, {}, {});
const t = r.trades[0], ep = 101.5 * 1.0001, q = Math.floor(250000 / ep), tg = ep * 1.02;
check("slippage on entry, target without slippage", near(t.entry_price, Math.round(ep * 100) / 100) && near(t.exit_price, Math.round(tg * 100) / 100), JSON.stringify(t));
check("fees both sides", near(t.pnl, q * (tg - ep) - q * tg * 0.0005 - q * ep * 0.0005, 1e-9), `${t.pnl}`);
check("costs only lower P&L", t.pnl < a.pnl);
// short side: breakdown below or_low
const ddd = [[100, 100.5, 99, 100, 1000], [100, 100.2, 99.5, 99.8, 1000], [99.8, 100, 99.4, 99.5, 1000], [99.5, 99.5, 98.5, 98.6, 1000], [98.6, 99.8, 98.6, 99.7, 1000], ...flat(70, 99.7)];
E.setIntraday("DDD", { step: 5, days: [pack(D, ddd)] });
r = E.run(E.normalize({ ...base, symbols: ["DDD"], side: "short", entry: "close < or_low", target_pct: null }, {}), {}, {}, {});
check("short stop above entry", r.trades.length === 1 && r.trades[0].reason === "stop" && near(r.trades[0].exit_price, 98.6 * 1.01, 1e-4) && r.trades[0].pnl < 0, JSON.stringify(r.trades));
// exit rule and variables
r = E.run(E.normalize({ ...base, symbols: ["AAA"], entry: "minutes == 60", exit: "minutes >= 120", stop_loss_pct: null, target_pct: null }, {}), {}, {}, {});
check("minutes: entry 10:15, exit rule 11:15", r.trades.length === 1 && r.trades[0].entry_time === "10:15" && r.trades[0].exit_time === "11:15" && r.trades[0].reason === "exit rule", JSON.stringify(r.trades));
// 15-minute bars from 5-minute data, opening range 15 = first bar
r = E.run(E.normalize({ ...base, symbols: ["AAA"], bar_minutes: 15, entry: "close > or_high", start_after: "09:30" }, {}), {}, {}, {});
check("15-minute bars: entry at 09:45 close (bar 2 aggregates 09:30-09:45)", r.trades.length === 1 && r.trades[0].entry_time === "09:45" && near(r.trades[0].entry_price, 103), JSON.stringify(r.trades));
// errors
for (const [lab, s] of [["rejects 3-min OR with 10-min bars", { ...base, bar_minutes: 10, opening_range_minutes: 15 }], ["rejects bad time", { ...base, square_off: "16:00" }], ["rejects 7-minute bars", { ...base, bar_minutes: 7 }]]) {
  let ok = false; try { E.normalize(s, {}); } catch (e) { ok = e instanceof E.RuleError; } check(lab, ok);
}
let ok2 = false; try { E.normalize({ type: "rule", symbols: ["AAA"], entry: "close > vwap", exit: "close < vwap" }, {}); } catch (e) { ok2 = /intraday variable/.test(e.message); }
let ok3 = true; try { E.normalize({ type: "rule", symbols: ["AAA"], entry: "close > vwap(20)", exit: "close < vwap(20)" }, {}); } catch (e) { ok3 = false; }
check("daily rules still have vwap(n)", ok3);
check("daily rules can't use the intraday vwap variable", ok2);
console.log(fail ? `${fail} failure(s)` : "all good"); process.exit(fail ? 1 : 0);
