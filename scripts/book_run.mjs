// The evening book run: fill yesterday's approved orders at today's open, mark the book, size tomorrow's orders from the
// agents' target books inside each desk's limits, and evaluate alerts. Paper only.
//   node scripts/book_run.mjs <app_build_dir> <db_export_dir> <agents.json> <daily.json> <out.json>
// db_export_dir holds the app database as ArtifactData "list" exports (one JSON file per document):
//   desks/*.json, agents/*.json, book/{config,state,history}.json, orders/*.json (any; only pending/approved are acted on), alerts/*.json
// agents.json: the daily job's paper agents with their paper version's spec; daily.json: daily_run.mjs output.
// out.json: {writes: [{op, collection, doc_id, data}], summary, push_text, events}
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { E, loadData } from "./lib_frames.mjs";

const require = createRequire(import.meta.url);
const here = path.dirname(new URL(import.meta.url).pathname);
const O = require(path.join(here, "..", "lab", "oms.js"));
const AL = require(path.join(here, "..", "lab", "alerts.js"));
const [dir, dbdir, agentsFile, dailyFile, outFile] = process.argv.slice(2);
if (!outFile) { console.error("usage: node scripts/book_run.mjs <app_build_dir> <db_export_dir> <agents.json> <daily.json> <out.json>"); process.exit(2); }

const docs = (col) => { const d = path.join(dbdir, col); if (!fs.existsSync(d)) return []; return fs.readdirSync(d).filter((f) => f.endsWith(".json")).map((f) => { const x = JSON.parse(fs.readFileSync(path.join(d, f), "utf8")); return { id: f.slice(0, -5), ...(x.data && x.id ? x.data : x) }; }); };
const one = (col, id) => docs(col).find((x) => x.id === id) || null;
const D = loadData(dir), { man, lastDay } = D;
const desks = docs("desks"), agentDocs = docs("agents"), allOrders = docs("orders"), openOrders = allOrders.filter((o) => o.status === "pending" || o.status === "approved"), alerts = docs("alerts");
const config = { kill_switch: false, max_dd_pct: null, ...(one("book", "config") || {}) };
const prevState = one("book", "state");
const state = prevState && prevState.sleeves ? JSON.parse(JSON.stringify(prevState)) : O.emptyState(0, null);
delete state.id;
const history = (one("book", "history")?.rows || []).slice();
const paperAgents = fs.existsSync(agentsFile) ? JSON.parse(fs.readFileSync(agentsFile, "utf8")) : [];
const daily = fs.existsSync(dailyFile) ? JSON.parse(fs.readFileSync(dailyFile, "utf8")) : { results: [] };
const R = Object.fromEntries((daily.results || []).map((r) => [r.id, r]));
const writes = [], events = [], log = [];
const newDay = !state.asof || state.asof < lastDay;

// ---- prices
const lastClose = {};
function px(s) {
  if (s in lastClose) return lastClose[s];
  const f = D.light[s] || D.priceFrame(s); let v = null;
  if (f) { const want = E.dayOf(lastDay); for (let i = f.d.length - 1; i >= 0; i--) if (f.d[i] <= want && f.c[i] === f.c[i]) { v = f.c[i]; break; } }
  return (lastClose[s] = v);
}
function bar(s, session) {
  const f = D.priceFrame(s); if (!f) return null;
  const from = E.dayOf(session), to = E.dayOf(lastDay);
  for (let i = 0; i < f.d.length; i++) if (f.d[i] >= from && f.d[i] <= to) { const o = f.o && f.o[i] === f.o[i] ? f.o[i] : f.c[i]; return { date: E.isoOf(f.d[i]), open: o, close: f.c[i] }; }
  return null;
}

