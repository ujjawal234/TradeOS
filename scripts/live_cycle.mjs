// The continuous paper-agent runner for market hours (09:15–15:30 IST, weekdays). A Claude scheduled task
// ("TradeOS agents run continuously", prompt docs/live_runner_task.md) drives it: every minute it calls `tick`, sends the
// ArtifactData batch the tick prints (if any) and feeds the result back with `ack`. This script does all the deciding;
// scripts/book_run.mjs does the trading (live price + 0.05% slippage, itemised Indian charges, desk limits).
//
//   node scripts/live_cycle.mjs init <holder> [--until HH:MM]   new session: state in build/loop/, ends at --until IST (default 15:31)
//   node scripts/live_cycle.mjs versions < tool-output.txt       record document versions from ArtifactData list/get/batch outputs
//   node scripts/live_cycle.mjs need                             which agent version docs to get for build/agents.json
//   node scripts/live_cycle.mjs agents                           write build/agents.json (paper agents + their paper version's spec)
//   node scripts/live_cycle.mjs tick                             one minute's run: prints {action, ...} (see below)
//   node scripts/live_cycle.mjs ack < batch-result.txt           the batch went through (apply it locally) or failed (resync)
//
// tick prints one JSON line with "action":
//   "wait"     nothing to do until `seconds` from now (before 09:15, or waiting for another session's lease)
//   "idle"     ran; nothing to send this minute (logged locally, sent with the next batch)
//   "send"     send `writes` with ArtifactData "batch" exactly as given (if_version already filled in), then `ack`
//   "resync"   re-export the database (docs/live_runner_task.md step 3), record versions, rebuild agents, tick again
//   "need"     get these documents' versions first (`docs`), then tick again
//   "done"     the session is over (after its final send, if any)
// Cadence: daily-list agents decide on every new live price snapshot (about once a minute); rule and rotation agents every
// 5 minutes; intraday agents are traded by the intraday runner on each bar close (GitHub Actions, NSE live data every
// minute) — the Names box's changes reach it through intraday/agents.json, which `tick` commits to main within a minute.
// Paper only: nothing here reaches a broker.
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const B = path.join(ROOT, "build"), DB = path.join(B, "db"), VERS = path.join(B, "versions"), LOOP = path.join(B, "loop");
const SF = path.join(LOOP, "state.json"), VF = path.join(LOOP, "versions.json"), PF = path.join(LOOP, "pending.json");
const APP_URL = "https://claude.ai/artifact/UzWps1YcpqDBjcPfmDupkW";
const RESYNC_MIN = 15, FLUSH_MIN = 3, LEASE_MIN = 6, RULE_EVERY_MIN = 5, FULL_EVERY_MIN = 5, MAX_QUOTE_AGE_MIN = 8;
const [cmd, ...args] = process.argv.slice(2);
const rj = (f, d = null) => { try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch (e) { return d; } };
const wj = (f, x) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, JSON.stringify(x, null, 1)); };
const stdin = () => { try { return fs.readFileSync(0, "utf8"); } catch (e) { return ""; } };
const ist = (d = new Date()) => new Date(d.getTime() + 5.5 * 3600e3);
const istDate = (d) => ist(d).toISOString().slice(0, 10), istHM = (d) => ist(d).toISOString().slice(11, 16);
const minOfDay = (d = new Date()) => { const x = ist(d); return x.getUTCHours() * 60 + x.getUTCMinutes(); };
const hm2m = (s) => +s.slice(0, 2) * 60 + +s.slice(3, 5);
const out = (x) => { console.log(JSON.stringify(x)); process.exit(0); };
const docs = (col) => { const d = path.join(DB, col); if (!fs.existsSync(d)) return []; return fs.readdirSync(d).filter((f) => f.endsWith(".json")).map((f) => ({ id: f.slice(0, -5), ...rj(path.join(d, f), {}) })); };
const docFile = (col, id) => path.join(DB, col, String(id).replace(/~/g, "@") + ".json");
const git = (...a) => execFileSync("git", ["-C", ROOT, ...a], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 90e3 });

