// The fund's book on paper, run NOW. Two modes:
//   live  (during the session, --live quotes.json): every paper agent decides on today's live prices (the live quote is
//         appended as today's bar), its orders are sized inside the desk's limits and FILL AT ONCE at the live price
//         (+slippage, itemised Indian charges); approved-but-unfilled orders fill too; manual desks' orders wait for the
//         team (they fill the moment they're approved). The book is marked to live prices.
//   mark  (after the close, no --live): nothing trades. The book is marked to the close, unapproved orders from the
//         session expire, options/intraday sleeves follow their agents' paper records, daily-list agents learn, and alerts
//         are evaluated.
//   node scripts/book_run.mjs <app_build_dir> <db_export_dir> <agents.json> <daily.json> <out.json> [--live quotes.json] [--max-age-min 20]
// db_export_dir holds the app database as ArtifactData exports (one JSON file per document):
//   desks/*.json, agents/*.json, book/{config,state,history}.json, orders/*.json (any; only pending/approved are acted on), alerts/*.json
// agents.json: the paper agents with their paper version's spec; daily.json: daily_run.mjs output (mark mode; optional in live mode).
// quotes.json: the live-quotes branch snapshot (tradeos/live/market_feed.py). Paper only: nothing reaches a broker.
// out.json: {writes: [{op, collection, doc_id, data}], summary, push_text, events}
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { E, loadData } from "./lib_frames.mjs";

const require = createRequire(import.meta.url);
const here = path.dirname(new URL(import.meta.url).pathname);
const O = require(path.join(here, "..", "lab", "oms.js"));
const AL = require(path.join(here, "..", "lab", "alerts.js"));
const argv = process.argv.slice(2), flag = (k) => { const i = argv.indexOf(k); if (i < 0) return null; const v = argv[i + 1]; argv.splice(i, 2); return v; };
const liveFile = flag("--live"), maxAge = Number(flag("--max-age-min") || 20);
const [dir, dbdir, agentsFile, dailyFile, outFile] = argv;
if (!outFile) { console.error("usage: node scripts/book_run.mjs <app_build_dir> <db_export_dir> <agents.json> <daily.json> <out.json> [--live quotes.json]"); process.exit(2); }

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
const daily = dailyFile && fs.existsSync(dailyFile) ? JSON.parse(fs.readFileSync(dailyFile, "utf8")) : { results: [] };
const R = Object.fromEntries((daily.results || []).map((r) => [r.id, r]));
const writes = [], events = [], log = [];
const nowIso = new Date().toISOString();
const istNow = new Date(Date.now() + 5.5 * 3600e3), istHHMM = istNow.toISOString().slice(11, 16);

// ---- live quotes (live mode)
let Q = null, mode = "mark", today = lastDay, staleReason = null;
if (liveFile) {
  mode = "live";
  try { Q = JSON.parse(fs.readFileSync(liveFile, "utf8")); } catch (e) { staleReason = `no live quotes (${e.message})`; }
  if (Q) {
    const age = (Date.now() - Date.parse(Q.asof)) / 60e3, todayIst = istNow.toISOString().slice(0, 10);
    if (Q.date !== todayIst) staleReason = `live quotes are from ${Q.date}, not today (${todayIst}) — market holiday or the intraday runner isn't running`;
    else if (!(age <= maxAge)) staleReason = `live quotes are ${Math.round(age)} minutes old (limit ${maxAge})`;
    today = Q.date;
  }
}
const nseIdx = {}; if (Q?.nse_indices) for (const [n, v] of Object.entries(Q.nse_indices)) nseIdx[E.nseNorm(n)] = v;
function liveQuote(s) {
  if (!Q) return null;
  const arr = Q.quotes?.[s] || Q.indices?.[s] || (man.symbols[s]?.kind === "index" ? E.nseIndexRow(s, nseIdx, man.symbols) : null);
  if (!arr || !(arr[0] > 0)) return null;
  const [ltp, open, high, low, prev_close, value_cr, ts] = arr;
  return { ltp, open, high, low, prev_close, value_cr, ts };
}
const lastCloseCache = {};
function lastClose(s) {
  if (s in lastCloseCache) return lastCloseCache[s];
  const f = D.light[s] || D.priceFrame(s); let v = null;
  if (f) { const want = E.dayOf(lastDay); for (let i = f.d.length - 1; i >= 0; i--) if (f.d[i] <= want && f.c[i] === f.c[i]) { v = f.c[i]; break; } }
  return (lastCloseCache[s] = v);
}
const trading = mode === "live" && !staleReason;
const px = (s) => (trading ? liveQuote(s)?.ltp : null) ?? lastClose(s);