// ---- 1. fills for orders whose session has traded
const { fills, updates } = O.fillOrders({ state, orders: openOrders, bar, today: lastDay });
for (const u of updates) writes.push({ op: "update", collection: "orders", doc_id: u.id, data: { ...u, id: undefined, updated_at: new Date().toISOString() } });
for (const f of fills) log.push(`filled ${f.side} ${f.qty} ${f.sym} @${f.fill_price} (${f.fill_at} ${f.fill_date})`);

// ---- 2. strategies the book mirrors rather than trades (options, intraday): their sleeve follows the agent's paper equity
for (const [aid, sl] of Object.entries(state.sleeves)) {
  if (sl.oms) continue;
  const eq = R[aid]?.paper?.equity; if (!eq) continue;
  if (sl.ext_last && newDay) sl.cash = sl.cash * (eq / sl.ext_last);
  sl.ext_last = eq;
}

// ---- 3. capital follows the desks
for (const e of O.syncSleeves(state, desks, agentDocs, lastDay)) events.push({ ...e, severity: "info", title: sysTitle(e) });
function sysTitle(e) {
  const nm = (id) => agentDocs.find((a) => a.id === id)?.name || id, dn = (id) => desks.find((d) => d.id === id)?.name || id, inr = (x) => "₹" + Math.round(x).toLocaleString("en-IN");
  return e.kind === "sleeve_opened" ? `${nm(e.agent)} joined ${dn(e.desk)} with ${inr(e.capital)}` : e.kind === "capital_changed" ? `${nm(e.agent)}: capital ${inr(e.from)} → ${inr(e.to)}`
    : e.kind === "sleeve_closing" ? `${nm(e.agent)} is being wound down` : e.kind === "sleeve_closed" ? `${nm(e.agent)} closed; ${inr(e.cash)} back to the desk` : e.kind === "sleeve_moved" ? `${nm(e.agent)} moved to ${dn(e.to)}` : e.kind;
}

// ---- 4. mark the book
const snap = O.markBook(state, px, lastDay);
if (history.length && history[history.length - 1].date === lastDay) history[history.length - 1] = snap; else history.push(snap);
while (history.length > 3000) history.shift();