// ---------------------------------------------------------------- versions from tool output
const fileId = (id) => String(id).replace(/~/g, "@"), idOfFile = (f) => String(f).replace(/@/g, "~"); // ArtifactData spells "~" as "@" in file names
function parseVersions(text) {
  const v = {};
  // overflow lines:  ...under "/abs/build/db/live_1m" ... [10 more saved documents, ... (id, version): "TARIL" 5, "TCS" 5]
  for (const blk of text.matchAll(/under\s+"([^"]+)"(?:(?!under\s+")[\s\S])*?\[(\d+) more saved documents[^\]]*?:\s*([^\]]*)\]/g)) {
    const abs = path.resolve(blk[1]);
    for (const base of [DB, VERS]) if (abs === base || abs.startsWith(base + path.sep)) { const col = path.relative(base, abs).split(path.sep).join("/"); for (const m of blk[3].matchAll(/"([^"]+)"\s+(\d+)/g)) v[col + "/" + m[1]] = +m[2]; }
  }
  // list/get with out_dir:  - "docid"  421 bytes  version 3  "/abs/build/db/desks/docid.json"
  for (const m of text.matchAll(/version\s+(\d+)\s+"([^"]+\.json)"/g)) {
    const abs = path.resolve(m[2]);
    for (const base of [DB, VERS]) if (abs.startsWith(base + path.sep)) { const rel = path.relative(base, abs).slice(0, -5).split(path.sep); const id = idOfFile(rel.pop()); v[rel.join("/") + "/" + id] = +m[1]; }
  }
  // batch / set / update results:  - update "book"/"state" (version 12)
  for (const m of text.matchAll(/"([^"]+)"\/"([^"]+)"\s*\(version\s+(\d+)\)/g)) v[m[1] + "/" + m[2]] = +m[3];
  return v;
}

if (cmd === "init") {
  const holder = args[0] || "session_" + Math.random().toString(36).slice(2, 10), ui = args.indexOf("--until");
  const until = ui >= 0 ? args[ui + 1] : "15:31";
  fs.mkdirSync(LOOP, { recursive: true });
  const prev = rj(SF, {});
  wj(SF, { holder, until, date: istDate(), started: new Date().toISOString(), last_export: prev.date === istDate() ? prev.last_export || null : null, last_send: null,
    last_check: {}, last_seen_asof: {}, names_applied: prev.date === istDate() ? prev.names_applied || {} : {}, last_full: null, log: [], resync: false });
  fs.rmSync(PF, { force: true });
  out({ ok: true, holder, until, date: istDate() });
}

// what a resync reads: the documents the team can change from the app (desks, agents, open orders, the book, Names box) —
// and, on a full resync (session start, after a lease change, or repeated refusals), the docs only the runner writes
const today0 = istDate();
function resyncReads(full) {
  const r = [
    { action: "list", collection: "desks", out_dir: DB, query: { limit: 1000 } },
    { action: "list", collection: "agents", out_dir: DB, query: { limit: 1000 } },
    { action: "query", collection: "orders", out_dir: DB, query: { where: [["status", "in", ["pending", "approved"]]], limit: 1000 } },
    { action: "get", collection: "book", doc_id: "config", out_dir: DB }, { action: "get", collection: "book", doc_id: "state", out_dir: DB }, { action: "get", collection: "book", doc_id: "history", out_dir: DB },
    { action: "list", collection: "live_names", out_dir: DB, query: { limit: 1000 } },
    { action: "get", collection: "live", doc_id: "runner", out_dir: DB },
    { action: "get", collection: "data/users/me", doc_id: "watchlist", out_dir: DB },
  ];
  if (full) r.push({ action: "list", collection: "live", out_dir: DB, query: { limit: 1000 } }, { action: "list", collection: "live_1m", out_dir: DB, query: { limit: 1000 } }, { action: "get", collection: "runs", doc_id: today0, out_dir: DB });
  return r;
}
if (cmd === "prep") { // clear the local copies a resync is about to re-read (so nothing stale survives, e.g. an order the app filled)
  const full = args.includes("--full");
  for (const c of ["desks", "agents", "orders", "book", "live_names", ...(full ? ["live", "live_1m", "runs"] : [])]) fs.rmSync(path.join(DB, c), { recursive: true, force: true });
  fs.rmSync(docFile("live", "runner"), { force: true });
  if (full) { fs.rmSync(VF, { force: true }); fs.rmSync(VERS, { recursive: true, force: true }); }
  out({ ok: true, full, reads: resyncReads(full), then: "make every read (follow next_cursor if any), then pipe ALL their outputs into `node scripts/live_cycle.mjs versions --export" + (full ? " --full" : "") + "`, then `need` / get / `agents`, then `tick`" });
}