if (mode === "live" && staleReason) {
  // never trade on old prices: report and stop without writing
  const summary = { mode, date: today, traded: false, reason: staleReason };
  fs.writeFileSync(outFile, JSON.stringify({ writes: [], summary, push_text: "", events: [], batches_file: null }, null, 1));
  console.log(JSON.stringify(summary, null, 1)); process.exit(0);
}

// ---- 1. capital follows the desks (agents' sleeves and the desks' manual sleeves)
for (const e of O.syncSleeves(state, desks, agentDocs, today)) events.push({ ...e, severity: "info", title: sysTitle(e) });
function sysTitle(e) {
  const nm = (id) => O.isManual(id) ? "Manual trades" : agentDocs.find((a) => a.id === id)?.name || id, dn = (id) => desks.find((d) => d.id === id)?.name || id, inr = (x) => "₹" + Math.round(x).toLocaleString("en-IN");
  return e.kind === "sleeve_opened" ? `${nm(e.agent)} joined ${dn(e.desk)} with ${inr(e.capital)}` : e.kind === "capital_changed" ? `${nm(e.agent)}: capital ${inr(e.from)} → ${inr(e.to)}`
    : e.kind === "sleeve_closing" ? `${nm(e.agent)} is being wound down` : e.kind === "sleeve_closed" ? `${nm(e.agent)} closed; ${inr(e.cash)} back to the desk` : e.kind === "sleeve_moved" ? `${nm(e.agent)} moved to ${dn(e.to)}` : e.kind;
}

const fillsAll = [];
let newOrders = [], built = null, nextSession = null;
const orderWrite = (id, data) => writes.push({ op: "update", collection: "orders", doc_id: id, data: { ...data, id: undefined, updated_at: nowIso } });

