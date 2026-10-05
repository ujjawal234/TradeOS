// Daily paper-trading run for TradeOS agents.
//   node scripts/daily_run.mjs <app_build_dir> <agents.json> <out.json>
// agents.json: [{ id, name, status, paper: {version, since}, version: {spec, test} }]  (the paper version's spec)
// Writes out.json with each paper agent's returns since it started, today's signals, and alert text.
import fs from "node:fs";
import zlib from "node:zlib";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const zlibM = require("node:zlib"), fsM = require("node:fs");
// JSON file, gzip or plain (x.json.gz preferred when both could exist)
const readJ = (f) => { const js = JSON.parse(fsM.readFileSync(f, "utf8")); return js && typeof js.b64gz === "string" ? JSON.parse(zlibM.gunzipSync(Buffer.from(js.b64gz, "base64")).toString("utf8")) : js; };
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
    const js = (optFiles[k] ||= readJ(path.join(data, "opt", `${k}.json`)));
    for (const [y, p] of Object.entries(js)) { if (kind === "c") E.setOptions(y, p); else E.setOptionSummary(y, p); optLoaded[kind].add(y); }
  }
}
// intraday bars (data/intra/*.json) for intraday agents
const intraLoaded = new Set();
function ensureIntraday(spec) {
  const I = man.intraday; if (!I) throw new Error("no intraday bars in this build");
  const kind = spec.bar_minutes % 5 === 0 ? "5m" : "1m";
  for (const k of new Set(spec.symbols.filter((s) => I.symbols[s] && I.symbols[s][kind]).map((s) => I.symbols[s][kind]))) {
    if (intraLoaded.has(k)) continue; intraLoaded.add(k);
    for (const [s, p] of Object.entries(readJ(path.join(data, "intra", `${k}.json`)))) E.setIntraday(s, p);
  }
}
const specExprs = (spec) => spec.type === "rule" || spec.type === "intraday" ? [spec.entry, spec.exit, spec.rank_by] : spec.type === "rotation" ? E.exprsOf(spec) : [spec.entry, spec.exit];
const full = {};
const bundleCache = {};
const fullFrame = (s) => {
  if (full[s]) return full[s];
  const pb = man.symbols[s] && man.symbols[s].pb; // NSE-sourced stocks live in the shared bundles (data/pit/full/<b>.json)
  if (pb) { const js = (bundleCache[pb] ||= readJ(path.join(data, "pit", "full", `${pb}.json`))); full[s] = E.frame(js[s]); }
  else full[s] = E.frame(JSON.parse(fs.readFileSync(path.join(data, "p", `${s}.json`), "utf8")));
  full[s].sym = s; return full[s];
};
// survivorship-free universes (data/pit): separate NSE-bhavcopy price series for every stock ever in them
const pitDir = path.join(data, "pit");
let pitLight = null, pitBundles = {}; const pitFull = {};
if (man.pit && fs.existsSync(path.join(pitDir, "membership.json"))) {
  const mem = JSON.parse(fs.readFileSync(path.join(pitDir, "membership.json"), "utf8"));
  E.setPit(mem); pitBundles = mem.bundles || {};
  pitLight = E.framesFromPack(readJ(path.join(pitDir, "closes.json")));
}
const pitSyms = new Set(Object.entries(man.universes).filter(([k]) => /pit$/.test(k)).flatMap(([, v]) => v));
function pitFrame(s) {
  if (!pitFull[s]) for (const [k, raw] of Object.entries(readJ(path.join(pitDir, "full", `${pitBundles[s]}.json`)))) pitFull[k] = E.frame(raw);
  return pitFull[s];
}
function framesFor(spec) {
  const pk = E.usesPit(spec);
  const need = [...new Set(E.symbolsNeeded(spec, man.universes).concat(["NIFTY"]))];
  if (man.options) {
    if (spec.type === "option_selling") ensureOptions([spec.underlying], "c");
    if (specExprs(spec).some(E.usesOptionVars)) { E.initOptionSummaries(); ensureOptions(need.concat(specExprs(spec).flatMap((x) => E.refSymbols(x))), "s"); }
  }
  if (spec.type === "intraday") ensureIntraday(spec);
  const out = {};
  for (const s of need) {
    if (pk && pitSyms.has(s)) { if (!pitLight) throw new Error("point-in-time data missing"); out[s] = E.needsFull(spec) ? pitFrame(s) : pitLight[s]; continue; }
    if (!man.symbols[s]) throw new Error(`no data for ${s}`);
    out[s] = E.needsFull(spec) && !["basket", "series"].includes(man.symbols[s].kind) ? fullFrame(s) : light[s];
  }
  return out;
}
// ------------------------------------------------------------------ stale-data gate
// Sources update at different times (NSE bhavcopy for stocks ~19:00 IST, index files, flows, Yahoo). If one of them
// hasn't published the latest session yet, an agent would trade today's index level against yesterday's stock prices.
// A series that stopped within the last STALE_WINDOW days is "late"; one that stopped long ago is delisted/retired.
const STALE_WINDOW = 10;
const lastDayN = Math.round(Date.parse(lastDay + "T00:00:00Z") / 86400000);
const dayN = (iso) => Math.round(Date.parse(iso + "T00:00:00Z") / 86400000);
function staleIn(frames) {
  const out = [];
  for (const [s, f] of Object.entries(frames)) {
    if (!f || !f.d || !f.d.length) continue;
    const meta = man.symbols[s] || {};
    if (meta.group === "global") continue; // world markets are carried forward onto Indian days
    // closes.json carries every series' last close forward to the end of the calendar, so a light frame always looks
    // current; the manifest's "last" is the real last date. Point-in-time frames stop at their real last day.
    const last = meta.last && meta.kind !== "basket" ? dayN(meta.last) : f.d[f.d.length - 1];
    const gap = lastDayN - last;
    if (gap > 0 && gap <= STALE_WINDOW) out.push(s);
  }
  return out;
}
// Block an agent's signals when the staleness looks like a source that didn't update (not one suspended stock):
// its benchmark/underlying is late, or >= 20% of what it uses is late, or it uses only a handful of series.
function staleVerdict(spec, frames) {
  const late = staleIn(frames), n = Object.keys(frames).length;
  if (!late.length) return null;
  const key = late.filter((s) => s === "NIFTY" || s === spec.underlying);
  const blocked = key.length > 0 || late.length / n >= 0.2 || n <= 5;
  return { blocked, symbols: late.slice(0, 15), count: late.length, of: n };
}
const ACTION = /BUY|SELL|SHORT|COVER|NEW|EXITED/;
const agents = JSON.parse(fs.readFileSync(agentsFile, "utf8"));
const results = [];
for (const a of agents) {
  if (a.status !== "paper" || !a.paper || !a.version?.spec) continue;
  const r = { id: a.id, name: a.name, version: a.paper.version, since: a.paper.since };
  try {
    const spec = E.normalize(a.version.spec, man.universes), frames = framesFor(spec);
    const stale = staleVerdict(spec, frames);
    if (stale) r.stale = stale;
    const lastSession = spec.type === "intraday" ? (man.intraday?.asof || lastDay) : lastDay;
    if (a.paper.since >= lastSession) {
      const res = E.run(spec, frames, man.universes, { start: a.version.test?.start || "2012-01-01" });
      r.pending = true; r.signals = E.signals(spec, res);
    } else {
      const res = E.run(spec, frames, man.universes, { start: spec.type === "intraday" ? E.isoOf(E.dayOf(a.paper.since) + 1) : a.paper.since }); // intraday: sessions after the start day
      const m = res.metrics, b = res.benchMetrics || {};
      r.paper = { asof: m.end, days: res.days.length, return_pct: m.total_return_pct, nifty_pct: b.total_return_pct ?? null,
        max_drawdown_pct: m.max_drawdown_pct, equity: Math.round(m.end_equity), start_equity: Math.round(m.start_equity) };
      r.signals = E.signals(spec, res);
    }
    r.actions = r.signals.filter((s) => ACTION.test(s.action) && s.due !== false);  // rotation changes count only on their rebalance day
    if (stale && stale.blocked) { r.blocked_actions = r.actions.length; r.actions = []; }  // never alert on half-updated data
  } catch (e) { r.error = String(e.message || e); r.signals = []; r.actions = []; }
  results.push(r);
}
const nActions = results.reduce((n, r) => n + r.actions.length, 0);
const blocked = results.filter((r) => r.stale && r.stale.blocked);
const lateList = (st) => st.symbols.slice(0, 5).join(", ") + (st.count > 5 ? ` +${st.count - 5} more` : "");
const fmtPct = (x) => (x == null ? "–" : (x > 0 ? "+" : "") + x.toFixed(1) + "%");
const lines = results.map((r) => {
  const head = `${r.name} (v${r.version})` + (r.paper ? ` ${fmtPct(r.paper.return_pct)} vs Nifty ${fmtPct(r.paper.nifty_pct)}` : r.pending ? " starts next session" : "");
  const acts = r.actions.map((s) => `${s.action} ${s.symbol}${s.price ? " @" + s.price : ""}${s.stop ? " SL " + s.stop : ""}`);
  if (r.error) return `${r.name}: ERROR ${r.error}`;
  if (r.stale && r.stale.blocked) return `${head}: SKIPPED, no ${lastDay} data yet for ${lateList(r.stale)}; signals held back`;
  const warn = r.stale ? ` (no ${lastDay} data for ${lateList(r.stale)})` : "";
  return (acts.length ? `${head}: ${acts.join(", ")}` : `${head}: no action`) + warn;
});
const skipNote = blocked.length ? ` ${blocked.length} agent(s) skipped: data not updated for ${lastDay}.` : "";
const short = nActions
  ? `TradeOS ${lastDay}: ` + results.filter((r) => r.actions.length).map((r) => `${r.name}: ${r.actions.slice(0, 3).map((s) => `${s.action} ${s.symbol}`).join(", ")}${r.actions.length > 3 ? ` +${r.actions.length - 3}` : ""}`).join("; ") + skipNote
  : `TradeOS ${lastDay}: no buy/sell signals across ${results.length} paper agent(s).` + skipNote;
const lateAll = [...new Set(results.flatMap((r) => (r.stale ? r.stale.symbols : [])))];
const out = {
  date: lastDay, generated: new Date().toISOString(), agents_run: results.length, actions: nActions,
  data_check: { ok: blocked.length === 0, agents_skipped: blocked.length, late_symbols: lateAll.slice(0, 30), late_count: lateAll.length },
  push_text: short.length > 190 ? short.slice(0, 187) + "…" : short,
  telegram_text: [`TradeOS signals for the session after ${lastDay} (paper trading, not advice)`, ...lines].join("\n"),
  results,
};
fs.writeFileSync(outFile, JSON.stringify(out, null, 1));
console.log(out.telegram_text);