if (cmd === "versions") {
  const v = { ...rj(VF, {}), ...parseVersions(stdin()) }; wj(VF, v);
  const st = rj(SF); if (st && args.includes("--export")) { st.last_export = new Date().toISOString(); st.resync = false; if (args.includes("--full")) { st.full_export = st.holder; st.refusals = 0; } wj(SF, st); }
  out({ ok: true, known: Object.keys(v).length });
}

// paper agents and the version docs their paper version needs
const paperAgents = () => docs("agents").filter((a) => a.status === "paper" && a.paper && a.paper.version);
const verId = (n) => "v" + String(n).padStart(3, "0");
if (cmd === "need") {
  const need = paperAgents().filter((a) => !fs.existsSync(path.join(VERS, "agents", a.id, "versions", verId(a.paper.version) + ".json")))
    .map((a) => ({ collection: `agents/${a.id}/versions`, doc_id: verId(a.paper.version), out_dir: VERS }));
  out({ need });
}
if (cmd === "agents") {
  const list = [], missing = [];
  for (const a of paperAgents()) {
    const v = rj(path.join(VERS, "agents", a.id, "versions", verId(a.paper.version) + ".json"));
    if (!v) { missing.push(a.id); continue; }
    const x = { id: a.id, name: a.name, status: a.status, type: a.type, desk_id: a.desk_id, alloc_pct: a.alloc_pct, paper: a.paper, version: { spec: v.spec, test: v.test } };
    if (a.type === "watchlist") for (const k of ["inbox_log", "auto_learn", "learned"]) if (a[k] != null) x[k] = a[k];
    list.push(x);
  }
  wj(path.join(B, "agents.json"), list);
  out({ ok: !missing.length, agents: list.length, missing });
}

// ---------------------------------------------------------------- ack
if (cmd === "ack") {
  const text = stdin(), st = rj(SF), pend = rj(PF);
  if (!st) out({ ok: false, error: "no session: run init" });
  const ok = /committed|applied/i.test(text) && !/refused|failed|error|conflict|not applied/i.test(text);
  if (!pend) out({ ok: true, note: "nothing pending" });
  if (!ok) { st.resync = true; st.refusals = (st.refusals || 0) + 1; if (st.refusals >= 2) st.full_export = null; wj(SF, st); fs.rmSync(PF, { force: true }); out({ ok: false, next: "resync" }); }
  st.refusals = 0;
  const v = { ...rj(VF, {}), ...parseVersions(text) }; wj(VF, v);
  for (const w of pend.writes) { // keep the local copy of the database in step with what was written
    const f = docFile(w.collection, w.doc_id), data = rj(w.file_path, {});
    if (w.op === "delete") fs.rmSync(f, { force: true });
    else if (w.op === "set") wj(f, data);
    else wj(f, { ...rj(f, {}), ...data });
  }
  if ((pend.rest || []).length) { // more batches from the same run (e.g. today's 1-minute bars): send the next one, then ack again
    wj(PF, { ...pend, writes: pend.rest[0], rest: pend.rest.slice(1) });
    out({ ok: true, next: "send", url: APP_URL, writes: pend.rest[0], more_batches: pend.rest.length - 1 });
  }
  st.last_send = new Date().toISOString(); st.log = (st.log || []).slice(pend.log_sent || 0);
  wj(SF, st); fs.rmSync(PF, { force: true });
  out({ ok: true, sent: pend.writes.length, ended: !!pend.final });
}