if (trading) {
  // ---- 2. approved orders not filled yet (approved outside market hours, or by a manual desk since the last run) fill now
  const { fills, updates } = O.fillNow({ state, orders: openOrders, quote: (s) => liveQuote(s)?.ltp ?? null, at: nowIso, today, meta: man.symbols });
  for (const u of updates) orderWrite(u.id, u);
  for (const f of fills) { fillsAll.push(f); log.push(`filled ${f.side} ${f.qty} ${f.sym} @${f.fill_price} (approved earlier)`); }

  // ---- 3. every paper agent decides on live prices
  let nx = E.dayOf(today) + 1; while (((new Date(nx * 864e5).getUTCDay() + 6) % 7) > 4) nx++;
  nextSession = E.isoOf(nx);
  const tday = E.dayOf(today), quoteOf = (s) => { const q = liveQuote(s); return q ? { ltp: q.ltp, open: q.open, high: q.high, low: q.low, value_cr: q.value_cr } : null; };
  const pastSessions = Array.from(D.light.NIFTY ? D.light.NIFTY.d : []).filter((d) => d < tday);
  const plans = {}, specs = Object.fromEntries(paperAgents.map((a) => [a.id, a.version]));
  for (const [aid, sl] of Object.entries(state.sleeves)) {
    const a = agentDocs.find((x) => x.id === aid);
    if (!sl.oms || sl.closing || !a || a.status !== "paper" || !specs[aid]?.spec) continue;
    try {
      const spec = E.normalize(specs[aid].spec, man.universes);
      let res, liveN = 0;
      if (spec.type === "watchlist") { // today's list = names sent since the last close (or for today); plus what the sleeve holds
        const list = E.watchLive(a.inbox_log || [], pastSessions, spec.list_days, true), held = {};
        for (const [s, p] of Object.entries(sl.positions || {})) if (p.qty) held[s] = { qty: p.qty, avg: p.avg, since: p.since || today };
        const L = E.withLiveBars(D.framesFor(spec, [...list, ...Object.keys(held)], true), quoteOf, tday); liveN = L.live;
        res = { watch: E.watchSignals(spec, L.frames, { list, held, over: a.auto_learn && a.learned?.params ? a.learned.params : null }) };
      } else {
        const L = E.withLiveBars(D.framesFor(spec), quoteOf, tday); liveN = L.live;
        res = E.run(spec, L.frames, man.universes, { start: specs[aid].test?.start || "2012-01-01" });
      }
      plans[aid] = O.agentTargets(a, spec, res, O.sleeveEquity(sl, px), px, man.symbols, nextSession);
      log.push(`${a.name}: decided on ${liveN} live price(s)`);
    } catch (e) { log.push(`${a.name}: ${e.message || e}`); }
  }
  const stamp = `${today}T${istHHMM.replace(":", "")}`;
  built = O.buildOrders({ state, book: config, desks, agents: agentDocs, plans, px, meta: man.symbols, date: today, nextSession, stamp });
  const existing = new Set(allOrders.map((o) => o.id));
  newOrders = built.orders.filter((o) => !existing.has(o.id)).map((o) => ({ ...o, decided_at: nowIso, decided_on: "live prices", live_ts: liveQuote(o.sym)?.ts || null }));
  // ---- 4. ...and the approved ones fill at once at the same live price
  const fn = O.fillNow({ state, orders: newOrders, quote: (s) => liveQuote(s)?.ltp ?? null, at: nowIso, today, meta: man.symbols });
  const filled = Object.fromEntries(fn.updates.map((u) => [u.id, u]));
  for (const u of O.supersede(openOrders.filter((o) => !fillsAll.some((f) => f.id === o.id)), newOrders, nowIso)) orderWrite(u.id, u);
  for (const o of newOrders) writes.push({ op: "set", collection: "orders", doc_id: o.id, data: { ...o, ...(filled[o.id] || {}), id: undefined } });
  for (const f of fn.fills) { fillsAll.push(f); log.push(`${f.side} ${f.qty} ${f.sym} @${f.fill_price} (live ${f.ref_price}) for ${agentDocs.find((a) => a.id === f.agent)?.name || f.agent}`); }
  for (const [id, u] of Object.entries(built.deskUpdates)) writes.push({ op: "update", collection: "desks", doc_id: id, data: u });
  for (const e of built.events) events.push(e);
  if (built.kill && !config.kill_switch) writes.push({ op: "update", collection: "book", doc_id: "config", data: { kill_switch: true, kill_reason: `book drawdown ${built.bookDD.toFixed(1)}%`, kill_at: today } });
} else {
  // ---- 2m. after the close nothing trades: orders nobody approved during the session expire; orders queued by the old
  // evening run "for the next open" (before 14 Oct 2026) expire too — agents now decide again on live prices.
  for (const o of openOrders) {
    if (o.status === "pending" && o.session <= lastDay) orderWrite(o.id, { status: "expired", note: "not approved during the session" });
    else if (o.status === "approved" && !/^\d{4}-\d{2}-\d{2}T\d{4}_/.test(String(o.id)) && !o.created_by) orderWrite(o.id, { status: "expired", note: "queued for the next open by the old evening run; agents now trade on live prices during the session" });
  }
  // options and intraday agents keep their own paper records: their sleeves follow the agent's paper equity
  const newDay = !state.asof || state.asof < lastDay;
  for (const [aid, sl] of Object.entries(state.sleeves)) {
    if (sl.oms || sl.manual) continue;
    const eq = R[aid]?.paper?.equity; if (!eq) continue;
    if (sl.ext_last && newDay) sl.cash = sl.cash * (eq / sl.ext_last);
    sl.ext_last = eq;
  }
  // daily-list agents with learning on apply what they learned from their record (no orders)
  const sessions = Array.from(D.light.NIFTY ? D.light.NIFTY.d : []).filter((d) => d <= E.dayOf(lastDay));
  const specs = Object.fromEntries(paperAgents.map((a) => [a.id, a.version]));
  for (const a of agentDocs) {
    if (a.status !== "paper" || !a.auto_learn || !(a.inbox_log || []).length || !specs[a.id]?.spec) continue;
    try {
      const spec = E.normalize(specs[a.id].spec, man.universes); if (spec.type !== "watchlist") continue;
      const list = E.watchLive(a.inbox_log || [], sessions, spec.list_days), frames = D.framesFor(spec, list, true);
      const T = E.watchTune(spec, frames, a.inbox_log, { over: a.learned?.params || null });
      if (T.suggestion && JSON.stringify(T.suggestion.params) !== JSON.stringify(a.learned?.params || null)) {
        const learned = { params: T.suggestion.params, at: lastDay, from: T.current.params, stats: { n: T.suggestion.stats.n, win_pct: T.suggestion.stats.win_pct, avg_pct: T.suggestion.stats.avg_pct }, before: { n: T.current.stats.n, win_pct: T.current.stats.win_pct, avg_pct: T.current.stats.avg_pct } };
        writes.push({ op: "update", collection: "agents", doc_id: a.id, data: { learned } });
        events.push({ kind: "learned", agent: a.id, severity: "info", title: `${a.name} adjusted its settings from its record`, detail: T.suggestion.changed.map((k) => `${k} ${T.current.params[k]} → ${T.suggestion.params[k]}`).join(", ") + ` (avg ${T.current.stats.avg_pct}% → ${T.suggestion.stats.avg_pct}% a call)` });
      }
    } catch (e) { log.push(`${a.name}: ${e.message || e}`); }
  }
}

