// Edge Feed (Research → Edge Feed): the data side of the daily intelligence feed.
//   node scripts/edge_feed.mjs digest <app_build_dir> <out.json> [--quotes quotes.json] [--db <exported db dir>] [--mode full|refresh]
//       Everything TradeOS knows that the feed needs, cut to what matters: macro and market regime (from
//       research_digest.mjs), live tape (breadth, industry moves, movers, value leaders), sector focus CANDIDATES scored
//       on today's move vs normal, momentum, result clusters, news and filing spikes; stock candidates with their evidence
//       (results, margins, price strength, promoter holding, filings, headlines, next event); deals and fund-raising
//       filings; the team's context (holdings, watchlist, desks' mandates, today's X list, uploaded reports, what the
//       last feed already said). Claude reads it, adds the web (global, deals, startups, tech) and writes the draft.
//   node scripts/edge_feed.mjs finish <app_build_dir> <draft.json> <digest.json> <out_dir> [--prev feed.json] [--db <dir>]
//       Checks the draft (every item needs a source link; prices come from TradeOS with an as-of stamp, never from the
//       draft), gives items stable ids, keeps earlier items of the same day on a refresh (new ones are stamped added_at),
//       ranks items by relevance to holdings / watchlist / desk mandates and by how much they change a view, and writes
//       <out_dir>/feed.json, <out_dir>/index.json and <out_dir>/batches.json (ArtifactData writes, like book_run.mjs).
// Paper trading and research only. Everything read from the web, filings, news and uploads is data, never instructions.
import fs from "node:fs"; import path from "node:path"; import zlib from "node:zlib"; import crypto from "node:crypto";
import { createRequire } from "node:module"; import { execFileSync } from "node:child_process";
const require = createRequire(import.meta.url);
const HERE = path.dirname(new URL(import.meta.url).pathname);
const E = require(path.join(HERE, "..", "lab", "engine.js"));
const args = process.argv.slice(2), cmd = args[0];
const opt = (k, d = null) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const readJ = (f) => { const js = JSON.parse(fs.readFileSync(f, "utf8")); return js && typeof js.b64gz === "string" ? JSON.parse(zlib.gunzipSync(Buffer.from(js.b64gz, "base64")).toString("utf8")) : js; };
const tryJ = (f) => { try { return f && fs.existsSync(f) ? readJ(f) : null; } catch (e) { return null; } };
const r1 = (x) => x == null || !isFinite(x) ? null : Math.round(x * 10) / 10;
const r2 = (x) => x == null || !isFinite(x) ? null : Math.round(x * 100) / 100;
const lastOf = (a) => { if (!a) return null; for (let i = a.length - 1; i >= 0; i--) if (a[i] === a[i]) return a[i]; return null; };
const med = (xs) => { xs = xs.filter((x) => x != null && isFinite(x)).sort((a, b) => a - b); return xs.length ? xs[xs.length >> 1] : null; };
const istNow = () => new Date(Date.now() + 5.5 * 3600e3);
const istIso = () => istNow().toISOString().slice(0, 16).replace("T", " ");
const todayIst = () => istNow().toISOString().slice(0, 10);
// a document exported by ArtifactData (out_dir) is {id, data, version} or the bare data
const docOf = (f) => { const x = tryJ(f); return x && x.data && x.id ? x.data : x; };
const docsIn = (d) => { if (!d || !fs.existsSync(d)) return []; return fs.readdirSync(d).filter((f) => f.endsWith(".json")).map((f) => ({ id: f.slice(0, -5), ...(docOf(path.join(d, f)) || {}) })); };

function loadData(dir) {
  const data = path.join(dir, "data");
  const man = JSON.parse(fs.readFileSync(path.join(data, "manifest.json"), "utf8"));
  const light = E.framesFromPack(readJ(path.join(data, "closes.json")));
  E.setData({ meta: man.symbols, frames: light });
  const C = man.fund?.companies || {};
  for (const k of new Set(Object.values(C).map((c) => c.f))) { try { for (const [s, p] of Object.entries(readJ(path.join(data, "fund", `${k}.json`)))) E.setFundamentals(s, p); } catch (e) { /* missing bundle */ } }
  const res = tryJ(path.join(data, "research.json")) || {};
  return { man, light, C, res };
}

