// Research digest for the daily note: macro prints, market regime, sectors, stock screens, results calendar, filings, headlines.
//   node scripts/research_digest.mjs <app_build_dir> <out.json>
// The daily job's Claude reads this and writes the team's research note (stored in the app's database, "research/latest").
import fs from "node:fs"; import path from "node:path"; import zlib from "node:zlib"; import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const E = require(path.join(path.dirname(new URL(import.meta.url).pathname), "..", "lab", "engine.js"));
const [dir, outFile] = process.argv.slice(2);
if (!dir || !outFile) { console.error("usage: node scripts/research_digest.mjs <app_build_dir> <out.json>"); process.exit(2); }
const data = path.join(dir, "data");
const readJ = (f) => { const js = JSON.parse(fs.readFileSync(f, "utf8")); return js && typeof js.b64gz === "string" ? JSON.parse(zlib.gunzipSync(Buffer.from(js.b64gz, "base64")).toString("utf8")) : js; };
const man = JSON.parse(fs.readFileSync(path.join(data, "manifest.json"), "utf8"));
const light = E.framesFromPack(JSON.parse(fs.readFileSync(path.join(data, "closes.json"), "utf8")));
E.setData({ meta: man.symbols, frames: light });
const res = fs.existsSync(path.join(data, "research.json")) ? readJ(path.join(data, "research.json")) : {};
const full = (s) => { try { const pb = man.symbols[s]?.pb; const raw = pb ? readJ(path.join(data, "pit", "full", `${pb}.json`))[s] : readJ(path.join(data, "p", `${s}.json`)); const f = E.frame(raw); f.sym = s; return f; } catch (e) { return light[s] || null; } };
const C = man.fund?.companies || {};
for (const k of new Set(Object.values(C).map((c) => c.f))) { try { for (const [s, p] of Object.entries(readJ(path.join(data, "fund", `${k}.json`)))) E.setFundamentals(s, p); } catch (e) { /* missing bundle */ } }
const lastOf = (a) => { if (!a) return null; for (let i = a.length - 1; i >= 0; i--) if (a[i] === a[i]) return a[i]; return null; };
const r1 = (x) => x == null || !isFinite(x) ? null : Math.round(x * 10) / 10;
const ev = (expr, f) => { try { const v = E.evaluate(E.parse(expr), f, { frames: light }); return typeof v === "number" ? v : lastOf(v); } catch (e) { return null; } };
const evS = (expr, f) => { try { const v = E.evaluate(E.parse(expr), f, { frames: light }); return typeof v === "number" ? null : v; } catch (e) { return null; } };
const ret = (f, n) => f && f.c.length > n ? r1((f.c[f.c.length - 1] / f.c[f.c.length - 1 - n] - 1) * 100) : null;
const pctRank = (arr, days, fromDay) => { const v = lastOf(arr); const xs = []; for (let i = 0; i < arr.length; i++) if (days[i] >= fromDay && arr[i] === arr[i]) xs.push(arr[i]); return xs.length && v != null ? Math.round(xs.filter((x) => x <= v).length / xs.length * 100) : null; };
const lastDay = Object.values(man.symbols).map((s) => s.last).sort().pop();
const out = { date: lastDay, generated: new Date().toISOString() };
// ---- macro
out.macro = Object.fromEntries(Object.entries(res.macro || {}).map(([k, m]) => [k, { name: m.name, latest: m.last, unit: m.unit, period: m.last_period, released: m.last_known, prev: m.prev, chg_3m: m.chg_3m, chg_12m: m.chg_12m }]));
// ---- market
const mk = {};
for (const s of ["NIFTY", "NIFTY_MIDCAP_150", "NIFTY_SMALLCAP_250", "BANKNIFTY"]) {
  const f = man.symbols[s] ? full(s) : null; if (!f) continue;
  mk[s] = { close: lastOf(f.c), ret_1m: ret(f, 21), ret_3m: ret(f, 63), ret_12m: ret(f, 252), vs_200dma_pct: r1(ev("(close/sma(close,200)-1)*100", f)), pe: f.pe ? lastOf(f.pe) : null, pe_10y_pct: f.pe ? pctRank(f.pe, f.d, f.d[f.d.length - 1] - 3652) : null };
}
if (mk.NIFTY?.pe && out.macro.IN_10Y) mk.NIFTY.equity_risk_premium_pp = r1(100 / mk.NIFTY.pe - out.macro.IN_10Y.latest);
const vix = light.INDIAVIX; if (vix) mk.INDIAVIX = { level: lastOf(vix.c), pct_1y: pctRank(vix.c, vix.d, vix.d[vix.d.length - 1] - 365) };
const ser = (k, e) => light[k] ? r1(ev(e || "close", light[k])) : null;
mk.flows = { fii_idxfut_long_pct: ser("FII_IDXFUT_LONG_PCT"), fii_idxfut_long_pct_20d_ago: ser("FII_IDXFUT_LONG_PCT", "shift(close,20)"), client_idxfut_long_pct: ser("CLIENT_IDXFUT_LONG_PCT"), fii_idxfut_net: ser("FII_IDXFUT_NET"), fii_stkfut_net: ser("FII_STKFUT_NET") };
mk.breadth = { above_200dma_pct: ser("BREADTH_ABOVE200"), above_50dma_pct: ser("BREADTH_ABOVE50"), adv_pct_10d: ser("BREADTH_ADV_PCT", "sma(close,10)"), hl_net_10d: ser("BREADTH_HL_NET", "sum(close,10)") };
mk.global = Object.fromEntries(["USDINR", "DXY", "BRENT", "GOLD", "COPPER", "SPX", "MSCI_EM", "USVIX", "US10Y"].filter((s) => light[s]).map((s) => [s, { last: r1(lastOf(light[s].c)), chg_1m: ret(light[s], 21), chg_3m: ret(light[s], 63) }]));
mk.sector_indices = Object.entries(man.symbols).filter(([, v]) => v.group === "sector" && v.val && !v.alias_of).map(([s, v]) => { const f = full(s); return f ? { index: s, name: v.name, ret_1m: ret(f, 21), ret_3m: ret(f, 63), ret_12m: ret(f, 252), pe: f.pe ? lastOf(f.pe) : null, pe_10y_pct: f.pe ? pctRank(f.pe, f.d, f.d[f.d.length - 1] - 3652) : null } : null; }).filter(Boolean).sort((a, b) => (b.ret_3m ?? -99) - (a.ret_3m ?? -99));
out.market = mk;
// ---- stocks: metrics for the Nifty 500 with results
const rows = [];
for (const [s, m] of Object.entries(man.symbols)) {
  if (m.kind !== "stock" || !m.n500 || !C[s]) continue;
  const f = light[s]; if (!f || f.c.length < 260) continue; f.sym = s;
  const Q = E.fundQuarterly(s); if (!Q) continue;
  const i = Q.q.length - 1, pe = evS("pe", f), peNow = lastOf(pe);
  rows.push({ s, ind: m.industry, pe: r1(peNow), pe5med: pe ? (() => { const xs = []; const from = f.d[f.d.length - 1] - 1826; for (let k = 0; k < pe.length; k++) if (f.d[k] >= from && pe[k] === pe[k]) xs.push(pe[k]); xs.sort((a, b) => a - b); return xs.length ? r1(xs[xs.length >> 1]) : null; })() : null,
    mcap: r1(ev("mcap", f)), pg: r1(Q.profit_growth_ttm[i]), sg: r1(Q.sales_growth_ttm[i]), pgq: r1(Q.profit_growth[i]), sgq: r1(Q.sales_growth[i]), opm: r1(Q.opm[i]), filed: E.isoOf(Q.k[i] - 1),
    r1m: ret(f, 21), r3m: ret(f, 63), r6m: ret(f, 126), r12m: ret(f, 252), a200: ev("close > sma(close,200)", f) === 1, hi52: r1(ev("(close/highest(close,252)-1)*100", f)), prom_chg: r1(ev("promoter_chg", f)) });
}
const med = (xs) => { xs = xs.filter((x) => x != null).sort((a, b) => a - b); return xs.length ? xs[xs.length >> 1] : null; };
const byInd = {}; for (const r of rows) (byInd[r.ind] ||= []).push(r);
out.sectors = Object.entries(byInd).filter(([, v]) => v.length >= 3).map(([ind, v]) => ({ industry: ind, n: v.length, median_pe: med(v.map((r) => r.pe)), median_profit_growth_ttm: med(v.map((r) => r.pg)), median_sales_growth_ttm: med(v.map((r) => r.sg)),
  median_ret_3m: med(v.map((r) => r.r3m)), median_ret_12m: med(v.map((r) => r.r12m)), pct_above_200dma: Math.round(v.filter((r) => r.a200).length / v.length * 100) })).sort((a, b) => (b.median_ret_3m ?? -99) - (a.median_ret_3m ?? -99));
