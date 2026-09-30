// Daily paper-trading run for TradeOS agents.
//   node scripts/daily_run.mjs <app_build_dir> <agents.json> <out.json>
// agents.json: [{ id, name, status, paper: {version, since}, version: {spec, test} }]  (the paper version's spec)
// Writes out.json with each paper agent's returns since it started, today's signals, and alert text.
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const here = path.dirname(new URL(import.meta.url).pathname);
const E = require(path.join(here, "..", "lab", "engine.js"));
const [dir, agentsFile, outFile] = process.argv.slice(2);
if (!dir || !agentsFile || !outFile) { console.error("usage: node scripts/daily_run.mjs <app_build_dir> <agents.json> <out.json>"); process.exit(2); }

const data = path.join(dir, "data");
const man = JSON.parse(fs.readFileSync(path.join(data, "manifest.json"), "utf8"));
const light = E.framesFromPack(JSON.parse(fs.readFileSync(path.join(data, "closes.json"), "utf8")));
const lastDay = Object.values(man.symbols).map((s) => s.last).sort().pop();
let shares = null; try { shares = JSON.parse(fs.readFileSync(path.join(data, "shares.json"), "utf8")); } catch (e) { /* optional */ }
E.setData({ meta: man.symbols, shares });
const full = {};
const fullFrame = (s) => (full[s] ||= E.frame(JSON.parse(fs.readFileSync(path.join(data, "p", `${s}.json`), "utf8"))));
function framesFor(spec) {
  const need = [...new Set(E.symbolsNeeded(spec, man.universes).concat(["NIFTY"]))];
  const out = {};
  for (const s of need) {
    if (!man.symbols[s]) throw new Error(`no data for ${s}`);
    out[s] = E.needsFull(spec) && man.symbols[s].kind !== "basket" ? fullFrame(s) : light[s];
  }
  return out;
}
const ACTION = /BUY|SELL|SHORT|COVER|NEW|EXITED/;
const agents = JSON.parse(fs.readFileSync(agentsFile, "utf8"));
const results = [];
for (const a of agents) {
  if (a.status !== "paper" || !a.paper || !a.version?.spec) continue;
  const r = { id: a.id, name: a.name, version: a.paper.version, since: a.paper.since };
  try {
    const spec = E.normalize(a.version.spec, man.universes), frames = framesFor(spec);
    if (a.paper.since >= lastDay) {
      const res = E.run(spec, frames, man.universes, { start: a.version.test?.start || "2012-01-01" });
      r.pending = true; r.signals = E.signals(spec, res);
    } else {
      const res = E.run(spec, frames, man.universes, { start: a.paper.since });
      const m = res.metrics, b = res.benchMetrics || {};
      r.paper = { asof: m.end, days: res.days.length, return_pct: m.total_return_pct, nifty_pct: b.total_return_pct ?? null,
        max_drawdown_pct: m.max_drawdown_pct, equity: Math.round(m.end_equity), start_equity: Math.round(m.start_equity) };
      r.signals = E.signals(spec, res);
    }
    r.actions = r.signals.filter((s) => ACTION.test(s.action) && s.due !== false);  // rotation changes count only on their rebalance day
  } catch (e) { r.error = String(e.message || e); r.signals = []; r.actions = []; }
  results.push(r);
}
const nActions = results.reduce((n, r) => n + r.actions.length, 0);
const fmtPct = (x) => (x == null ? "–" : (x > 0 ? "+" : "") + x.toFixed(1) + "%");
const lines = results.map((r) => {
  const head = `${r.name} (v${r.version})` + (r.paper ? ` ${fmtPct(r.paper.return_pct)} vs Nifty ${fmtPct(r.paper.nifty_pct)}` : r.pending ? " starts next session" : "");
  const acts = r.actions.map((s) => `${s.action} ${s.symbol}${s.price ? " @" + s.price : ""}${s.stop ? " SL " + s.stop : ""}`);
  return r.error ? `${r.name}: ERROR ${r.error}` : acts.length ? `${head}: ${acts.join(", ")}` : `${head}: no action`;
});
const short = nActions
  ? `TradeOS ${lastDay}: ` + results.filter((r) => r.actions.length).map((r) => `${r.name}: ${r.actions.slice(0, 3).map((s) => `${s.action} ${s.symbol}`).join(", ")}${r.actions.length > 3 ? ` +${r.actions.length - 3}` : ""}`).join("; ")
  : `TradeOS ${lastDay}: no buy/sell signals across ${results.length} paper agent(s).`;
const out = {
  date: lastDay, generated: new Date().toISOString(), agents_run: results.length, actions: nActions,
  push_text: short.length > 190 ? short.slice(0, 187) + "…" : short,
  telegram_text: [`TradeOS signals for the session after ${lastDay} (paper trading, not advice)`, ...lines].join("\n"),
  results,
};
fs.writeFileSync(outFile, JSON.stringify(out, null, 1));
console.log(out.telegram_text);