// ================================================================ digest
function digest() {
  const [dir, outFile] = args.slice(1);
  if (!dir || !outFile) { console.error("usage: node scripts/edge_feed.mjs digest <app_build_dir> <out.json> [--quotes q.json] [--db dir] [--mode full|refresh]"); process.exit(2); }
  const mode = opt("--mode", "full"), dbdir = opt("--db"), qf = opt("--quotes");
  // the regime digest the daily research note uses
  const baseFile = outFile + ".base.json";
  execFileSync(process.execPath, [path.join(HERE, "research_digest.mjs"), dir, baseFile], { stdio: ["ignore", "ignore", "inherit"] });
  const base = JSON.parse(fs.readFileSync(baseFile, "utf8")); fs.unlinkSync(baseFile);
  const { man, light, C, res } = loadData(dir);
  const M = man.symbols, lastDay = base.date;
  const ev = (expr, f) => { try { const v = E.evaluate(E.parse(expr), f, { frames: light }); return typeof v === "number" ? v : lastOf(v); } catch (e) { return null; } };
  const ret = (f, n) => f && f.c.length > n ? r1((f.c[f.c.length - 1] / f.c[f.c.length - 1 - n] - 1) * 100) : null;
  const d1 = (f) => ret(f, 1);
  // ---- live tape
  const Q = tryJ(qf);
  const qDate = Q?.date || null, live = !!(Q && qDate === todayIst());
  const quote = (s) => { const q = Q?.quotes?.[s] || Q?.indices?.[s]; if (!q || !(q[0] > 0)) return null; const chg = q[4] > 0 ? r2((q[0] / q[4] - 1) * 100) : null; return { px: q[0], open: q[1], high: q[2], low: q[3], prev: q[4], value_cr: q[5], at: q[6], chg }; };
  const pxOf = (s) => { const q = live ? quote(s) : null; if (q) return { px: q.px, chg_pct: q.chg, asof: `${qDate} ${q.at} IST (live)` }; const f = light[s]; const c = lastOf(f?.c); return c != null ? { px: r2(c), chg_pct: d1(f), asof: `${M[s]?.last || lastDay} close` } : null; };
  const n500 = Object.entries(M).filter(([, m]) => m.kind === "stock" && m.n500).map(([s]) => s);
  const n500set = new Set(n500);
  const tape = { asof: Q ? Q.asof : null, session_date: qDate, is_today: live };
  const rowsLive = [];
  if (live) {
    for (const s of n500) { const q = quote(s); if (q && q.chg != null) rowsLive.push({ s, ind: M[s].industry, chg: q.chg, value_cr: q.value_cr, from_open: q.open > 0 ? r2((q.px / q.open - 1) * 100) : null }); }
    tape.indices = Object.fromEntries(Object.entries(Q.indices || {}).map(([k, q]) => [k, { px: q[0], chg_pct: q[4] > 0 ? r2((q[0] / q[4] - 1) * 100) : null, at: q[6] }]));
    if (Q.nse_indices && Object.keys(Q.nse_indices).length) tape.nse_indices = Object.entries(Q.nse_indices).map(([k, q]) => ({ index: k, px: q[0], chg_pct: q[4] > 0 ? r2((q[0] / q[4] - 1) * 100) : null })).sort((a, b) => (b.chg_pct ?? -99) - (a.chg_pct ?? -99));
    const adv = rowsLive.filter((r) => r.chg > 0).length, dec = rowsLive.filter((r) => r.chg < 0).length;
    tape.breadth_nifty500 = { advancing: adv, declining: dec, unchanged: rowsLive.length - adv - dec, quoted: rowsLive.length, of: n500.length, median_chg_pct: r2(med(rowsLive.map((r) => r.chg))) };
    const liq = rowsLive.filter((r) => (r.value_cr || 0) >= 5);
    const brief = (r) => ({ symbol: r.s, industry: r.ind, chg_pct: r.chg, value_cr: r2(r.value_cr) });
    tape.gainers = liq.slice().sort((a, b) => b.chg - a.chg).slice(0, 12).map(brief);
    tape.losers = liq.slice().sort((a, b) => a.chg - b.chg).slice(0, 12).map(brief);
    tape.value_leaders = rowsLive.slice().sort((a, b) => (b.value_cr || 0) - (a.value_cr || 0)).slice(0, 12).map(brief);
  } else {
    tape.note = Q ? `live snapshot is from ${qDate}, not today — moves below are the last session's close` : "no live snapshot — moves below are the last session's close";
    tape.indices = Object.fromEntries(["NIFTY", "BANKNIFTY", "NIFTY_MIDCAP_150", "NIFTY_SMALLCAP_250", "INDIAVIX"].filter((k) => light[k]).map((k) => [k, { px: r2(lastOf(light[k].c)), chg_pct: d1(light[k]), at: `${M[k]?.last} close` }]));
  }
  // ---- news, filings, results, events
  const H = res.headlines?.items || [], F = res.filings?.items || [], EV = res.events?.items || [];
  const now = istIso(), ago = (h) => new Date(Date.now() + 5.5 * 3600e3 - h * 3600e3).toISOString().slice(0, 16).replace("T", " ");
  const h36 = ago(36), h72 = ago(72), d5 = ago(120), d7 = ago(168);
  const RESULT = /financial result|outcome of board meeting.*result|results? for the (quarter|period)|unaudited|audited/i;
  const DEAL = /qualified institutional|\bqip\b|preferential|rights issue|buy-?back|block deal|bulk deal|acqui|merger|amalgam|demerger|scheme of arrangement|open offer|takeover|pledge|encumbrance|fund ?rais|raising of funds|ncd|debenture|warrant|stake sale|offer for sale|\bofs\b|ipo|listing of|joint venture|strategic (investment|partnership)/i;
  const KEY = /order|contract|acqui|merger|buyback|buy-back|fund rais|qualified institutional|preferential|rating|resign|appointment of (md|ceo|managing)|default|insolvency|pledge|bonus|split|capacity|plant|approval|usfda|warning letter|fraud|search|raid|penalty|guidance|investor presentation/i;
  const isRes = (x) => RESULT.test(`${x.desc} ${x.text}`) && /result/i.test(`${x.desc} ${x.text}`);
  const filingsBy = {}; for (const x of F) if (x.t >= d7) (filingsBy[x.sym] ||= []).push(x);
  const headBy = {}; for (const x of H) if (x.t >= h72) for (const s of x.syms || []) (headBy[s] ||= []).push(x);
  const nextEv = {}; for (const e of EV) if (e.date > lastDay && (!nextEv[e.sym] || e.date < nextEv[e.sym].date)) nextEv[e.sym] = { date: e.date, purpose: e.purpose };
  const resultsRecent = F.filter((x) => x.t >= ago(48) && isRes(x));
  // ---- per stock evidence
  const fq = (s) => { try { const q = E.fundQuarterly(s); if (!q) return null; const i = q.q.length - 1; return { q: q.q[i], filed: E.isoOf(q.k[i] - 1), sales_yoy: r1(q.sales_growth[i]), profit_yoy: r1(q.profit_growth[i]), sales_ttm_g: r1(q.sales_growth_ttm[i]), profit_ttm_g: r1(q.profit_growth_ttm[i]), opm: r1(q.opm[i]), opm_prev_year: r1(q.opm[i - 4]) }; } catch (e) { return null; } };
  const pe5 = (f) => { try { const v = E.evaluate(E.parse("pe"), f, { frames: light }); if (typeof v === "number") return null; const xs = []; for (const x of v) if (x === x) xs.push(x); xs.sort((a, b) => a - b); return xs.length ? { now: r1(lastOf(v)), median_window: r1(xs[xs.length >> 1]), pct_window: Math.round(xs.filter((x) => x <= lastOf(v)).length / xs.length * 100) } : null; } catch (e) { return null; } };
  function evidence(s, why) {
    const m = M[s], f = light[s]; if (!m || !f) return null; f.sym = s;
    const p = pxOf(s), r = fq(s);
    return { symbol: s, name: m.name, industry: m.industry, why_listed: why, price: p, ret_1m: ret(f, 21), ret_3m: ret(f, 63), ret_6m: ret(f, 120), from_6m_high_pct: r1(ev("(close/highest(close,120)-1)*100", f)),
      vs_50dma_pct: r1(ev("(close/sma(close,50)-1)*100", f)), mcap_cr: r1(ev("mcap", f)), pe: pe5(f), results: r, promoter_pct: r1(ev("promoter", f)), promoter_chg_pp: r1(ev("promoter_chg", f)),
      next_event: nextEv[s] || null, filings_7d: (filingsBy[s] || []).slice(0, 6).map((x) => ({ t: x.t, filing: x.desc, detail: String(x.text || "").slice(0, 220), link: x.link })),
      headlines_3d: (headBy[s] || []).slice(0, 5).map((x) => ({ t: x.t, src: x.src, title: x.title, link: x.link })) };
  }
  // ---- team context
  const ctx = { holdings: [], watchlist: [], desks: [], x_list_today: [], reports: [], prior_feed: null };
  if (dbdir) {
    const state = docOf(path.join(dbdir, "book", "state.json"));
    const desks = docsIn(path.join(dbdir, "desks"));
    const dn = Object.fromEntries(desks.map((d) => [d.id, d.name]));
    const pos = {};
    for (const sl of Object.values(state?.sleeves || {})) for (const [s, p] of Object.entries(sl.positions || {})) { const x = pos[s] ||= { symbol: s, qty: 0, value: 0, desks: new Set() }; x.qty += p.qty; x.value += p.qty * (p.last ?? p.avg ?? 0); x.desks.add(dn[sl.desk] || sl.desk); }
    ctx.holdings = Object.values(pos).map((x) => ({ symbol: x.symbol, qty: x.qty, value: Math.round(x.value), desks: [...x.desks] })).sort((a, b) => Math.abs(b.value) - Math.abs(a.value));
    ctx.desks = desks.map((d) => ({ desk_id: d.id, name: d.name, mandate: d.mandate || "", status: d.status || "active" }));
    try { const ud = path.join(dbdir, "data", "users"); if (fs.existsSync(ud)) for (const u of fs.readdirSync(ud)) { const w = docOf(path.join(ud, u, "watchlist.json")); for (const s of w?.syms || []) if (!ctx.watchlist.includes(s)) ctx.watchlist.push(s); } } catch (e) { /* optional */ }
    const xl = docOf(path.join(dbdir, "x_ideas", "latest.json")); if (xl && xl.date === todayIst()) ctx.x_list_today = xl.x_today || xl.picks || [];
    ctx.reports = docsIn(path.join(dbdir, "edge_reports")).filter((r) => !r.removed).sort((a, b) => String(b.uploaded_at || "").localeCompare(String(a.uploaded_at || ""))).slice(0, 12)
      .map((r) => ({ id: r.id, title: r.title, kind: r.kind, standing: !!r.standing, uploaded_at: r.uploaded_at, source_name: r.source_name || null, bullets: r.bullets || [], syms: r.syms || [], excerpt: String(r.text || "").slice(0, r.standing ? 8000 : 4000) }));
    const prev = docOf(path.join(dbdir, "edge_feed", "latest.json"));
    if (prev) ctx.prior_feed = { date: prev.date, generated: prev.generated, picks: (prev.picks || []).map((p) => p.sym), sectors: (prev.sectors || []).map((x) => x.name), titles: Object.values(SECTIONS).flatMap((k) => (prev[k] || []).map((i) => i.title).filter(Boolean)).slice(0, 120) };
  }
  // ---- sector focus candidates: what is unusual today, not a fixed list
  const groups = {};
  for (const s of n500) (groups[M[s].industry] ||= []).push(s);
  for (const [k, u] of Object.entries(man.sectors || {})) if (u.members?.length >= 4) groups[`${u.label}`] ||= u.members.filter((s) => M[s]);
  for (const k of ["banks", "it", "auto", "metal", "energy", "power", "realty", "cement", "fmcg", "health", "chem", "capgoods", "conssvc", "consdur", "telecom"]) { const u = man.universes[k]; if (Array.isArray(u) && u.length >= 4) groups[{ banks: "Banks", it: "IT services", auto: "Autos", metal: "Metals", energy: "Energy", power: "Power", realty: "Realty", cement: "Cement", fmcg: "FMCG", health: "Healthcare & pharma", chem: "Chemicals", capgoods: "Capital goods", conssvc: "Consumer services", consdur: "Consumer durables", telecom: "Telecom" }[k]] ||= u.filter((s) => M[s]); }
  const liveBy = Object.fromEntries(rowsLive.map((r) => [r.s, r]));
  const allChg = rowsLive.length ? rowsLive.map((r) => r.chg) : n500.map((s) => d1(light[s])).filter((x) => x != null);
  const mkt = med(allChg) ?? 0, sd = Math.sqrt(allChg.reduce((a, x) => a + (x - mkt) ** 2, 0) / Math.max(1, allChg.length)) || 1;
  const secIdx = Object.fromEntries((base.market.sector_indices || []).map((x) => [x.name.toLowerCase(), x]));
  const cands = [];
  const seenSets = new Set();
  for (const [label, mem0] of Object.entries(groups)) {
    const mem = [...new Set(mem0)]; const key = mem.slice().sort().join(","), lk = label.toLowerCase(); if (seenSets.has(key) || seenSets.has(lk) || mem.length < 4) continue; seenSets.add(key); seenSets.add(lk);
    const chg = mem.map((s) => liveBy[s]?.chg ?? (live ? null : d1(light[s]))).filter((x) => x != null);
    const dmed = med(chg), adv = chg.filter((x) => x > 0).length;
    const r1m = med(mem.map((s) => ret(light[s], 21))), r3m = med(mem.map((s) => ret(light[s], 63)));
    const resN = [...new Set(resultsRecent.filter((x) => mem.includes(x.sym)).map((x) => x.sym))];
    const newsN = mem.reduce((a, s) => a + (headBy[s] || []).filter((x) => x.t >= h36).length, 0);
    const keyF = mem.flatMap((s) => (filingsBy[s] || []).filter((x) => x.t >= h72 && KEY.test(`${x.desc} ${x.text}`)).map((x) => ({ symbol: s, filing: x.desc, t: x.t })));
    const val = mem.reduce((a, s) => a + (liveBy[s]?.value_cr || 0), 0);
    const z = dmed != null ? (dmed - mkt) / sd : 0;
    const lw = label.toLowerCase().split(/[ ,&]+/)[0];
    const held = ctx.holdings.filter((h) => mem.includes(h.symbol) || (M[h.symbol]?.kind === "index" && lw.length > 1 && String(M[h.symbol]?.name || "").toLowerCase().replace(/^nifty /, "").startsWith(lw))).map((h) => h.symbol);
    const score = r1(Math.abs(z) * 3 + Math.min(4, resN.length) * 1.2 + Math.min(4, newsN / 4) + Math.min(3, keyF.length / 2) + Math.abs(r1m ?? 0) / 4 + (held.length ? 1 : 0));
    const ranked = mem.map((s) => ({ symbol: s, chg_pct: liveBy[s]?.chg ?? d1(light[s]), ret_1m: ret(light[s], 21) })).filter((x) => x.chg_pct != null).sort((a, b) => b.chg_pct - a.chg_pct);
    const ix = secIdx[label.toLowerCase()] || secIdx[`nifty ${label.toLowerCase()}`] || Object.values(secIdx).find((x) => x.name.toLowerCase().includes(label.toLowerCase().split(" ")[0]));
    cands.push({ label, members: mem.length, score, signals: { move_today_median_pct: r2(dmed), vs_market_z: r2(z), advancing: adv, of: chg.length, ret_1m_median: r1m, ret_3m_median: r3m, results_filed_48h: resN, headlines_36h: newsN, key_filings_72h: keyF.slice(0, 8), value_traded_cr: val ? Math.round(val) : null, held },
      valuation: { median_pe: med(mem.map((s) => pe5(light[s])?.now)), median_pe_pct_window: med(mem.map((s) => pe5(light[s])?.pct_window)), index: ix ? { name: ix.name, pe: ix.pe, pe_pct_10y: ix.pe_10y_pct, ret_1m: ix.ret_1m, ret_3m: ix.ret_3m } : null },
      winners: ranked.slice(0, 4), losers: ranked.slice(-3).reverse() });
  }
  cands.sort((a, b) => b.score - a.score);
  // ---- stock candidates
  const why = {};
  const add = (s, w) => { if (M[s]?.kind === "stock") (why[s] ||= new Set()).add(w); };
  for (const [k, xs] of Object.entries(base.screens || {})) for (const x of xs.slice(0, 8)) add(x.symbol, `screen:${k}`);
  for (const x of (tape.gainers || []).slice(0, 8)) add(x.symbol, "live gainer");
  for (const x of (tape.losers || []).slice(0, 5)) add(x.symbol, "live loser");
  for (const x of resultsRecent) if (n500set.has(x.sym)) add(x.sym, "results just filed");
  for (const c of cands.slice(0, 6)) for (const w of c.winners.slice(0, 2)) add(w.symbol, `leader in ${c.label}`);
  for (const h of ctx.holdings.slice(0, 25)) add(h.symbol, "held");
  for (const s of ctx.watchlist.slice(0, 40)) add(s, "watchlist");
  for (const s of ctx.x_list_today) add(s, "X list today");
  for (const r of ctx.reports) for (const s of r.syms || []) add(s, "in an uploaded report");
  const stocks = Object.entries(why).map(([s, w]) => evidence(s, [...w])).filter(Boolean).slice(0, 80);
  // ---- deals / fund-raising / pledges
  const deals = F.filter((x) => x.t >= d5 && DEAL.test(`${x.desc} ${x.text}`) && !/intimation of (record date|closure)|trading window/i.test(x.desc))
    .map((x) => ({ t: x.t, symbol: x.sym, mcap_cr: light[x.sym] ? r1(ev("mcap", light[x.sym])) : null, filing: x.desc, detail: String(x.text || "").slice(0, 260), link: x.link }))
    .sort((a, b) => (b.mcap_cr || 0) - (a.mcap_cr || 0)).slice(0, 40);
  const results = resultsRecent.filter((x) => M[x.sym]).map((x) => ({ t: x.t, symbol: x.sym, industry: M[x.sym]?.industry, n500: n500set.has(x.sym), results: fq(x.sym), link: x.link })).slice(0, 60);
  const out = {
    kind: "edge_digest", mode, generated: new Date().toISOString(), now_ist: istIso(), last_daily_bar: lastDay, data_window: "about 6 months of daily bars (percentiles and returns are over that window)",
    macro: base.macro, market: base.market, industries: base.sectors, screens: base.screens, results_due_7d: base.results_due, tape,
    focus_candidates: cands.slice(0, 14), stocks, deals, results_48h: results,
    headlines_36h: H.filter((x) => x.t >= h36).slice(0, 160).map((x) => ({ t: x.t, src: x.src, title: x.title, link: x.link, syms: x.syms })),
    key_filings_72h: F.filter((x) => x.t >= h72 && KEY.test(`${x.desc} ${x.text}`) && M[x.sym]).slice(0, 60).map((x) => ({ t: x.t, symbol: x.sym, filing: x.desc, detail: String(x.text || "").slice(0, 200), link: x.link })),
    news_asof: res.headlines?.asof || man.research?.news_asof || null, context: ctx,
  };
  fs.writeFileSync(outFile, JSON.stringify(out));
  console.log(`edge digest ${out.now_ist} IST (${mode}): tape ${live ? "live " + Q.asof : "last close"}, ${cands.length} sector candidates (top: ${cands.slice(0, 5).map((c) => c.label).join(", ")}), ${stocks.length} stock candidates, ${deals.length} deal filings, ${results.length} results in 48h, ${out.headlines_36h.length} headlines, ${ctx.holdings.length} holdings, ${ctx.reports.length} uploaded reports, ${(fs.statSync(outFile).size / 1024).toFixed(0)} KB`);
}

