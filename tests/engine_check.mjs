// Engine checks against real app data (build it first: python app/build.py build && python scripts/build_app_data.py build)
//   node tests/engine_check.mjs build                      -> runs every case in tests/engine_cases.json (new features + edge cases)
//   node tests/engine_check.mjs build <old_engine.js>      -> also verifies older-style specs give identical results to that engine
//        e.g. git show <commit>:lab/engine.js > /tmp/old_engine.js
import fs from "node:fs"; import path from "node:path"; import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const here = path.dirname(new URL(import.meta.url).pathname);
const [dir, oldPath] = process.argv.slice(2);
if (!dir) { console.error("usage: node tests/engine_check.mjs <app_build_dir> [old_engine.js]"); process.exit(2); }
const E = require(path.join(here, "..", "lab", "engine.js"));
const man = JSON.parse(fs.readFileSync(path.join(dir, "data", "manifest.json")));
const light = E.framesFromPack(JSON.parse(fs.readFileSync(path.join(dir, "data", "closes.json"))));
const full = {}; const ff = (s) => (full[s] ||= E.frame(JSON.parse(fs.readFileSync(path.join(dir, "data", "p", `${s}.json`)))));
let shares = null; try { shares = JSON.parse(fs.readFileSync(path.join(dir, "data", "shares.json"))); } catch (e) { /* optional */ }
E.setData({ meta: man.symbols, shares });
function framesFor(Eng, spec) {
  const need = [...new Set(Eng.symbolsNeeded(spec, man.universes).concat(["NIFTY"]))], useFull = Eng.needsFull ? Eng.needsFull(spec) : spec.type === "rule", out = {};
  for (const s of need) { if (!man.symbols[s]) throw new Error("no data for " + s); out[s] = useFull && man.symbols[s].kind !== "basket" ? ff(s) : light[s]; }
  return out;
}
let fail = 0;
const EXPECT_ERR = /^(bad expr|bad ref|no exit)$/;
for (const [label, raw, opt] of JSON.parse(fs.readFileSync(path.join(here, "engine_cases.json")))) {
  try {
    const spec = E.normalize(raw, man.universes), r = E.run(spec, framesFor(E, spec), man.universes, opt || { start: "2012-01-01" }), m = r.metrics, sig = E.signals(spec, r);
    const ok = r.days.length > 1 && Number.isFinite(m.end_equity) && sig.length > 0 && !EXPECT_ERR.test(label);
    if (!ok) fail++;
    console.log(`${ok ? "ok  " : "FAIL"} ${label.padEnd(32)} CAGR ${m.cagr_pct} DD ${m.max_drawdown_pct} vs ${r.benchName} ${r.benchMetrics?.cagr_pct}`);
  } catch (e) {
    const ok = EXPECT_ERR.test(label) && e instanceof E.RuleError; if (!ok) fail++;
    console.log(`${ok ? "ok  " : "FAIL"} ${label.padEnd(32)} ${ok ? "rejected: " : "ERROR "}${String(e.message).slice(0, 120)}`);
  }
}
if (oldPath) {
  const O = require(path.resolve(oldPath));
  const legacy = [
    { type: "rule", symbols: ["RELIANCE", "TCS", "HDFCBANK", "NIFTY"], entry: "close > sma(close,50) and rsi(close,14) > 55", exit: "close < sma(close,50)", stop_loss_pct: 8 },
    { type: "rule", symbols: ["banks"], entry: "close > shift(highest(high,55),1)", exit: "close < lowest(low,20)", take_profit_pct: 25 },
    { type: "rule", symbols: ["BANKNIFTY"], entry: "rsi(close,2) > 95", exit: "rsi(close,2) < 30", side: "short", stop_loss_pct: 3 },
    { type: "rotation", universe: "nifty200", lookback: 252, skip: 21, top_n: 10, rebalance: "monthly", min_score: 0, trend_filter: { symbol: "NIFTY", sma: 200 } },
    { type: "rotation", universe: "nifty50", lookback: 126, skip: 0, top_n: 5, rebalance: "weekly", score: "risk_adj", trend_filter: null, min_score: null },
    { type: "rotation", universe: "sectors", lookback: 63, skip: 5, top_n: 3, rebalance: "monthly" },
    { type: "option_selling", underlying: "NIFTY", structure: "strangle", delta: 0.15 },
    { type: "option_selling", underlying: "BANKNIFTY", structure: "iron_condor", delta: 0.2, max_vix: 22 },
  ];
  for (const raw of legacy) for (const opt of [{ start: "2012-01-01" }, { start: "2024-01-01", end: "2026-06-30" }]) {
    const a = O.normalize(raw, man.universes), b = E.normalize(raw, man.universes);
    const ra = O.run(a, framesFor(O, a), man.universes, opt), rb = E.run(b, framesFor(E, b), man.universes, opt);
    const sa = O.signals(a, ra), sb = E.signals(b, rb);
    const diffs = Object.keys(ra.metrics).filter((k) => JSON.stringify(ra.metrics[k]) !== JSON.stringify(rb.metrics[k]));
    if (JSON.stringify(a) !== JSON.stringify(b)) diffs.push("normalized spec");
    if (sa.length !== sb.length || sa.some((x, i) => ["symbol", "action", "price", "stop", "target", "weight_pct"].some((k) => x[k] !== sb[i][k]))) diffs.push("signals");
    if (diffs.length) fail++;
    console.log(`${diffs.length ? "FAIL" : "ok  "} legacy ${raw.type} ${raw.universe || raw.underlying || raw.symbols} ${opt.start}${diffs.length ? " differs: " + diffs.join(", ") : " identical"}`);
  }
}
console.log(fail ? `${fail} failure(s)` : "all good"); process.exit(fail ? 1 : 0);