// ---------------------------------------------------------------- tick
if (cmd !== "tick") { console.error("usage: node scripts/live_cycle.mjs init|versions|need|agents|tick|ack"); process.exit(2); }
const st = rj(SF); if (!st) out({ action: "resync", why: "no session state: run init first" });
if (fs.existsSync(PF)) out({ action: "send", writes: rj(PF).writes, note: "the last batch was never acknowledged: send it (or ack its result) first" });
const now = new Date(), today = istDate(now), mNow = minOfDay(now), hhmm = istHM(now);
const dow = ist(now).getUTCDay();
if (dow === 0 || dow === 6) out({ action: "done", why: "weekend" });
if (st.date !== today) out({ action: "done", why: "session state is from another day" });
const endM = Math.min(hm2m(st.until), hm2m("15:31"));
const versions = rj(VF, {});
const lease = rj(docFile("live", "runner"), null);
const mine = !lease || lease.holder === st.holder || Date.parse(lease.until || 0) < now.getTime() - 30e3;
if (mNow < hm2m("09:15")) out({ action: "wait", seconds: Math.max(15, (hm2m("09:15") - mNow) * 60 - ist(now).getUTCSeconds()), why: "market opens at 09:15 IST" });
if (!mine && mNow < endM) { st.waited = true; wj(SF, st); }
if (mine && st.waited) { st.waited = false; st.full_export = null; wj(SF, st); } // took over from another runner: re-read everything it wrote
if (!mine && mNow < endM) out({ action: "wait", seconds: Math.max(30, Math.min(120, (Date.parse(lease.until) - now.getTime()) / 1e3 + 5)), why: `another runner (${lease.holder}) holds the lease until ${istHM(new Date(lease.until))} IST — get live/runner again (out_dir build/db) and pipe the output into versions, then tick again`, reget: [{ collection: "live", doc_id: "runner", out_dir: DB }] });
{ const full = st.full_export !== st.holder;
  if (full || st.resync || !st.last_export || now - Date.parse(st.last_export) > RESYNC_MIN * 60e3) out({ action: "resync", full, run_first: `node scripts/live_cycle.mjs prep${full ? " --full" : ""}`, why: full ? "session start (or lease change / repeated refusals): full export" : st.resync ? "a batch was refused (someone changed the book meanwhile)" : `the export is over ${RESYNC_MIN} minutes old` }); }
const final = mNow >= endM;

// ---- fresh prices (the intraday runner pushes the live-quotes branch every minute)
let Q = null, qNote = "";
try {
  git("fetch", "-q", "--depth", "1", "origin", "refs/heads/live-quotes");
  fs.writeFileSync(path.join(B, "quotes.json"), git("show", "FETCH_HEAD:quotes.json"));
  Q = rj(path.join(B, "quotes.json"));
} catch (e) { qNote = "live quotes unavailable: " + String(e.message || e).split("\n")[0].slice(0, 120); }
const qAge = Q ? (now - Date.parse(Q.asof)) / 60e3 : Infinity, qOk = Q && Q.date === today && qAge <= MAX_QUOTE_AGE_MIN;
if (Q && !qOk) qNote = Q.date !== today ? `live quotes are from ${Q.date} (holiday, or the intraday runner isn't running)` : `live quotes are ${Math.round(qAge)} min old`;
const full = !st.last_full || now - Date.parse(st.last_full) >= FULL_EVERY_MIN * 60e3 - 20e3;
if (qOk && full) { // bulky extras for the app (live/quotes, today's 1-minute bars for the 1D chart) every 5 minutes
  for (const [src, dst] of [["bars_1m.json.gz", "bars_1m.json.gz"], [`history_${today}.csv.gz`, "hist.csv.gz"]]) {
    try { fs.writeFileSync(path.join(B, dst), execFileSync("git", ["-C", ROOT, "show", "FETCH_HEAD:" + src], { maxBuffer: 1 << 30, timeout: 90e3 })); } catch (e) { fs.rmSync(path.join(B, dst), { force: true }); }
  }
}