// ---- 5. tomorrow's orders
let nx = E.dayOf(lastDay) + 1; while (((new Date(nx * 864e5).getUTCDay() + 6) % 7) > 4) nx++;
const nextSession = E.isoOf(nx);
const sessions = Array.from(D.light.NIFTY ? D.light.NIFTY.d : []).filter((d) => d <= E.dayOf(lastDay));
const plans = {};
const specs = Object.fromEntries(paperAgents.map((a) => [a.id, a.version]));
for (const [aid, sl] of Object.entries(state.sleeves)) {
  const a = agentDocs.find((x) => x.id === aid);
  if (!sl.oms || sl.closing || !a || a.status !== "paper" || !specs[aid]?.spec) continue;
  if (R[aid]?.stale?.blocked) { log.push(`${a.name}: no orders, data not updated for ${R[aid].stale.symbols.slice(0, 3).join(", ")}`); continue; }
  try {
    const spec = E.normalize(specs[aid].spec, man.universes);
    let res;
    if (spec.type === "watchlist") { // daily list: live names + what the sleeve holds; learned settings when the team turned learning on
      const list = E.watchLive(a.inbox_log || [], sessions, spec.list_days), held = {};
      for (const [s, p] of Object.entries(sl.positions || {})) if (p.qty) held[s] = { qty: p.qty, avg: p.avg, since: p.since || lastDay };
      const frames = D.framesFor(spec, [...list, ...Object.keys(held)], true);
      if (a.auto_learn && (a.inbox_log || []).length) {
        const T = E.watchTune(spec, frames, a.inbox_log, { over: a.learned?.params || null });
        if (T.suggestion && JSON.stringify(T.suggestion.params) !== JSON.stringify(a.learned?.params || null)) {
          const learned = { params: T.suggestion.params, at: lastDay, from: T.current.params, stats: { n: T.suggestion.stats.n, win_pct: T.suggestion.stats.win_pct, avg_pct: T.suggestion.stats.avg_pct }, before: { n: T.current.stats.n, win_pct: T.current.stats.win_pct, avg_pct: T.current.stats.avg_pct } };
          writes.push({ op: "update", collection: "agents", doc_id: aid, data: { learned } }); a.learned = learned;
          events.push({ kind: "learned", agent: aid, severity: "info", title: `${a.name} adjusted its settings from its record`, detail: T.suggestion.changed.map((k) => `${k} ${T.current.params[k]} → ${T.suggestion.params[k]}`).join(", ") + ` (avg ${T.current.stats.avg_pct}% → ${T.suggestion.stats.avg_pct}% a call)` });
        }
      }
      res = { watch: E.watchSignals(spec, frames, { list, held, over: a.auto_learn && a.learned?.params ? a.learned.params : null }) };
    } else {
      const frames = D.framesFor(spec);
      res = E.run(spec, frames, man.universes, { start: specs[aid].test?.start || "2012-01-01" });
    }
    plans[aid] = O.agentTargets(a, spec, res, O.sleeveEquity(sl, px), px, man.symbols, nextSession);
  } catch (e) { log.push(`${a.name}: ${e.message || e}`); }
}
const built = O.buildOrders({ state, book: config, desks, agents: agentDocs, plans, px, meta: man.symbols, date: lastDay, nextSession });
const existing = new Set(allOrders.map((o) => o.id));
const newOrders = built.orders.filter((o) => !existing.has(o.id));
for (const o of newOrders) writes.push({ op: "set", collection: "orders", doc_id: o.id, data: o });
for (const [id, u] of Object.entries(built.deskUpdates)) writes.push({ op: "update", collection: "desks", doc_id: id, data: u });
for (const e of built.events) events.push(e);
if (built.kill && !config.kill_switch) writes.push({ op: "update", collection: "book", doc_id: "config", data: { kill_switch: true, kill_reason: `book drawdown ${built.bookDD.toFixed(1)}%`, kill_at: lastDay } });

// ---- 6. alerts
const research = (() => { try { const p = path.join(D.data, "research.json"); if (!fs.existsSync(p)) return {}; const js = JSON.parse(fs.readFileSync(p, "utf8")); return js.b64gz ? JSON.parse(require("node:zlib").gunzipSync(Buffer.from(js.b64gz, "base64")).toString("utf8")) : js; } catch (e) { return {}; } })();
const news = [...(research.filings?.items || []).map((x) => ({ t: x.t, sym: x.sym, text: `${x.sym}: ${x.desc}${x.text ? " — " + x.text : ""}` })), ...(research.headlines?.items || []).map((x) => ({ t: x.t, syms: x.syms, text: x.title }))];
const seriesOf = (scope, id) => history.map((r) => scope === "book" ? r.equity : scope === "desk" ? r.desks?.[id] : r.sleeves?.[id]).filter((x) => x > 0);
const label = (scope, id) => scope === "book" ? "The book" : scope === "desk" ? (desks.find((d) => d.id === id)?.name || "Desk") : (agentDocs.find((a) => a.id === id)?.name || "Agent");
const signals = Object.fromEntries((daily.results || []).map((r) => [r.id, r.signals || []]));
const fired = AL.evalAlerts({ alerts: alerts.filter((a) => a.last_fired !== lastDay), E, frame: (s) => D.priceFrame(s), date: lastDay, book: { series: seriesOf, label }, news, events: research.events?.items || [], signals });
for (const f of fired) {
  writes.push({ op: "set", collection: "alert_events", doc_id: `${lastDay}_${f.alert_id}`, data: { ...f, at: new Date().toISOString() } });
  if (!f.error) writes.push({ op: "update", collection: "alerts", doc_id: f.alert_id, data: { last_fired: lastDay, last_checked: new Date().toISOString().slice(0, 16).replace("T", " ") } });
}
for (const a of alerts.filter((x) => x.kind === "news" && !fired.some((f) => f.alert_id === x.id))) writes.push({ op: "update", collection: "alerts", doc_id: a.id, data: { last_checked: new Date().toISOString().slice(0, 16).replace("T", " ") } });
events.forEach((e, i) => { if (e.kind && /halt|kill/.test(e.kind) || e.kind?.startsWith("sleeve") || e.kind === "capital_changed" || e.kind === "learned") writes.push({ op: "set", collection: "alert_events", doc_id: `${lastDay}_sys_${i}_${e.kind}`, data: { date: lastDay, at: new Date().toISOString(), severity: e.severity || "info", title: e.title, detail: e.detail || "", system: e.kind !== "learned" } }); });

