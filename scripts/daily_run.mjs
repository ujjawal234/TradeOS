// Daily paper-trading run for TradeOS agents.
//   node scripts/daily_run.mjs <app_build_dir> <agents.json> <out.json>
// agents.json: [{ id, name, status, paper: {version, since}, version: {spec, test} }]  (the paper version's spec)
// Writes out.json with each paper agent's returns since it started, today's signals, and alert text.
import fs from "node:fs";
import { E, loadData } from "./lib_frames.mjs";

const [dir, agentsFile, outFile] = process.argv.slice(2);
if (!dir || !agentsFile || !outFile) { console.error("usage: node scripts/daily_run.mjs <app_build_dir> <agents.json> <out.json>"); process.exit(2); }
const D = loadData(dir), { man, light, lastDay } = D;
const framesFor = (spec, extra = [], tolerant = false) => D.framesFor(spec, extra, tolerant);
// the session calendar (NIFTY's days up to the latest close): daily-list names are live for their first list_days sessions
const sessions = Array.from(light.NIFTY ? light.NIFTY.d : []).filter((d) => d <= E.dayOf(lastDay));

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
    if (meta.group === "global" || meta.group === "macro") continue; // world markets are carried forward onto Indian days
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
    const spec = E.normalize(a.version.spec, man.universes);
    if (spec.type === "watchlist") { // daily-list system: today's calls on the names that are live; the book holds its positions
      const list = E.watchLive(a.inbox_log || [], sessions, spec.list_days), frames = framesFor(spec, list, true);
      const stale = staleVerdict(spec, Object.fromEntries(Object.entries(frames).filter(([s]) => s === "NIFTY" || list.includes(s))));
      if (stale) r.stale = stale;
      r.list = list; r.signals = E.watchSignals(spec, frames, { list, over: a.auto_learn && a.learned?.params ? a.learned.params : null })
        .map((x) => ({ symbol: x.symbol, action: x.action, price: x.price, note: x.note }));
      r.actions = r.signals.filter((x) => x.action === "BUY");
      if (stale && stale.blocked) { r.blocked_actions = r.actions.length; r.actions = []; }
      results.push(r); continue;
    }
    const frames = framesFor(spec);
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