// ---- the Names box: symbols the team set on intraday agents -> intraday/agents.json on main (the runner reloads it)
const namesLog = [];
try {
  const cfgF = path.join(ROOT, "intraday", "agents.json");
  const changed = docs("live_names").filter((n) => n.id && JSON.stringify([n.version, n.at]) !== JSON.stringify(st.names_applied[n.id] || null));
  if (changed.length) {
    try { git("pull", "-q", "--rebase", "origin", "main"); } catch (e) { /* work on what we have */ }
    const cfg = rj(cfgF, { agents: [] }); let touched = false;
    for (const n of changed) {
      const e = cfg.agents.find((a) => a.id === "app_" + n.id);
      if (e && Array.isArray(n.symbols)) { e.symbols = n.symbols; if (n.version != null) e.version = n.version; e.names_at = n.at; touched = true; namesLog.push(`${e.name}: ${n.symbols.length} names (v${n.version})`); }
      else if (!e) { // a paper intraday agent the evening sync hasn't added yet: add it now (the runner lets it join mid-session)
        const a = rj(path.join(B, "agents.json"), []).find((x) => x.id === n.id), sp = a?.version?.spec;
        if (a && sp?.type === "intraday" && a.status === "paper") {
          const FIELDS = ["bar_minutes", "side", "entry", "exit", "rank_by", "opening_range_minutes", "stop_loss_pct", "target_pct", "trailing_stop_pct", "capital", "max_positions", "position_pct", "start_after", "no_entry_after", "square_off", "max_trades_per_symbol", "cost_pct", "slippage_pct"];
          const ne = { id: "app_" + n.id, name: a.name || n.id, enabled: true, engine: "js", source: "app", version: n.version, paper_since: a.paper?.since, symbols: n.symbols, names_at: n.at };
          for (const k of FIELDS) if (sp[k] != null && sp[k] !== "") ne[k] = sp[k];
          cfg.agents.push(ne); touched = true; namesLog.push(`${ne.name}: joined the intraday runner with ${n.symbols.length} names`);
        } else namesLog.push(`${n.name || n.id}: not paper trading as an intraday agent, so the runner doesn't trade it yet`);
      }
      st.names_applied[n.id] = [n.version, n.at];
    }
    if (touched) {
      fs.writeFileSync(cfgF, JSON.stringify(cfg, null, 1) + "\n");
      git("add", "intraday/agents.json");
      try { git("diff", "--cached", "--quiet"); } catch (e) { git("-c", "user.name=tradeos-bot", "-c", "user.email=tradeos-bot@users.noreply.github.com", "commit", "-q", "-m", `intraday names ${today} ${hhmm} IST: ${namesLog.join("; ").slice(0, 200)}`); }
      let pushed = false;
      for (let i = 0; i < 3 && !pushed; i++) { try { git("push", "-q", "origin", "HEAD:main"); pushed = true; } catch (e) { try { git("pull", "-q", "--rebase", "origin", "main"); } catch (e2) { /* retry */ } } }
      if (!pushed) { for (const n of changed) delete st.names_applied[n.id]; namesLog.push("names: couldn't push intraday/agents.json to main — retrying next minute"); }
    }
  }
} catch (e) { namesLog.push("names: " + String(e.message || e).slice(0, 120)); }