// ---- 5. mark the book (live prices during the session, the close after it)
const snap = O.markBook(state, px, today);
snap.at = trading ? `${istHHMM} IST` : "close";
if (history.length && history[history.length - 1].date === today) history[history.length - 1] = snap; else history.push(snap);
while (history.length > 3000) history.shift();

// ---- 6. alerts (after the close)
let fired = [];
if (!trading) {
  const research = (() => { try { const p = path.join(D.data, "research.json"); if (!fs.existsSync(p)) return {}; const js = JSON.parse(fs.readFileSync(p, "utf8")); return js.b64gz ? JSON.parse(require("node:zlib").gunzipSync(Buffer.from(js.b64gz, "base64")).toString("utf8")) : js; } catch (e) { return {}; } })();
  const news = [...(research.filings?.items || []).map((x) => ({ t: x.t, sym: x.sym, text: `${x.sym}: ${x.desc}${x.text ? " — " + x.text : ""}` })), ...(research.headlines?.items || []).map((x) => ({ t: x.t, syms: x.syms, text: x.title }))];
  const seriesOf = (scope, id) => history.map((r) => scope === "book" ? r.equity : scope === "desk" ? r.desks?.[id] : r.sleeves?.[id]).filter((x) => x > 0);
  const label = (scope, id) => scope === "book" ? "The book" : scope === "desk" ? (desks.find((d) => d.id === id)?.name || "Desk") : (agentDocs.find((a) => a.id === id)?.name || "Agent");
  const signals = Object.fromEntries((daily.results || []).map((r) => [r.id, r.signals || []]));
  fired = AL.evalAlerts({ alerts: alerts.filter((a) => a.last_fired !== lastDay), E, frame: (s) => D.priceFrame(s), date: lastDay, book: { series: seriesOf, label }, news, events: research.events?.items || [], signals });
  for (const f of fired) {
    writes.push({ op: "set", collection: "alert_events", doc_id: `${lastDay}_${f.alert_id}`, data: { ...f, at: nowIso } });
    if (!f.error) writes.push({ op: "update", collection: "alerts", doc_id: f.alert_id, data: { last_fired: lastDay, last_checked: nowIso.slice(0, 16).replace("T", " ") } });
  }
  for (const a of alerts.filter((x) => x.kind === "news" && !fired.some((f) => f.alert_id === x.id))) writes.push({ op: "update", collection: "alerts", doc_id: a.id, data: { last_checked: nowIso.slice(0, 16).replace("T", " ") } });
}
const evKey = trading ? `${today}T${istHHMM.replace(":", "")}` : lastDay;
events.forEach((e, i) => { if (e.kind && /halt|kill/.test(e.kind) || e.kind?.startsWith("sleeve") || e.kind === "capital_changed" || e.kind === "learned") writes.push({ op: "set", collection: "alert_events", doc_id: `${evKey}_sys_${i}_${e.kind}`, data: { date: today, at: nowIso, severity: e.severity || "info", title: e.title, detail: e.detail || "", system: e.kind !== "learned" } }); });