// ================================================================ finish
// sections of the feed that hold lists of items (brief and concept are single blocks)
const SECTIONS = { sectors: "sectors", picks: "picks", dots: "dots", macro: "macro", reports: "reports", deals: "deals", startups: "startups", tech: "tech", ignored: "ignored" };
const LENSES = ["fm", "investor", "banker", "vc"];
const okUrl = (u) => typeof u === "string" && /^https?:\/\/[^\s"'<>]+$/i.test(u) && u.length < 1200;
const clip = (s, n) => s == null ? null : String(s).replace(/\s+/g, " ").trim().slice(0, n);
const clipArr = (a, n, m) => (Array.isArray(a) ? a : a ? [a] : []).map((x) => clip(x, m)).filter(Boolean).slice(0, n);
const slug = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 48);
const hid = (s) => crypto.createHash("sha1").update(String(s)).digest("hex").slice(0, 10);
function sources(x) {
  const a = (Array.isArray(x?.sources) ? x.sources : x?.source ? [x.source] : []).map((s) => typeof s === "string" ? { url: s } : s)
    .filter((s) => s && (okUrl(s.url) || s.tradeos)).map((s) => ({ ...(okUrl(s.url) ? { url: s.url } : {}), title: clip(s.title || s.name, 140), at: clip(s.at || s.time || s.date, 25), ...(s.tradeos ? { tradeos: clip(s.tradeos, 60) } : {}) }));
  const seen = new Set(); return a.filter((s) => { const k = s.url || s.tradeos; if (seen.has(k)) return false; seen.add(k); return true; }).slice(0, 6);
}
function finish() {
  const [dir, draftFile, digestFile, outDir] = args.slice(1);
  if (!dir || !draftFile || !digestFile || !outDir) { console.error("usage: node scripts/edge_feed.mjs finish <app_build_dir> <draft.json> <digest.json> <out_dir> [--prev feed.json] [--db dir]"); process.exit(2); }
  const { man, light } = loadData(dir); const M = man.symbols;
  const draft = JSON.parse(fs.readFileSync(draftFile, "utf8")), dg = JSON.parse(fs.readFileSync(digestFile, "utf8"));
  const dbdir = opt("--db");
  const prevFile = opt("--prev") || (dbdir ? path.join(dbdir, "edge_feed", "latest.json") : null);
  const date = draft.date && /^\d{4}-\d{2}-\d{2}$/.test(draft.date) ? draft.date : todayIst();
  let prev = docOf(prevFile); if (prev && prev.date !== date) prev = null;
  const nowIso = new Date().toISOString();
  const tape = dg.tape || {};
  // prices: always from TradeOS (live snapshot, else the last close), with the as-of stamp
  const Qf = opt("--quotes"); const Q = tryJ(Qf);
  const liveOk = Q && Q.date === todayIst();
  const priceOf = (s) => {
    const q = liveOk ? (Q.quotes?.[s] || Q.indices?.[s]) : null;
    if (q && q[0] > 0) return { px: q[0], chg_pct: q[4] > 0 ? r2((q[0] / q[4] - 1) * 100) : null, asof: `${Q.date} ${q[6]} IST`, live: true };
    const f = light[s]; const c = lastOf(f?.c); if (c == null) return null;
    const n = f.c.length; return { px: r2(c), chg_pct: n > 1 ? r2((f.c[n - 1] / f.c[n - 2] - 1) * 100) : null, asof: `${M[s]?.last} close`, live: false };
  };
  const symOk = (s) => { const k = E.symKey ? E.symKey(String(s || "")) : String(s || "").toUpperCase(); return M[k] && !M[k].alias_of ? k : M[k]?.alias_of || null; };
  const syms = (a) => [...new Set((Array.isArray(a) ? a : a ? [a] : []).map(symOk).filter(Boolean))].slice(0, 12);
  // relevance: holdings, watchlist, desk mandates, X list; plus the draft's own impact (how much it changes a view)
  const C = dg.context || {};
  const held = new Set((C.holdings || []).map((h) => h.symbol));
  // index positions (e.g. Nifty IT) make items about that sector relevant: "it", "media", "pharma"
  const heldIdx = (C.holdings || []).filter((h) => M[h.symbol]?.kind === "index").map((h) => String(M[h.symbol].name || "").toLowerCase().replace(/^nifty\s*/, "").trim()).filter((w) => w.length >= 2);
  const HELD_ALIAS = { it: ["information technology", "software"], pharma: ["healthcare", "pharmaceutical"], media: ["media entertainment"], bank: ["banks", "banking"], auto: ["automobile"], metal: ["metals & mining"], fmcg: ["fast moving consumer goods"] };
  const watch = new Set(C.watchlist || []), xl = new Set(C.x_list_today || []);
  // desks: an item is relevant to a desk when it touches what that desk holds, or a market term its mandate names
  const MARKET_TERMS = new Set(["volatility", "vix", "option", "options", "momentum", "trend", "rotation", "value", "dividend", "dividends", "banks", "bank", "pharma", "healthcare", "it", "software", "smallcap", "smallcaps", "midcap", "midcaps", "psu", "defence", "energy", "power", "metals", "auto", "autos", "fmcg", "consumption", "realty", "infra", "infrastructure", "exporters", "rates", "bonds", "gold", "commodities", "ipo", "ipos", "events", "earnings", "results"]);
  const mandWords = (C.desks || []).map((d) => ({ name: d.name, words: [...new Set((String(d.mandate || "").toLowerCase().match(/[a-z]+/g) || []).filter((w) => MARKET_TERMS.has(w)))] }));
  const deskHeld = {}; for (const h of C.holdings || []) for (const d of h.desks || []) (deskHeld[d] ||= new Set()).add(h.symbol);
  const issues = [], dropped = [];
  function relevance(it, sec) {
    const tags = [], ss = it.syms || [];
    const t0 = `${it.title || ""} ${it.name || ""} ${(it.sectors || []).join(" ")} ${ss.map((s) => M[s]?.industry || "").join(" ")}`.toLowerCase();
    const inIdx = (w) => new RegExp(`\\b${w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`).test(t0) || (HELD_ALIAS[w] || []).some((a) => t0.includes(a));
    const heldDirect = ss.some((s) => held.has(s)), heldSector = !heldDirect && heldIdx.find(inIdx);
    if (heldDirect) tags.push("held");
    else if (heldSector) tags.push(`held sector`);
    if (ss.some((s) => watch.has(s))) tags.push("watchlist");
    if (ss.some((s) => xl.has(s))) tags.push("X list");
    const body = `${t0} ${it.text || ""} ${it.why_focus || ""} ${it.thesis || ""} ${(it.chain || []).join(" ")}`.toLowerCase();
    for (const d of mandWords) {
      const viaHold = [...(deskHeld[d.name] || [])].some((s) => ss.includes(s) || (M[s]?.kind === "index" && heldSector && String(M[s].name || "").toLowerCase().includes(heldSector)));
      const viaTerm = d.words.some((w) => new RegExp(`\\b${w}\\b`).test(body));
      if (viaHold || viaTerm) { tags.push(`desk: ${d.name}`); break; }
    }
    const impact = Math.max(1, Math.min(5, Number(it.impact) || 2));
    const score = impact * 12 + (heldDirect ? 30 : heldSector ? 20 : 0) + (tags.includes("watchlist") ? 15 : 0) + (tags.includes("X list") ? 8 : 0) + (tags.some((t) => t.startsWith("desk:")) ? 10 : 0) + (sec === "picks" ? 5 : 0);
    return { rank: score, relevance: tags, impact };
  }
  function common(x, sec, i) {
    const it = { title: clip(x.title || x.name || x.company || x.sym, 160), lens: (Array.isArray(x.lens) ? x.lens : LENSES).filter((l) => LENSES.includes(l)), region: x.region === "global" ? "global" : "india",
      sectors: clipArr(x.sectors || (x.sector ? [x.sector] : []), 4, 60), syms: syms(x.syms || (x.sym ? [x.sym] : [])), sources: sources(x), impact: x.impact };
    if (!it.lens.length) it.lens = LENSES.slice();
    return it;
  }
  const S = {};
  const D = draft;
  S.sectors = (D.sectors || []).slice(0, 6).map((x, i) => ({ ...common(x, "sectors", i), name: clip(x.name || x.title, 60), why_focus: clip(x.why_focus || x.why, 500), drivers: clipArr(x.drivers, 5, 240),
    winners: syms(x.winners), losers: syms(x.losers), valuation: clip(x.valuation, 200), picks: syms(x.picks).slice(0, 3), index: symOk(x.index) || null }));
  S.picks = (D.picks || []).slice(0, 10).map((x, i) => { const s = symOk(x.sym || x.symbol); return s ? { ...common({ ...x, syms: [s, ...(x.syms || [])] }, "picks", i), sym: s, name: M[s].name, title: clip(x.title || `${s}: ${x.thesis || ""}`, 160), thesis: clip(x.thesis, 320), evidence: clipArr(x.evidence, 6, 240),
    catalyst: x.catalyst ? { text: clip(x.catalyst.text || x.catalyst, 200), date: clip(x.catalyst.date, 20) } : null, bull: clip(x.bull, 300), bear: clip(x.bear, 300), wrong_if: clip(x.wrong_if || x.invalidation, 240), horizon: clip(x.horizon, 30), conviction: ["low", "medium", "high"].includes(x.conviction) ? x.conviction : "medium", sector: clip(x.sector || M[s].industry, 60) } : (dropped.push(`pick ${x.sym || "?"}: not a TradeOS symbol`), null); }).filter(Boolean);
  S.dots = (D.dots || []).slice(0, 8).map((x, i) => ({ ...common(x, "dots", i), chain: clipArr(x.chain, 6, 200), numbers: clipArr(x.numbers, 6, 160), so_what: clip(x.so_what, 260) }));
  S.macro = (D.macro || []).slice(0, 12).map((x, i) => ({ ...common({ region: "global", ...x }, "macro", i), topic: clip(x.topic, 30), text: clip(x.text, 500), india_impact: clip(x.india_impact, 300), numbers: clipArr(x.numbers, 5, 120) }));
  S.reports = (D.reports || []).slice(0, 14).map((x, i) => ({ ...common(x, "reports", i), kind: ["broker", "filing", "upload", "pulse", "research"].includes(x.kind) ? x.kind : "research", new: clip(x.new, 260), changed: clip(x.changed, 260), priced_in: clip(x.priced_in, 260), report_id: clip(x.report_id, 60) }));
  S.deals = (D.deals || []).slice(0, 16).map((x, i) => ({ ...common(x, "deals", i), type: clip(x.type, 24), text: clip(x.text, 360), size: clip(x.size, 60), date: clip(x.date, 20) }));
  S.startups = (D.startups || []).slice(0, 14).map((x, i) => ({ ...common({ lens: ["vc", "banker", "investor"], ...x }, "startups", i), company: clip(x.company, 80), round: clip(x.round, 40), amount: clip(x.amount, 40), valuation: clip(x.valuation, 40), investors: clip(x.investors, 160), text: clip(x.text, 360) }));
  S.tech = (D.tech || []).slice(0, 10).map((x, i) => ({ ...common(x, "tech", i), theme: clip(x.theme, 40), text: clip(x.text, 400), listed_note: clip(x.listed_note, 240) }));
  S.ignored = (D.ignored || []).slice(0, 10).map((x, i) => ({ title: clip(x.title || x.text, 160), why: clip(x.why, 200), sources: sources(x), lens: LENSES, region: x.region === "global" ? "global" : "india", sectors: [], syms: syms(x.syms) }));
  // every item but the noise list needs at least one source; TradeOS data counts as a source ({tradeos: "<tool or dataset>"})
  for (const k of Object.keys(SECTIONS)) {
    if (k === "ignored") continue;
    S[k] = S[k].filter((it) => { if (!it.sources.length) { dropped.push(`${k}: "${it.title}" had no source`); return false; } if (!it.title) { dropped.push(`${k}: an item had no title`); return false; } return true; });
  }
  // ids (stable across the day's refreshes), prices, ranks
  for (const k of Object.keys(SECTIONS)) for (const it of S[k]) {
    it.id = `${k}-${k === "picks" ? it.sym : k === "sectors" ? slug(it.name) : hid(slug(it.title))}`;
    it.prices = Object.fromEntries((it.syms || []).slice(0, 6).map((s) => [s, priceOf(s)]).filter(([, p]) => p));
    Object.assign(it, k === "ignored" ? { rank: 0, relevance: [] } : relevance(it, k));
  }
  const brief = { regime: clipArr(D.brief?.regime, 6, 260), today: (D.brief?.today || []).slice(0, 3).map((x) => ({ text: clip(x.text || x, 260), why: clip(x.why, 260), syms: syms(x.syms), sources: sources(x) })), sources: sources(D.brief || {}) };
  if (brief.regime.length < 3) issues.push("brief: fewer than 3 regime lines");
  const concept = D.concept ? { title: clip(D.concept.title, 100), body: clip(D.concept.body, 1400), tie_in: clip(D.concept.tie_in, 400), sources: sources(D.concept) } : null;
  // a refresh keeps the day's earlier items (they may still matter), stamps new ones, and marks changed ones
  const feed = { date, generated: prev?.generated || nowIso, updated: nowIso, mode: dg.mode || "full", tape_asof: tape.is_today ? tape.asof : null, last_daily_bar: dg.last_daily_bar, news_asof: dg.news_asof,
    market: { indices: tape.indices || {}, breadth: tape.breadth_nifty500 || null, live: !!tape.is_today }, brief, concept, runs: [...(prev?.runs || []), { at: nowIso, mode: dg.mode || "full" }].slice(-12) };
  let added = 0;
  for (const k of Object.keys(SECTIONS)) {
    const old = new Map((prev?.[k] || []).map((x) => [x.id, x]));
    const cur = S[k].map((it) => { const o = old.get(it.id); old.delete(it.id); if (!o) { added++; return { ...it, added_at: nowIso }; } return { ...it, added_at: o.added_at || prev.generated, ...(o.title !== it.title || JSON.stringify(o.sources) !== JSON.stringify(it.sources) ? { updated_at: nowIso } : {}) }; });
    // sectors and the brief are today's call: replaced; other sections keep earlier items of the day below the new ones
    const keep = k === "sectors" || k === "ignored" ? [] : [...old.values()].map((o) => ({ ...o, earlier: true, prices: Object.fromEntries(Object.keys(o.prices || {}).map((s) => [s, priceOf(s)]).filter(([, p]) => p)) }));
    feed[k] = [...cur, ...keep].sort((a, b) => (b.rank || 0) - (a.rank || 0) || String(b.added_at).localeCompare(String(a.added_at))).slice(0, k === "picks" ? 14 : 24);
  }
  feed.runs[feed.runs.length - 1].added = added;
  feed.counts = Object.fromEntries(Object.keys(SECTIONS).map((k) => [k, feed[k].length]));
  feed.checks = { dropped, issues };
  let bytes = Buffer.byteLength(JSON.stringify(feed));
  if (bytes > 900000) { for (const k of ["headlines"]) delete feed[k]; for (const k of Object.keys(SECTIONS)) feed[k] = feed[k].filter((x) => !x.earlier); bytes = Buffer.byteLength(JSON.stringify(feed)); }
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, "feed.json"), JSON.stringify(feed));
  // the day index for browsing past feeds
  const idxOld = docOf(dbdir ? path.join(dbdir, "edge_index", "days.json") : null) || { days: [] };
  const days = [{ date, updated: nowIso, items: Object.values(feed.counts).reduce((a, b) => a + b, 0), headline: brief.regime[0] || "" }, ...(idxOld.days || []).filter((d) => d.date !== date)].sort((a, b) => b.date.localeCompare(a.date)).slice(0, 400);
  fs.writeFileSync(path.join(outDir, "index.json"), JSON.stringify({ days }));
  const exists = (col, id) => !!(dbdir && fs.existsSync(path.join(dbdir, col, `${id}.json`)));
  const batches = [[
    { op: "set", collection: "edge_feed", doc_id: date, file_path: path.resolve(outDir, "feed.json"), exists: exists("edge_feed", date) },
    { op: "set", collection: "edge_feed", doc_id: "latest", file_path: path.resolve(outDir, "feed.json"), exists: exists("edge_feed", "latest") },
    { op: "set", collection: "edge_index", doc_id: "days", file_path: path.resolve(outDir, "index.json"), exists: exists("edge_index", "days") },
  ]];
  fs.writeFileSync(path.join(outDir, "batches.json"), JSON.stringify(batches, null, 1));
  console.log(JSON.stringify({ date, mode: feed.mode, counts: feed.counts, added, kb: Math.round(bytes / 1024), dropped, issues, batches: path.resolve(outDir, "batches.json") }));
}

if (cmd === "digest") digest();
else if (cmd === "finish") finish();
else { console.error("usage: node scripts/edge_feed.mjs digest|finish …"); process.exit(2); }