// ---- who decides this minute
const agentsJ = rj(path.join(B, "agents.json"), []), agentDocs = docs("agents"), desks = Object.fromEntries(docs("desks").map((d) => [d.id, d]));
const bookState = rj(docFile("book", "state"), {}) || {}, sleeves = bookState.sleeves || {};
const due = [], skips = [], waiting = [];
for (const a of agentsJ) {
  const d = desks[a.desk_id], t = a.version?.spec?.type || a.type;
  if (t === "intraday") { skips.push({ agent: a.id, reason: "traded by the intraday runner on each bar close" }); continue; }
  if (t === "option_selling") { skips.push({ agent: a.id, reason: "option seller: own paper record, marked each evening" }); continue; }
  if (!d) { skips.push({ agent: a.id, reason: "not on a desk" }); continue; }
  if ((d.status || "active") !== "active") { skips.push({ agent: a.id, reason: `desk ${d.status}` }); continue; }
  if (!(Number(a.alloc_pct) > 0)) { skips.push({ agent: a.id, reason: "no allocation" }); continue; }
  if (!qOk) { skips.push({ agent: a.id, reason: qNote || "no live prices" }); continue; }
  const last = st.last_check[a.id] ? Date.parse(st.last_check[a.id]) : 0;
  if (t === "watchlist") { if (st.last_seen_asof[a.id] !== Q.asof) due.push(a.id); else waiting.push(a.id); }
  else if (now - last >= RULE_EVERY_MIN * 60e3 - 20e3) due.push(a.id); else waiting.push(a.id);
}
const openApproved = docs("orders").filter((o) => o.status === "approved" && !o.filled_at && !o.fill_price);
const flushDue = final || !st.last_send || now - Date.parse(st.last_send) >= FLUSH_MIN * 60e3 - 20e3;

// ---- trade: book_run.mjs decides for the due agents (others hold) and fills approved orders at live prices
let S = null, bw = [];
if (mNow >= hm2m("15:30")) { due.length = 0; skips.push({ agent: "*", reason: "market closed at 15:30 IST: no more trading; the evening run marks the book to the close" }); }
else if (qOk && (due.length || openApproved.length || flushDue)) {
  const o = path.join(LOOP, "book.json"), a = [path.join(ROOT, "scripts", "book_run.mjs"), B, DB, path.join(B, "agents.json"), "/nonexistent", o, "--live", path.join(B, "quotes.json"), "--max-age-min", String(MAX_QUOTE_AGE_MIN), "--only", due.join(",")];
  if (full) { if (fs.existsSync(path.join(B, "bars_1m.json.gz"))) a.push("--bars", path.join(B, "bars_1m.json.gz")); if (fs.existsSync(path.join(B, "hist.csv.gz"))) a.push("--hist", path.join(B, "hist.csv.gz")); } else a.push("--light");
  try {
    execFileSync("node", a, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 240e3, maxBuffer: 1 << 28 });
    const R = rj(o); S = R.summary;
    if (S.traded !== false) bw = rj(R.batches_file, []).flat();
    else skips.push({ agent: "*", reason: S.reason });
  } catch (e) { skips.push({ agent: "*", reason: "book run failed: " + String(e.stderr || e.message || e).split("\n").filter(Boolean).slice(-1)[0]?.slice(0, 160) }); }
}
const checkedIds = S?.checked || [];
for (const id of checkedIds) { st.last_check[id] = now.toISOString(); if (Q) st.last_seen_asof[id] = Q.asof; }
for (const e of S?.errors || []) skips.push(e);
for (const no of S?.new_orders || []) if (no.status === "blocked" || (no.checks || []).length) skips.push({ agent: no.agent, reason: `${no.side} ${no.sym}: ${(no.checks || []).join("; ") || no.status}` });