// ---- 7. book state and history
state.next_session = nextSession; state.updated_at = new Date().toISOString();
writes.push({ op: "set", collection: "book", doc_id: "state", data: state });
writes.push({ op: "set", collection: "book", doc_id: "history", data: { rows: history } });

const pend = newOrders.filter((o) => o.status === "pending").length, auto = newOrders.filter((o) => o.status === "approved").length, blocked = newOrders.filter((o) => o.status === "blocked").length;
const crit = [...events.filter((e) => e.severity === "critical"), ...fired.filter((f) => f.severity === "critical")];
const summary = { date: lastDay, next_session: nextSession, equity: snap.equity, gross: snap.gross, desks: snap.desks, fills: fills.length, orders_new: newOrders.length, orders_pending_approval: pend, orders_auto: auto, orders_blocked: blocked,
  alerts_fired: fired.length, critical: crit.map((e) => e.title), sleeves: Object.keys(state.sleeves).length, log };
const push_text = (newOrders.length || fired.length || crit.length)
  ? `TradeOS book ${lastDay}: ${fills.length} filled, ${newOrders.length} order(s) for ${nextSession}${pend ? ` (${pend} need your approval)` : ""}${fired.length ? `, ${fired.length} alert(s)` : ""}${crit.length ? `. ${crit[0].title}` : ""}`.slice(0, 190) : "";
// Ready-to-send ArtifactData batches: each write's document goes to its own file; "exists" marks writes that need the
// document's if_version (taken from the export listing) before sending.
const wdir = outFile.replace(/\.json$/, "") + "_writes"; fs.rmSync(wdir, { recursive: true, force: true }); fs.mkdirSync(wdir, { recursive: true });
const known = new Set([...desks.map((d) => "desks/" + d.id), ...agentDocs.map((d) => "agents/" + d.id), ...allOrders.map((d) => "orders/" + d.id), ...alerts.map((d) => "alerts/" + d.id),
  ...["config", "state", "history"].filter((id) => one("book", id)).map((id) => "book/" + id)]);
const batches = []; let cur = [], bytes = 0;
writes.forEach((w, i) => { const fp = path.resolve(wdir, `${String(i).padStart(4, "0")}_${w.collection}_${w.doc_id}.json`.replace(/[^\w.\-\/]/g, "_")); const body = JSON.stringify(w.data || {});
  fs.writeFileSync(fp, body); if (cur.length >= 45 || bytes + body.length > 800000) { batches.push(cur); cur = []; bytes = 0; }
  cur.push({ op: w.op, collection: w.collection, doc_id: w.doc_id, ...(w.op === "delete" ? {} : { file_path: fp }), exists: known.has(w.collection + "/" + w.doc_id) }); bytes += body.length; });
if (cur.length) batches.push(cur);
fs.writeFileSync(path.join(wdir, "batches.json"), JSON.stringify(batches, null, 1));
fs.writeFileSync(outFile, JSON.stringify({ writes, summary, push_text, events, fired, batches_file: path.join(wdir, "batches.json") }, null, 1));
console.log(JSON.stringify(summary, null, 1));