const indPe = Object.fromEntries(out.sectors.map((x) => [x.industry, x.median_pe]));
const pick = (xs, key, n = 12) => xs.sort((a, b) => b[key] - a[key]).slice(0, n).map((r) => ({ symbol: r.s, industry: r.ind, pe: r.pe, pe_5y_median: r.pe5med, industry_pe: indPe[r.ind], profit_growth_ttm: r.pg, sales_growth_ttm: r.sg, last_q_profit_yoy: r.pgq, ret_3m: r.r3m, ret_12m: r.r12m, from_52w_high: r.hi52, mcap_cr: r.mcap, last_result_filed: r.filed }));
out.screens = {
  growth_at_reasonable_price: pick(rows.filter((r) => r.pg > 20 && r.sg > 10 && r.pe > 0 && r.pe < 1.2 * (indPe[r.ind] || 99) && r.a200).map((r) => ({ ...r, k: r.pg / r.pe })), "k"),
  earnings_momentum_recent_results: pick(rows.filter((r) => r.pgq > 25 && r.sgq > 10 && r.filed >= E.isoOf(E.dayOf(lastDay) - 21)), "pgq"),
  near_highs_with_growth: pick(rows.filter((r) => r.hi52 > -5 && r.pg > 15 && r.pe > 0), "r6m"),
  cheap_vs_own_history_quality: pick(rows.filter((r) => r.pe > 0 && r.pe5med && r.pe < 0.8 * r.pe5med && r.pg > 10 && r.opm > 12).map((r) => ({ ...r, k: r.pe5med / r.pe })), "k"),
  promoter_buying: pick(rows.filter((r) => r.prom_chg > 0.5), "prom_chg", 10),
  laggards_deteriorating: pick(rows.filter((r) => r.pg < -15 && !r.a200).map((r) => ({ ...r, k: -r.pg })), "k", 10),
};
// ---- calendar, filings, headlines
const n500 = new Set(Object.entries(man.symbols).filter(([, m]) => m.kind === "stock" && m.n500).map(([s]) => s));
const in7 = E.isoOf(E.dayOf(lastDay) + 9);
out.results_due = (res.events?.items || []).filter((e) => n500.has(e.sym) && /result/i.test(e.purpose) && e.date > lastDay && e.date <= in7).map((e) => ({ date: e.date, symbol: e.sym }));
const since = E.isoOf(E.dayOf(lastDay) - 2);
const KEY = /order|contract|acqui|merger|amalgam|buyback|buy-back|fund rais|qualified institutional|preferential|rating|credit rating|resign|appointment of (md|ceo|managing)|default|insolvency|pledge|block|bonus|split|dividend|capacity|commission|plant|approval|usfda|warning letter|fraud|search|raid|penalty/i;
out.filings = (res.filings?.items || []).filter((x) => n500.has(x.sym) && x.t >= since && KEY.test(x.desc + " " + x.text)).slice(0, 40).map((x) => ({ time: x.t, symbol: x.sym, filing: x.desc, detail: x.text.slice(0, 180) }));
out.headlines = (res.headlines?.items || []).filter((x) => x.t >= since).slice(0, 40).map((x) => ({ time: x.t, source: x.src, headline: x.title }));
fs.writeFileSync(outFile, JSON.stringify(out));
console.log(`digest ${lastDay}: ${Object.keys(out.macro).length} macro series, ${rows.length} stocks, ${out.sectors.length} sectors, ${out.results_due.length} results due, ${out.filings.length} filings, ${out.headlines.length} headlines, ${(fs.statSync(outFile).size / 1024).toFixed(0)} KB`);