// ---- the run log (Orders page) and the lease
const nameOf = (id) => agentDocs.find((x) => x.id === id)?.name || id;
const entry = { t: hhmm, at: now.toISOString(), quotes: Q?.asof ? istHM(new Date(Q.asof)) : null, checked: checkedIds.length, agents: checkedIds.map(nameOf),
  waiting: waiting.length, signals: (S?.new_orders || []).length, filled: (S?.fills || []).length,
  fills: (S?.fills || []).slice(0, 12).map((f) => `${f.side} ${f.qty} ${f.sym} @${f.price} (${nameOf(f.agent)})`),
  pending: (S?.new_orders || []).filter((x) => x.status === "pending").length, charges: S?.charges || 0,
  skips: skips.filter((s) => s.agent === "*" || !/intraday runner|option seller/.test(s.reason)).slice(0, 12).map((s) => ({ agent: s.agent === "*" ? "all" : nameOf(s.agent), reason: s.reason })),
  notes: [...namesLog, ...(qOk ? [] : [qNote])].slice(0, 6) };
st.log = [...(st.log || []), entry];
if (full && qOk && S && S.traded !== false) st.last_full = now.toISOString();
const trades = bw.some((w) => w.collection === "orders" || w.collection === "desks" || w.collection === "alert_events");
if (!trades && !flushDue) { wj(SF, st); out({ action: "idle", at: hhmm, checked: checkedIds.length, waiting: waiting.length, quotes: entry.quotes, note: entry.notes.join("; ") || undefined }); }

// ---- the batch: book writes + runs/<date> + agent "last run" + lease
const wdir = path.join(LOOP, "writes"); fs.rmSync(wdir, { recursive: true, force: true }); fs.mkdirSync(wdir, { recursive: true });
let k = 0; const extra = (op, collection, doc_id, data) => { const fp = path.join(wdir, `${String(k++).padStart(3, "0")}_${collection.replace(/\W/g, "_")}_${doc_id}.json`); fs.writeFileSync(fp, JSON.stringify(data)); return { op, collection, doc_id, file_path: fp }; };
const runsPrev = rj(docFile("runs", today), null), lastRun = { ...(runsPrev?.agents || {}) };
for (const id of checkedIds) lastRun[id] = now.toISOString();
const entries = [...(runsPrev?.entries || []), ...st.log].slice(-450);
const writes = [];
// the lease goes first: if another runner took over meanwhile, its pin fails and nothing in the batch is written
writes.push(extra(lease ? "update" : "set", "live", "runner", { holder: st.holder, until: new Date(now.getTime() + (final ? 0 : LEASE_MIN * 60e3)).toISOString(), at: now.toISOString(), session_until: st.until, ...(final ? { ended: now.toISOString() } : {}) }));
writes.push(extra("set", "runs", today, { date: today, updated_at: now.toISOString(), runner: st.holder, cadence: { watchlist: "every new live price (about a minute)", rule: `every ${RULE_EVERY_MIN} min`, rotation: `every ${RULE_EVERY_MIN} min`, intraday: "intraday runner, each bar close" }, last_at: now.toISOString(), last_t: hhmm, agents: lastRun, entries, ...(final ? { ended: true } : {}) }));
for (const w of bw) writes.push({ op: w.op, collection: w.collection, doc_id: w.doc_id, ...(w.file_path ? { file_path: w.file_path } : {}) });
// pins: every write to a document that exists carries its version
const need = [];
for (const w of writes) {
  const key = w.collection + "/" + w.doc_id, exists = fs.existsSync(docFile(w.collection, w.doc_id));
  if (versions[key] != null && (exists || w.op !== "set")) w.if_version = versions[key];
  else if (exists) need.push({ collection: w.collection, doc_id: w.doc_id, out_dir: DB });
}
if (need.length) { wj(SF, { ...st, log: st.log }); out({ action: "need", docs: need, why: "these documents exist but their versions are unknown: get them (with out_dir), record the output with `versions`, then tick again" }); }
const batches = []; for (let i = 0; i < writes.length; i += 45) batches.push(writes.slice(i, i + 45));
wj(PF, { writes: batches[0], rest: batches.slice(1), state_after: {}, log_sent: st.log.length, final });
st.log = st.log; wj(SF, st);
out({ action: "send", url: APP_URL, writes: batches[0], more_batches: batches.length - 1, at: hhmm, checked: checkedIds.length, filled: entry.filled, signals: entry.signals, final: final || undefined });