// ---- 7. book state and history
state.updated_at = nowIso; state.marked = trading ? { at: nowIso, by: "live run", prices: `NSE live ${Q.asof}` } : { at: nowIso, by: "evening run", prices: `close ${lastDay}` };
if (trading) { state.last_live_run = nowIso; writes.push({ op: "set", collection: "live", doc_id: "quotes", data: { ...Q, written_at: nowIso } }); } // every NSE stock for the app
delete state.next_session;
writes.push({ op: "set", collection: "book", doc_id: "state", data: state });
writes.push({ op: "set", collection: "book", doc_id: "history", data: { rows: history } });

const pend = newOrders.filter((o) => o.status === "pending").length, blocked = newOrders.filter((o) => o.status === "blocked").length;
const charges = fillsAll.reduce((t, f) => t + (f.fee || 0), 0), traded = fillsAll.reduce((t, f) => t + Math.abs(f.gross_value || f.qty * f.fill_price), 0);
const crit = [...events.filter((e) => e.severity === "critical"), ...fired.filter((f) => f.severity === "critical")];
const summary = { mode, date: today, at: trading ? `${istHHMM} IST` : "after the close", prices: trading ? `NSE live, snapshot ${Q.asof}` : `close of ${lastDay}`, equity: snap.equity, gross: snap.gross, desks: snap.desks,
  trades: fillsAll.length, traded_value: Math.round(traded), charges: Math.round(charges), orders_new: newOrders.length, orders_pending_approval: pend, orders_blocked: blocked,
  alerts_fired: fired.length, critical: crit.map((e) => e.title), sleeves: Object.keys(state.sleeves).length, log };
const push_text = trading
  ? ((fillsAll.length || pend || crit.length) ? `TradeOS ${istHHMM} IST: ${fillsAll.length} paper trade(s) at live prices (₹${Math.round(traded).toLocaleString("en-IN")}, charges ₹${Math.round(charges).toLocaleString("en-IN")})${pend ? `, ${pend} awaiting your approval` : ""}${crit.length ? `. ${crit[0].title}` : ""}`.slice(0, 190) : "")
  : ((fired.length || crit.length) ? `TradeOS book ${lastDay}: marked at the close${fired.length ? `, ${fired.length} alert(s)` : ""}${crit.length ? `. ${crit[0].title}` : ""}`.slice(0, 190) : "");
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
fs.writeFileSync(outFile, JSON.stringify({ writes, summary, push_text, events, fired, fills: fillsAll, batches_file: path.join(wdir, "batches.json") }, null, 1));
console.log(JSON.stringify(summary, null, 1));
