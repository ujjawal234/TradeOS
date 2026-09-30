// Daily paper-trading run for TradeOS agents.
//   node scripts/daily_run.mjs <app_build_dir> <agents.json> <out.json>
// agents.json: [{ id, name, status, paper: {version, since}, version: {spec, test} }]  (the paper version's spec)
// Writes out.json with each paper agent's returns since it started, today's signals, and alert text.
import fs from "node:fs";
import zlib from "node:zlib";
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
E.setData({ meta: man.symbols, shares, ...(man.options ? { optIndex: man.options.underlyings } : {}) });
// NSE option prices (data/opt/*.json.gz): chains for option agents, summaries for iv/pcr/skew... in rules
const optLoaded = { c: new Set(), s: new Set() }, optFiles = {};
function ensureOptions(syms, kind) {
  const U = (man.options && man.options.underlyings) || {};
  for (const x of new Set(syms)) {
    if (!U[x] || !U[x][kind] || optLoaded[kind].has(x)) continue;
    const k = U[x][kind];
    const js = (optFiles[k] ||= JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(data, "opt", `${k}.json.gz`))).toString("utf8")));
    for (const [y, p] of Object.entries(js)) { if (kind === "c") E.setOptions(y, p); else E.setOptionSummary(y, p); optLoaded[kind].add(y); }
  }
}
const specExprs = (spec) => spec.type === "rule" ? [spec.entry, spec.exit, spec.rank_by] : spec.type === "rotation" ? E.exprsOf(spec) : [spec.entry, spec.exit];
const full = {};
const bundleCache = {};
const fullFrame = (s) => {
  if (full[s]) return full[s];
  const pb = man.symbols[s] && man.symbols[s].pb; // NSE-sourced stocks live in the shared bundles (data/pit/full/<b>.json)
  if (pb) { const js = (bundleCache[pb] ||= JSON.parse(fs.readFileSync(path.join(data, "pit", "full", `${pb}.json`), "utf8"))); full[s] = E.frame(js[s]); }
  else full[s] = E.frame(JSON.parse(fs.readFileSync(path.join(data, "p", `${s}.json`), "utf8")));
  full[s].sym = s; return full[s];
};
// survivorship-free universes (data/pit): separate NSE-bhavcopy price series for every stock ever in them
const pitDir = path.join(data, "pit");
let pitLight = null, pitBundles = {}; const pitFull = {};
if (man.pit && fs.existsSync(path.join(pitDir, "membership.json"))) {
  const mem = JSON.parse(fs.readFileSync(path.join(pitDir, "membership.json"), "utf8"));
  E.setPit(mem); pitBundles = mem.bundles || {};
  pitLight = E.framesFromPack(JSON.parse(fs.readFileSync(path.join(pitDir, "closes.json"), "utf8")));
}
const pitSyms = new Set(Object.entries(man.universes).filter(([k]) => /pit$/.test(k)).flatMap(([, v]) => v));
function pitFrame(s) {
  if (!pitFull[s]) for (const [k, raw] of Object.entries(JSON.parse(fs.readFileSync(path.join(pitDir, "full", `${pitBundles[s]}.json`), "utf8")))) pitFull[k] = E.frame(raw);
  return pitFull[s];
}
function framesFor(spec) {
  const pk = E.usesPit(spec);
  const need = [...new Set(E.symbolsNeeded(spec, man.universes).concat(["NIFTY"]))];
  if (man.options) {
    if (spec.type === "option_selling") ensureOptions([spec.underlying], "c");
    if (specExprs(spec).some(E.usesOptionVars)) { E.initOptionSummaries(); ensureOptions(need.concat(specExprs(spec).flatMap((x) => E.refSymbols(x))), "s"); }
  }
  const out = {};
  for (const s of need) {
    if (pk && pitSyms.has(s)) { if (!pitLight) throw new Error("point-in-time data missing"); out[s] = E.needsFull(spec) ? pitFrame(s) : pitLight[s]; continue; }
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
