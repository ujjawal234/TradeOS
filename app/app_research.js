  // ================================================================ research: macro, companies, sectors, news
  // data/research.json: macro catalog + headlines + NSE filings + results calendar; data/fund/*: company results as filed
  let researchP = null;
  function loadResearch() {
    if (!researchP) researchP = (S.man.research ? fetchJsonGz("data/research.json") : Promise.resolve({})).catch((e) => { researchP = null; throw e; });
    return researchP;
  }
  S.fundFiles = {}; S.fundLoaded = new Set();
  async function ensureFund(syms, onProgress) {
    const C = S.man.fund?.companies || {};
    const keys = [...new Set([...new Set(syms)].filter((s) => C[s] && !S.fundLoaded.has(s)).map((s) => C[s].f))]; let done = 0;
    await Promise.all(keys.map(async (k) => {
      if (!S.fundFiles[k]) S.fundFiles[k] = fetchJsonGz(`data/fund/${k}.json`).catch((e) => { delete S.fundFiles[k]; throw e; });
      const js = await S.fundFiles[k];
      for (const [s, p] of Object.entries(js)) if (!S.fundLoaded.has(s)) { E.setFundamentals(s, p); S.fundLoaded.add(s); }
      done++; if (onProgress && keys.length > 1) onProgress(done, keys.length);
    }));
  }
  let profilesP = null;
  function loadProfiles() { if (!profilesP) profilesP = (S.man.fund ? fetchJsonGz("data/fund/profiles.json") : Promise.resolve({})).catch(() => ({})); return profilesP; }
  const r1 = (x) => x == null || !isFinite(x) ? null : Math.round(x * 10) / 10;
  const r2r = (x) => x == null || !isFinite(x) ? null : Math.round(x * 100) / 100;
  const lastOf = (a) => { for (let i = a.length - 1; i >= 0; i--) if (a[i] === a[i]) return a[i]; return null; };
  function priceFrame(sym) { const f = S.full[sym] || S.light[sym] || S.pitFull?.[sym] || S.pitLight?.[sym]; if (f && !f.sym) f.sym = sym; return f || null; }
  function evalLast(expr, f) { try { const v = E.evaluate(E.parse(expr), f, { frames: S.light }); return typeof v === "number" ? v : lastOf(v); } catch (e) { return null; } }
  function evalSeries(expr, f) { try { const v = E.evaluate(E.parse(expr), f, { frames: S.light }); return typeof v === "number" ? null : v; } catch (e) { return null; } }
  function pctRank(arr, v, fromDay, days) { const xs = []; for (let i = 0; i < arr.length; i++) if (days[i] >= fromDay && arr[i] === arr[i]) xs.push(arr[i]); if (!xs.length || v == null) return null; return Math.round(xs.filter((x) => x <= v).length / xs.length * 100); }
  const ord = (n) => n == null ? "–" : `${n}${(n % 100 >= 11 && n % 100 <= 13) ? "th" : ["th", "st", "nd", "rd"][n % 10] || "th"}`;

  // ---- one company: results, valuation vs its own history and peers, shareholding, price, options, events, filings, headlines
  async function companyResearch(symIn) {
    const sym = E.symKey(symIn), meta = S.man.symbols[sym] || {}, C = S.man.fund?.companies || {};
    if (!meta.kind && !C[sym]) return { symbol: sym, error: `Unknown symbol ${sym}. Use an NSE ticker (Nifty 500 / F&O stocks have full data).` };
    const industry = meta.industry || "";
    const peers = Object.entries(S.man.symbols).filter(([s, m]) => m.kind === "stock" && m.industry === industry && C[s]).map(([s]) => s);
    await Promise.all([ensureFund([sym, ...peers]), ensureFull([sym]).catch(() => null)]);
    const [res, prof] = await Promise.all([loadResearch().catch(() => ({})), loadProfiles()]);
    const f = priceFrame(sym), out = { symbol: sym, name: meta.name || C[sym]?.company, industry, index_membership: [meta.n50 && "Nifty 50", meta.n200 && "Nifty 200", meta.n500 && "Nifty 500", meta.fno && `F&O (lot ${meta.lot})`].filter(Boolean) };
    const p = prof[sym]; if (p) out.profile = { sector: p.sector, industry: p.industry, business: p.longBusinessSummary, employees: p.fullTimeEmployees,
      snapshot_ratios_yahoo: { roe_pct: r1(p.returnOnEquity * 100), roa_pct: r1(p.returnOnAssets * 100), debt_to_equity: r1(p.debtToEquity), current_ratio: r2r(p.currentRatio), dividend_yield_pct: r2r(p.dividendYield), payout_pct: r1(p.payoutRatio * 100), beta: r2r(p.beta), ev_ebitda: r1(p.enterpriseToEbitda), price_to_book: r2r(p.priceToBook), forward_pe: r1(p.forwardPE) },
      analysts: p.numberOfAnalystOpinions ? { count: p.numberOfAnalystOpinions, consensus: p.recommendationKey, mean_score_1buy_5sell: r2r(p.recommendationMean), target_mean: r1(p.targetMeanPrice), target_high: r1(p.targetHighPrice), target_low: r1(p.targetLowPrice) } : null,
      holdings: { insiders_pct: r1(p.heldPercentInsiders * 100), institutions_pct: r1(p.heldPercentInstitutions * 100) }, as_of: p._at };
    if (f) {
      const snap = snapshot(sym); delete snap.symbol; delete snap.name; delete snap.industry; out.price = snap;
      if (S.light.NIFTY) out.price.beta_1y_vs_nifty = r2r(evalLast('beta(ret(close,1), ref("NIFTY", ret(close,1)), 252)', f));
    }
    const Q = E.fundQuarterly(sym), raw = (S.fundLoaded.has(sym) && C[sym]) ? C[sym] : null;
    if (Q && raw) {
      const n = Q.q.length, rows = [];
      for (let i = n - 1; i >= Math.max(0, n - 12); i--) rows.push({ quarter: E.isoOf(Q.q[i]), filed: E.isoOf(Q.k[i] - 1), sales_cr: r1(Q.sales[i]), sales_yoy_pct: r1(Q.sales_growth[i]), ebitda_margin_pct: r1(Q.opm[i]),
        profit_cr: r1(Q.profit[i]), profit_yoy_pct: r1(Q.profit_growth[i]), net_margin_pct: r1(Q.npm[i]), ...(raw.bank ? { gnpa_pct: r2r(Q.gnpa[i]), nnpa_pct: r2r(Q.nnpa[i]), nii_yoy_pct: r1(Q.nii_growth[i]) } : {}) });
      const i = n - 1;
      out.results = { basis: raw.basis, latest_quarter: E.isoOf(Q.q[i]), filed: E.isoOf(Q.k[i] - 1), ttm: { sales_cr: r1(Q.sales_ttm[i]), profit_cr: r1(Q.profit_ttm[i]), eps_rs: r2r(Q.eps_ttm[i]),
        sales_growth_pct: r1(Q.sales_growth_ttm[i]), profit_growth_pct: r1(Q.profit_growth_ttm[i]), sales_cagr_3y_pct: r1(Q.sales_cagr_3y[i]), profit_cagr_3y_pct: r1(Q.profit_cagr_3y[i]) }, quarters: rows,
        note: "₹ crore; from NSE filings (XBRL) as first filed; y/y vs the same quarter a year earlier" };
    }
    if (f && Q) {
      const days = f.d, from5 = days[days.length - 1] - 5 * 365, pe = evalSeries("pe", f), ps = evalSeries("ps", f);
      const peNow = pe && lastOf(pe), psNow = ps && lastOf(ps);
      out.valuation = { pe_ttm: r1(peNow), pe_5y_percentile: pe ? pctRank(pe, peNow, from5, days) : null, pe_5y_median: pe ? r1(median(pe, days, from5)) : null,
        price_to_sales: r2r(psNow), mcap_cr: r1(evalLast("mcap", f)), earnings_yield_pct: r2r(evalLast("earnings_yield", f)) };
    }
    const sh = E.fundQuarterly && S.fundLoaded.has(sym) ? (await (async () => { const pp = await ensureRawFund(sym); return pp?.shp; })()) : null;
    if (sh && sh.length) out.shareholding = { promoter_pct_history: sh.slice(-8).map(([k, v]) => [E.isoOf(k - 1), v]) };
    if (peers.length > 1) out.peers = peerTable(sym, peers);
    if (S.man.options?.underlyings?.[sym]) { try { const o = await optionSnapshot(sym); out.options = { iv30_pct: o.iv30_pct, iv_1y_percentile: o.iv_1y_percentile, put_call_oi: o.put_call_oi_ratio, max_pain: o.max_pain, skew_vol_pts: o.skew_vol_pts, date: o.date }; } catch (e) { /* optional */ } }
    const ev = (res.events?.items || []).filter((e) => e.sym === sym).slice(0, 5); if (ev.length) out.upcoming_events = ev;
    const fl = (res.filings?.items || []).filter((x) => x.sym === sym).slice(0, 12).map((x) => ({ time: x.t, filing: x.desc, detail: x.text })); if (fl.length) out.recent_filings = fl;
    const nm = (meta.name || "").split(/\s+/)[0];
    const hl = (res.headlines?.items || []).filter((x) => (x.syms || []).includes(sym) || (nm.length > 4 && new RegExp(`\\b${nm}\\b`, "i").test(x.title))).slice(0, 10).map((x) => ({ time: x.t, source: x.src, headline: x.title }));
    if (hl.length) out.headlines = hl;
    return out;
  }
  function median(arr, days, fromDay) { const xs = []; for (let i = 0; i < arr.length; i++) if (days[i] >= fromDay && arr[i] === arr[i]) xs.push(arr[i]); if (!xs.length) return null; xs.sort((a, b) => a - b); return xs[xs.length >> 1]; }
  async function ensureRawFund(sym) { const k = S.man.fund?.companies?.[sym]?.f; if (!k) return null; if (!S.fundFiles[k]) S.fundFiles[k] = fetchJsonGz(`data/fund/${k}.json`); const js = await S.fundFiles[k]; return js[sym] || null; }
  function peerTable(sym, peers) {
    const rows = [];
    for (const s of peers) {
      const f = priceFrame(s); if (!f) continue;
      const Q = E.fundQuarterly(s); if (!Q) continue;
      const i = Q.q.length - 1;
      rows.push({ symbol: s, mcap_cr: r1(evalLast("mcap", f)), pe: r1(evalLast("pe", f)), sales_growth_ttm: r1(Q.sales_growth_ttm[i]), profit_growth_ttm: r1(Q.profit_growth_ttm[i]), ebitda_margin: r1(Q.opm[i]), ret_6m_pct: r1(evalLast("roc(close,126)", f)) });
    }
    rows.sort((a, b) => (b.mcap_cr ?? 0) - (a.mcap_cr ?? 0));
    const med = (k) => { const xs = rows.map((r) => r[k]).filter((x) => x != null).sort((a, b) => a - b); return xs.length ? xs[xs.length >> 1] : null; };
    return { industry_medians: { pe: med("pe"), sales_growth_ttm: med("sales_growth_ttm"), profit_growth_ttm: med("profit_growth_ttm"), ebitda_margin: med("ebitda_margin"), ret_6m_pct: med("ret_6m_pct") },
      largest: rows.slice(0, 10), this_company_rank_by_mcap: rows.findIndex((r) => r.symbol === sym) + 1, peers_with_data: rows.length };
  }

  // ---- macro and market dashboard: the latest prints plus what the market is pricing
  async function macroDashboard() {
    const res = await loadResearch().catch(() => ({}));
    const cat = res.macro || {};
    const macro = Object.entries(cat).map(([k, m]) => ({ key: k, name: m.name, group: m.group, latest: m.last, unit: m.unit, period: m.last_period, released_by: m.last_known, previous: m.prev, change_3m: m.chg_3m, change_12m: m.chg_12m, ...(m.stale ? { stale: true } : {}) }));
    const idx = ["NIFTY", "NIFTY_MIDCAP_150", "NIFTY_SMALLCAP_250", "BANKNIFTY", "NIFTY_IT", "INDIAVIX"].filter((s) => S.man.symbols[s]);
    await ensureFull(idx).catch(() => null);
    const mk = {};
    const ret = (s, n) => { const f = priceFrame(s); if (!f) return null; const c = f.c, L = c.length; return L > n ? r1((c[L - 1] / c[L - 1 - n] - 1) * 100) : null; };
    const nf = priceFrame("NIFTY");
    if (nf) {
      const from10 = nf.d[nf.d.length - 1] - 3652;
      const pe = nf.pe ? lastOf(nf.pe) : null, pb = nf.pb ? lastOf(nf.pb) : null, dy = nf.dy ? lastOf(nf.dy) : null;
      mk.nifty = { close: r2r(lastOf(nf.c)), ret_1m: ret("NIFTY", 21), ret_3m: ret("NIFTY", 63), ret_12m: ret("NIFTY", 252), vs_200dma_pct: r1(evalLast("(close / sma(close,200) - 1) * 100", nf)),
        pe, pe_10y_percentile: nf.pe ? pctRank(nf.pe, pe, from10, nf.d) : null, pb, div_yield: dy, earnings_yield_pct: pe ? r2r(100 / pe) : null };
      const g10 = cat.IN_10Y?.last; if (pe && g10 != null) mk.nifty.equity_risk_premium_pp = r2r(100 / pe - g10);
    }
    for (const s of ["NIFTY_MIDCAP_150", "NIFTY_SMALLCAP_250"]) { const f = priceFrame(s); if (f && f.pe) mk[s.toLowerCase()] = { pe: lastOf(f.pe), pe_10y_percentile: pctRank(f.pe, lastOf(f.pe), f.d[f.d.length - 1] - 3652, f.d), ret_3m: ret(s, 63), ret_12m: ret(s, 252) }; }
    const vix = priceFrame("INDIAVIX"); if (vix) mk.india_vix = { level: r2r(lastOf(vix.c)), percentile_1y: pctRank(vix.c, lastOf(vix.c), vix.d[vix.d.length - 1] - 365, vix.d) };
    const ser = (k, expr) => { const f = S.light[k]; return f ? r2r(evalLast(expr || "close", f)) : null; };
    mk.flows = { fii_index_futures_long_pct: ser("FII_IDXFUT_LONG_PCT"), fii_index_futures_long_pct_20d_ago: ser("FII_IDXFUT_LONG_PCT", "shift(close,20)"), fii_stock_futures_net: ser("FII_STKFUT_NET"),
      client_index_futures_long_pct: ser("CLIENT_IDXFUT_LONG_PCT"), fii_cash_net_20d_cr: ser("FII_CASH_NET", "sum(close,20)"), dii_cash_net_20d_cr: ser("DII_CASH_NET", "sum(close,20)") };
    mk.breadth = { pct_above_200dma: ser("BREADTH_ABOVE200"), pct_above_50dma: ser("BREADTH_ABOVE50"), advancers_pct_10d_avg: ser("BREADTH_ADV_PCT", "sma(close,10)"), new_highs_minus_lows_10d: ser("BREADTH_HL_NET", "sum(close,10)") };
    const g = (s) => S.light[s] ? { last: r2r(lastOf(S.light[s].c)), chg_1m_pct: ret(s, 21), chg_3m_pct: ret(s, 63) } : null;
    mk.global = { usdinr: g("USDINR"), dxy: g("DXY"), brent: g("BRENT"), gold: g("GOLD"), copper: g("COPPER"), sp500: g("SPX"), msci_em: g("MSCI_EM"), us_vix: g("USVIX"), us10y: g("US10Y") };
    const sectors = Object.entries(S.man.symbols).filter(([, v]) => v.group === "sector" && v.val && !v.alias_of).map(([s]) => s);
    await ensureFull(sectors).catch(() => null);
    mk.sector_indices = sectors.map((s) => { const f = priceFrame(s); if (!f) return null; const pe = f.pe ? lastOf(f.pe) : null;
      return { index: s, name: S.man.symbols[s].name, ret_1m: ret(s, 21), ret_3m: ret(s, 63), ret_12m: ret(s, 252), pe, pe_10y_percentile: f.pe ? pctRank(f.pe, pe, f.d[f.d.length - 1] - 3652, f.d) : null }; }).filter(Boolean).sort((a, b) => (b.ret_3m ?? -99) - (a.ret_3m ?? -99));
    return { as_of: S.lastDay, macro, markets: mk, note: "macro 'released_by' is the date the number became public; series keys work in rules as ref(\"KEY\", close)" };
  }

  // ---- screen any universe on any rule-language expressions (latest values), with the key metrics alongside
  async function screenTool({ universe, filters, rank_by, top, ascending }, progress) {
    let list = Array.isArray(universe) ? universe.map(E.symKey) : (S.man.universes[String(universe || "nifty500").toLowerCase().replace(/[^a-z0-9]/g, "")] || []);
    list = list.filter((s) => S.man.symbols[s]?.kind === "stock" || S.pitSyms?.has(s));
    if (!list.length) throw new Error(`Unknown universe ${universe}. Use one of: ${Object.keys(S.man.universes).join(", ")}, or a list of tickers.`);
    const exprs = [...(filters || []), rank_by].filter(Boolean).map(String);
    exprs.forEach((x) => E.validate(x));
    const full = exprs.some((x) => /\b(open|high|low|volume|atr|adx|obv|mfi|vwap|cci|supertrend|stoch_k|williams_r)\b/.test(x));
    progress && progress(`Screening ${list.length} stocks…`);
    await ensureFund(list);
    if (full) await ensureFull(list.filter((s) => S.man.symbols[s]));
    const rows = [];
    for (const s of list) {
      const f = priceFrame(s); if (!f || f.c.length < 2) continue;
      if ((filters || []).some((x) => { const v = evalLast(x, f); return !(v === v && v); })) continue;
      const rk = rank_by ? evalLast(rank_by, f) : null;
      if (rank_by && !(rk === rk && rk != null)) continue;
      rows.push({ symbol: s, rank_value: r2r(rk), close: r2r(lastOf(f.c)), pe: r1(evalLast("pe", f)), mcap_cr: r1(evalLast("mcap", f)), profit_growth_ttm: r1(evalLast("profit_growth_ttm", f)),
        sales_growth_ttm: r1(evalLast("sales_growth_ttm", f)), ebitda_margin: r1(evalLast("opm", f)), ret_6m_pct: r1(evalLast("roc(close,126)", f)), industry: S.man.symbols[s]?.industry || "" });
    }
    if (rank_by) rows.sort((a, b) => ascending ? a.rank_value - b.rank_value : b.rank_value - a.rank_value);
    return { universe: Array.isArray(universe) ? `${list.length} symbols` : universe, matched: rows.length, of: list.length, as_of: S.lastDay, rows: rows.slice(0, Math.min(40, top || 20)) };
  }

  // ---- sectors bottom-up: medians of their stocks' valuation, growth and momentum (Nifty 500 members with results)
  async function sectorView() {
    const C = S.man.fund?.companies || {};
    const stocks = Object.entries(S.man.symbols).filter(([s, m]) => m.kind === "stock" && m.n500 && C[s]).map(([s]) => s);
    await ensureFund(stocks);
    const by = {};
    for (const s of stocks) {
      const f = priceFrame(s); if (!f) continue;
      const ind = S.man.symbols[s].industry || "Other", Q = E.fundQuarterly(s); if (!Q) continue;
      const i = Q.q.length - 1;
      (by[ind] ||= []).push({ pe: evalLast("pe", f), pg: Q.profit_growth_ttm[i], sg: Q.sales_growth_ttm[i], r3: evalLast("roc(close,63)", f), r12: evalLast("roc(close,252)", f), a200: evalLast("close > sma(close,200)", f), mc: evalLast("mcap", f) });
    }
    const med = (xs) => { xs = xs.filter((x) => x != null && x === x).sort((a, b) => a - b); return xs.length ? r1(xs[xs.length >> 1]) : null; };
    const rows = Object.entries(by).filter(([, v]) => v.length >= 3).map(([ind, v]) => ({ industry: ind, stocks: v.length, mcap_total_cr: Math.round(v.reduce((a, x) => a + (x.mc > 0 ? x.mc : 0), 0)),
      median_pe: med(v.map((x) => x.pe)), median_profit_growth_ttm: med(v.map((x) => x.pg)), median_sales_growth_ttm: med(v.map((x) => x.sg)), median_ret_3m: med(v.map((x) => x.r3)), median_ret_12m: med(v.map((x) => x.r12)),
      pct_above_200dma: Math.round(v.filter((x) => x.a200 === 1).length / v.length * 100) }));
    rows.sort((a, b) => (b.median_ret_3m ?? -99) - (a.median_ret_3m ?? -99));
    return { as_of: S.lastDay, basis: "Nifty 500 stocks by NSE industry; growth from the latest filed quarter's TTM vs a year earlier", industries: rows };
  }

  // ---- headlines, filings and the results calendar
  async function newsTool({ symbol, query, days }) {
    const res = await loadResearch().catch(() => ({}));
    const since = E.isoOf(E.dayOf(new Date().toISOString().slice(0, 10)) - (days || 7));
    const sym = symbol ? E.symKey(symbol) : null, rx = query ? new RegExp(String(query).replace(/[^\w\s|&-]/g, ""), "i") : null;
    const hl = (res.headlines?.items || []).filter((x) => x.t >= since && (!sym || (x.syms || []).includes(sym) || new RegExp(`\\b${sym}\\b`, "i").test(x.title)) && (!rx || rx.test(x.title))).slice(0, 25).map((x) => ({ time: x.t, source: x.src, headline: x.title }));
    const fl = (res.filings?.items || []).filter((x) => x.t >= since && (!sym || x.sym === sym) && (!rx || rx.test(x.desc + " " + x.text))).slice(0, sym ? 20 : 30).map((x) => ({ time: x.t, symbol: x.sym, filing: x.desc, detail: x.text }));
    const ev = (res.events?.items || []).filter((e) => (!sym || e.sym === sym) && (!rx || rx.test(e.purpose + " " + e.desc))).slice(0, sym ? 5 : 40).map((e) => ({ date: e.date, symbol: e.sym, purpose: e.purpose }));
    return { as_of: res.headlines?.asof, headlines: hl, filings: fl, upcoming_board_meetings: ev, note: "headlines are titles only (publishers' RSS); filings are NSE's one-line descriptions" };
  }
  async function researchNote() { try { const snap = await S.db.doc("research/latest").get(); return snap.exists ? snap.data() : null; } catch (e) { return null; } }
  function researchTools(progress) {
    return [
      { name: "macro_dashboard", description: "Macro & market regime in one call: latest Indian and global macro prints (RBI repo, CPI, IIP, GDP, 10y yield, FX reserves, trade, M3, OECD leading indicator; US Fed funds, yields, curve, real yields, breakevens, credit spreads, dollar, oil, CPI, jobs, financial stress, ECB/Japan/Germany/China) with release dates and 3m/12m changes, plus Nifty/midcap/smallcap valuations (P/E and its 10-year percentile, equity risk premium vs India 10y), India VIX percentile, FII/DII positioning and flows, market breadth, global assets, and every NSE sector index's returns and P/E percentile; also the last daily research note written after the close.",
        execute: async () => { progress("Reading the macro dashboard…"); const d = await macroDashboard(); const n = await researchNote(); return n && n.body ? { ...d, last_daily_research_note: { date: n.date, text: String(n.body).slice(0, 5000) } } : d; } },
      { name: "company_research", description: "Everything on one NSE company: business profile, last 12 quarters of results as filed (sales, EBITDA margin, profit, y/y growth; banks: NPAs, NII growth), TTM and 3-year CAGRs, valuation now vs its own 5-year history (P/E percentile), industry peers table with medians, promoter-holding trend, price performance and technicals, beta, option IV/PCR, analyst consensus (Yahoo snapshot), upcoming board meetings, recent NSE filings and headlines.",
        inputSchema: { type: "object", properties: { symbol: { type: "string" } }, required: ["symbol"] },
        execute: async (input) => { progress(`Researching ${E.symKey(input.symbol)}…`); return companyResearch(input.symbol); } },
      { name: "screen", description: "Screen a universe (nifty50, nifty200, nifty500, fno, top500pit, a sector group, or a list of tickers) with rule-language expressions on the LATEST data, e.g. filters [\"pe > 0\", \"pe < 25\", \"profit_growth_ttm > 20\", \"close > sma(close,200)\"], rank_by \"profit_growth_ttm / pe\". Returns matches with P/E, mcap, growth, margin, 6m return and industry.",
        inputSchema: { type: "object", properties: { universe: {}, filters: { type: "array", items: { type: "string" } }, rank_by: { type: "string" }, ascending: { type: "boolean" }, top: { type: "number" } }, required: ["universe"] },
        execute: async (input) => screenTool(input, progress) },
      { name: "sector_view", description: "Bottom-up view of every industry in the Nifty 500: median P/E, median TTM sales and profit growth, median 3m and 12m returns, % of stocks above their 200-day average, total market cap. Use with macro_dashboard to connect macro drivers to sectors.",
        execute: async () => { progress("Comparing sectors…"); return sectorView(); } },
      { name: "news", description: "Recent headlines (ET, Mint, RBI press releases), NSE corporate filings (orders, results, management changes, fund raising, M&A…) and upcoming board meetings (results dates). Filter by symbol and/or a keyword query; days = look-back (default 7).",
        inputSchema: { type: "object", properties: { symbol: { type: "string" }, query: { type: "string" }, days: { type: "number" } } },
        execute: async (input) => { progress("Reading news and filings…"); return newsTool(input || {}); } },
    ];
  }
  function researchBrief(m) {
    const fund = m.fund, n = fund ? Object.keys(fund.companies || {}).length : 0;
    const mac = Object.entries(m.symbols).filter(([, v]) => v.group === "macro").map(([k, v]) => `${k}=${v.name.replace(/ \(.*$/, "")}`).join("; ");
    return `${n ? `COMPANY RESULTS: quarterly results as filed with NSE (XBRL, mid-2018 onwards) for ${n} companies incl. delisted/dropped ones, latest filing ${fund.latest_filing}; shareholding (promoter %) history; Yahoo profile snapshot (business, ROE, debt, analyst consensus). Point in time: a result counts from the day after it was filed. Rule-language variables on any stock: sales, profit (latest quarter, ₹ cr), sales_ttm, profit_ttm, eps_ttm, sales_growth, profit_growth (y/y %, latest quarter), sales_growth_ttm, profit_growth_ttm, sales_cagr_3y, profit_cagr_3y, opm (EBITDA margin %), npm (net margin %), pe (price / TTM EPS; for NSE indices pe is the index P/E), mcap (₹ cr), ps (price/sales), earnings_yield (%), promoter (%), promoter_chg (pp vs previous filing), result_day (1 on the first day after a result), days_since_result, gnpa, nnpa (banks, %), nii_growth (banks, y/y %). Use them in rule entries/exits, rotation factors/filters/weights (e.g. factors [{"name":"earnings_yield"},{"name":"profit_growth_ttm"}], filters ["profit_growth_ttm > 15"]).` : "COMPANY RESULTS: not in this build yet."}
${mac ? `MACRO SERIES (usable from their release date, so no look-ahead; use via ref("KEY", close), e.g. regime "ref(\\"IN_CPI_YOY\\", close) < 5", entry "ref(\\"US_10Y_YIELD\\", change(close,21)) < 0"): ${mac}.` : ""}
RESEARCH TOOLS: macro_dashboard, sector_view, company_research, screen, news (plus backtest, market_snapshot, rank, option_data).`;
  }

  // ================================================================ RESEARCH VIEW (macro dashboard, company page, news)
  let researchTab = "macro";
  async function renderResearch() {
    const box = $("researchBody");
    document.querySelectorAll("#researchTabs button").forEach((b) => b.setAttribute("aria-selected", String(b.dataset.rtab === researchTab)));
    box.innerHTML = '<p class="muted">Loading…</p>';
    try {
      if (researchTab === "macro") await renderMacroTab(box);
      else if (researchTab === "sectors") await renderSectorsTab(box);
      else if (researchTab === "company") await renderCompanyTab(box);
      else await renderNewsTab(box);
    } catch (e) { box.innerHTML = `<p class="flag">${esc(e.message || e)}</p>`; }
  }
  function spark(vals, w = 120, h = 28) {
    const xs = vals.filter((v) => v === v && v != null); if (xs.length < 2) return "";
    const lo = Math.min(...xs), hi = Math.max(...xs), n = vals.length;
    const pts = vals.map((v, i) => v === v && v != null ? `${(i / (n - 1) * w).toFixed(1)},${(h - 2 - (v - lo) / (hi - lo || 1) * (h - 4)).toFixed(1)}` : null).filter(Boolean).join(" ");
    return `<svg class="spark" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" aria-hidden="true"><polyline points="${pts}" fill="none" stroke="var(--series-a)" stroke-width="1.5"/></svg>`;
  }
  function seriesTail(key, days = 1100) { const f = S.light[key]; if (!f) return []; const c = f.c, out = []; const step = Math.max(1, Math.floor(Math.min(days, c.length) / 60)); for (let i = Math.max(0, c.length - days); i < c.length; i += step) out.push(c[i]); out.push(c[c.length - 1]); return out; }
  const fmtV = (v, unit) => v == null ? "–" : unit === "%" || unit === "pp" ? `${Number(v).toFixed(2)}${unit === "%" ? "%" : " pp"}` : Math.abs(v) >= 1000 ? Math.round(v).toLocaleString("en-IN") : Number(v).toFixed(2);
  const chgV = (v, unit) => v == null ? "" : `<span class="${cls(v)}">${v > 0 ? "+" : ""}${unit === "%" || unit === "pp" ? Number(v).toFixed(2) + " pp" : Number(v).toFixed(2)}</span>`;
  async function renderMacroTab(box) {
    const d = await macroDashboard(), mk = d.markets;
    const note = await researchNote();
    const groups = [["India", d.macro.filter((m) => m.group === "india")], ["United States & global", d.macro.filter((m) => m.group !== "india")]];
    const tile = (m) => `<div class="mtile"><span class="k">${esc(m.name)}</span><span class="v">${fmtV(m.latest, m.unit)}</span><span class="b">${esc(m.period?.slice(0, 7) || "")}${m.stale ? " · stale" : ""} · 3m ${chgV(m.change_3m, m.unit) || "–"} · 12m ${chgV(m.change_12m, m.unit) || "–"}</span>${spark(seriesTail(m.key))}</div>`;
    const n = mk.nifty || {};
    const kv = (rows) => `<dl class="kv">${rows.filter(([, v]) => v != null && v !== "").map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join("")}</dl>`;
    box.innerHTML = `
      ${note && note.body ? `<div class="card researchnote"><h2>${esc(note.title || "Research note")}</h2><p class="muted">${esc(note.date || "")} · written by Claude from the data below after the close</p>${md(String(note.body))}</div>` : ""}
      <div class="grid2">
        <div class="card"><h2>Indian equities</h2>${kv([["Nifty", `${px(n.close)} · 1m ${pct(n.ret_1m)} · 3m ${pct(n.ret_3m)} · 12m ${pct(n.ret_12m)}`], ["vs 200-day avg", pct(n.vs_200dma_pct)],
          ["Nifty P/E", n.pe != null ? `${n.pe} (${ord(n.pe_10y_percentile)} percentile of 10 years)` : null], ["Earnings yield − India 10y", n.equity_risk_premium_pp != null ? `${n.equity_risk_premium_pp} pp` : null],
          ["Midcap 150 P/E", mk.nifty_midcap_150 ? `${mk.nifty_midcap_150.pe} (${ord(mk.nifty_midcap_150.pe_10y_percentile)} pct) · 3m ${pct(mk.nifty_midcap_150.ret_3m)}` : null],
          ["Smallcap 250 P/E", mk.nifty_smallcap_250 ? `${mk.nifty_smallcap_250.pe} (${ord(mk.nifty_smallcap_250.pe_10y_percentile)} pct) · 3m ${pct(mk.nifty_smallcap_250.ret_3m)}` : null],
          ["India VIX", mk.india_vix ? `${mk.india_vix.level} (${ord(mk.india_vix.percentile_1y)} percentile of the year)` : null]])}</div>
        <div class="card"><h2>Positioning, flows, breadth</h2>${kv([["FII index futures long %", mk.flows.fii_index_futures_long_pct != null ? `${mk.flows.fii_index_futures_long_pct}% (20 days ago ${mk.flows.fii_index_futures_long_pct_20d_ago}%)` : null],
          ["Clients index futures long %", mk.flows.client_index_futures_long_pct != null ? `${mk.flows.client_index_futures_long_pct}%` : null], ["FII cash, last 20 days", mk.flows.fii_cash_net_20d_cr != null ? inr(mk.flows.fii_cash_net_20d_cr * 1e7).replace("₹", "₹") : null],
          ["Stocks above 200-day avg", mk.breadth.pct_above_200dma != null ? `${mk.breadth.pct_above_200dma}%` : null], ["Stocks above 50-day avg", mk.breadth.pct_above_50dma != null ? `${mk.breadth.pct_above_50dma}%` : null],
          ["Advancers (10-day avg)", mk.breadth.advancers_pct_10d_avg != null ? `${mk.breadth.advancers_pct_10d_avg}%` : null], ["52w highs − lows (10 days)", mk.breadth.new_highs_minus_lows_10d]])}</div>
      </div>
      ${groups.map(([t, ms]) => ms.length ? `<div class="card"><h2>${t}</h2><div class="mgrid">${ms.map(tile).join("")}</div></div>` : "").join("")}
      <div class="grid2"><div class="card"><h2>Global assets</h2><div class="tablewrap"><table><thead><tr><th></th><th class="r">Last</th><th class="r">1m</th><th class="r">3m</th></tr></thead><tbody>${Object.entries(mk.global).filter(([, v]) => v).map(([k, v]) => `<tr><td>${esc(S.man.symbols[{ usdinr: "USDINR", dxy: "DXY", brent: "BRENT", gold: "GOLD", copper: "COPPER", sp500: "SPX", msci_em: "MSCI_EM", us_vix: "USVIX", us10y: "US10Y" }[k]]?.name || k)}</td><td class="r">${px(v.last)}</td><td class="r ${cls(v.chg_1m_pct)}">${pct(v.chg_1m_pct)}</td><td class="r ${cls(v.chg_3m_pct)}">${pct(v.chg_3m_pct)}</td></tr>`).join("")}</tbody></table></div></div>
      <div class="card"><h2>Sector indices</h2><div class="tablewrap tall"><table><thead><tr><th>Index</th><th class="r">1m</th><th class="r">3m</th><th class="r">12m</th><th class="r">P/E</th><th class="r">P/E pct (10y)</th></tr></thead><tbody>${mk.sector_indices.map((s) => `<tr><td>${esc(s.name)}</td><td class="r ${cls(s.ret_1m)}">${pct(s.ret_1m)}</td><td class="r ${cls(s.ret_3m)}">${pct(s.ret_3m)}</td><td class="r ${cls(s.ret_12m)}">${pct(s.ret_12m)}</td><td class="r">${s.pe ?? "–"}</td><td class="r">${s.pe_10y_percentile ?? "–"}</td></tr>`).join("")}</tbody></table></div></div></div>
      <p class="note">Macro numbers show the period they describe; strategies only see them from their release date. Ask the Main Agent to read the regime and connect it to sectors and stocks.</p>`;
  }
  async function renderSectorsTab(box) {
    if (!S.man.fund) { box.innerHTML = '<p class="muted">Company results aren\'t in this build yet.</p>'; return; }
    box.innerHTML = '<p class="thinking">Computing sector medians from every Nifty 500 company<span class="dots"></span></p>';
    const v = await sectorView();
    box.innerHTML = `<div class="card"><h2>Industries, bottom-up</h2><p class="small muted" style="margin:4px 0 8px">${esc(v.basis)}. Sorted by 3-month momentum.</p><div class="tablewrap tall"><table><thead><tr><th>Industry</th><th class="r">Stocks</th><th class="r">Median P/E</th><th class="r">Profit growth</th><th class="r">Sales growth</th><th class="r">3m</th><th class="r">12m</th><th class="r">&gt; 200d</th><th class="r">Mcap (₹ L cr)</th></tr></thead><tbody>
      ${v.industries.map((r) => `<tr><td>${esc(r.industry)}</td><td class="r">${r.stocks}</td><td class="r">${r.median_pe ?? "–"}</td><td class="r ${cls(r.median_profit_growth_ttm)}">${pct(r.median_profit_growth_ttm, 0)}</td><td class="r ${cls(r.median_sales_growth_ttm)}">${pct(r.median_sales_growth_ttm, 0)}</td><td class="r ${cls(r.median_ret_3m)}">${pct(r.median_ret_3m)}</td><td class="r ${cls(r.median_ret_12m)}">${pct(r.median_ret_12m)}</td><td class="r">${r.pct_above_200dma}%</td><td class="r">${(r.mcap_total_cr / 1e5).toFixed(1)}</td></tr>`).join("")}</tbody></table></div></div>`;
  }
  S.researchSym = "RELIANCE";
  async function renderCompanyTab(box) {
    const opts = Object.entries(S.man.symbols).filter(([, m]) => m.kind === "stock").map(([s, m]) => `<option value="${esc(s)}">${esc(m.name)}</option>`).join("");
    box.innerHTML = `<form class="row" id="coForm" style="margin-bottom:12px"><input class="input" id="coSym" list="coList" value="${esc(S.researchSym)}" style="max-width:260px" aria-label="Company ticker" autocomplete="off"><datalist id="coList">${opts}</datalist><button class="btn small" type="submit">Open</button><span class="grow"></span><button class="btn ghost small" type="button" id="coAsk">Ask the Main Agent for a full report</button></form><div id="coBody"><p class="thinking">Loading ${esc(S.researchSym)}<span class="dots"></span></p></div>`;
    $("coForm").addEventListener("submit", (e) => { e.preventDefault(); S.researchSym = E.symKey($("coSym").value || "RELIANCE"); renderCompanyTab(box); });
    $("coAsk").addEventListener("click", () => { go(""); $("mainInput").value = `Give me a full equity research report on ${S.researchSym}: business, results trend, valuation vs history and peers, macro and sector drivers, catalysts, risks, and how you'd play it (stock, options or a systematic rule) with a backtest.`; autoGrow($("mainInput")); $("mainInput").focus(); });
    const d = await companyResearch(S.researchSym), cb = $("coBody");
    if (!cb) return;
    if (d.error) { cb.innerHTML = `<p class="flag">${esc(d.error)}</p>`; return; }
    const r = d.results, v = d.valuation || {}, pr = d.price || {}, pf = d.profile;
    const tiles = [["Price", px(pr.close), `1y ${pct(pr.ret_1y)} · vs 200d ${pct(pr.vs_sma200_pct)}`], ["Market cap", v.mcap_cr != null ? `₹${Math.round(v.mcap_cr).toLocaleString("en-IN")} cr` : "–", d.index_membership.join(" · ")],
      ["P/E (TTM)", v.pe_ttm ?? "–", v.pe_5y_percentile != null ? `${ord(v.pe_5y_percentile)} pct of 5y · median ${v.pe_5y_median}` : ""], ["Profit growth (TTM)", pct(r?.ttm.profit_growth_pct), `sales ${pct(r?.ttm.sales_growth_pct)} · 3y CAGR ${pct(r?.ttm.profit_cagr_3y_pct)}`],
      ["Industry median P/E", d.peers?.industry_medians.pe ?? "–", `profit growth ${pct(d.peers?.industry_medians.profit_growth_ttm)}`], ["Promoter", d.shareholding ? `${d.shareholding.promoter_pct_history.slice(-1)[0][1]}%` : "–", d.shareholding && d.shareholding.promoter_pct_history.length > 1 ? `was ${d.shareholding.promoter_pct_history[0][1]}% (${d.shareholding.promoter_pct_history[0][0]})` : ""]];
    cb.innerHTML = `<div class="stack"><div><h2>${esc(d.name || d.symbol)} <span class="small muted" style="font-family:var(--font-body);font-weight:400">${esc(d.symbol)} · ${esc(d.industry)}</span></h2>${pf?.business ? `<p class="small muted" style="margin-top:6px;max-width:90ch">${esc(pf.business)}</p>` : ""}</div>
      <div class="stats">${tiles.map(([k, val, b]) => `<div class="kpi"><span class="k">${k}</span><span class="v">${val}</span><span class="b">${esc(b)}</span></div>`).join("")}</div>
      ${r ? `<div class="card"><h2>Quarterly results <span class="small muted" style="font-family:var(--font-body);font-weight:400">${esc(r.basis)} · ₹ crore · as first filed with NSE</span></h2><div class="tablewrap"><table><thead><tr><th>Quarter</th><th>Filed</th><th class="r">Sales</th><th class="r">y/y</th><th class="r">EBITDA %</th><th class="r">Profit</th><th class="r">y/y</th><th class="r">Net %</th>${r.quarters[0]?.gnpa_pct !== undefined ? '<th class="r">GNPA %</th>' : ""}</tr></thead><tbody>
        ${r.quarters.map((q) => `<tr><td>${esc(q.quarter.slice(0, 7))}</td><td class="small muted">${esc(q.filed)}</td><td class="r">${q.sales_cr != null ? Math.round(q.sales_cr).toLocaleString("en-IN") : "–"}</td><td class="r ${cls(q.sales_yoy_pct)}">${pct(q.sales_yoy_pct, 0)}</td><td class="r">${q.ebitda_margin_pct ?? "–"}</td><td class="r ${cls(q.profit_cr)}">${q.profit_cr != null ? Math.round(q.profit_cr).toLocaleString("en-IN") : "–"}</td><td class="r ${cls(q.profit_yoy_pct)}">${pct(q.profit_yoy_pct, 0)}</td><td class="r">${q.net_margin_pct ?? "–"}</td>${q.gnpa_pct !== undefined ? `<td class="r">${q.gnpa_pct ?? "–"}</td>` : ""}</tr>`).join("")}</tbody></table></div></div>` : '<p class="muted">No filed results for this company yet.</p>'}
      <div class="grid2">
        ${d.peers ? `<div class="card"><h2>Largest peers</h2><div class="tablewrap"><table><thead><tr><th>Symbol</th><th class="r">Mcap (₹ cr)</th><th class="r">P/E</th><th class="r">Profit g.</th><th class="r">6m</th></tr></thead><tbody>${d.peers.largest.map((p) => `<tr${p.symbol === d.symbol ? ' style="font-weight:600"' : ""}><td>${esc(p.symbol)}</td><td class="r">${p.mcap_cr != null ? Math.round(p.mcap_cr).toLocaleString("en-IN") : "–"}</td><td class="r">${p.pe ?? "–"}</td><td class="r ${cls(p.profit_growth_ttm)}">${pct(p.profit_growth_ttm, 0)}</td><td class="r ${cls(p.ret_6m_pct)}">${pct(p.ret_6m_pct, 0)}</td></tr>`).join("")}</tbody></table></div></div>` : ""}
        <div class="card"><h2>Analysts, options, events</h2>${`<dl class="kv">${[
          pf?.analysts ? ["Consensus (Yahoo)", `${esc(pf.analysts.consensus || "")} · ${pf.analysts.count} analysts · target ${px(pf.analysts.target_mean)} (${px(pf.analysts.target_low)}–${px(pf.analysts.target_high)})`] : null,
          pf?.snapshot_ratios_yahoo?.roe_pct != null ? ["ROE · debt/equity", `${pf.snapshot_ratios_yahoo.roe_pct}% · ${pf.snapshot_ratios_yahoo.debt_to_equity ?? "–"}`] : null,
          d.options ? ["Options", `IV ${d.options.iv30_pct}% (${ord(d.options.iv_1y_percentile)} pct) · PCR ${d.options.put_call_oi}`] : null,
          d.price?.beta_1y_vs_nifty != null ? ["Beta to Nifty (1y)", d.price.beta_1y_vs_nifty] : null,
          ...(d.upcoming_events || []).map((e) => ["Board meeting " + e.date, esc(e.purpose)])].filter(Boolean).map(([k, x]) => `<dt>${k}</dt><dd>${x}</dd>`).join("")}</dl>`}</div></div>
      ${d.recent_filings || d.headlines ? `<div class="card"><h2>Filings and headlines</h2><ul class="newslist">${[...(d.recent_filings || []).map((x) => ({ t: x.time, a: "NSE", h: `${x.filing}${x.detail ? " — " + x.detail : ""}` })), ...(d.headlines || []).map((x) => ({ t: x.time, a: x.source, h: x.headline }))].sort((a, b) => b.t.localeCompare(a.t)).slice(0, 20).map((x) => `<li><span class="small muted">${esc(x.t)} · ${esc(x.a)}</span><br>${esc(x.h)}</li>`).join("")}</ul></div>` : ""}</div>`;
  }
  async function renderNewsTab(box) {
    const res = await loadResearch();
    const ev = (res.events?.items || []).filter((e) => /result/i.test(e.purpose)).slice(0, 60);
    box.innerHTML = `<div class="grid2"><div class="card"><h2>Headlines <span class="small muted" style="font-family:var(--font-body);font-weight:400">${esc(res.headlines?.asof || "")}</span></h2><ul class="newslist">${(res.headlines?.items || []).slice(0, 60).map((x) => `<li><span class="small muted">${esc(x.t)} · ${esc(x.src)}${(x.syms || []).length ? " · " + esc(x.syms.join(", ")) : ""}</span><br>${x.link ? `<a href="${esc(x.link)}" target="_blank" rel="noopener">${esc(x.title)}</a>` : esc(x.title)}</li>`).join("")}</ul></div>
      <div class="stack"><div class="card"><h2>Results calendar</h2><div class="tablewrap tall"><table><thead><tr><th>Date</th><th>Company</th><th>Purpose</th></tr></thead><tbody>${ev.map((e) => `<tr><td>${esc(e.date)}</td><td>${esc(e.sym)}</td><td class="small">${esc(e.purpose)}</td></tr>`).join("") || '<tr><td colspan="3" class="muted">None listed.</td></tr>'}</tbody></table></div></div>
      <div class="card"><h2>NSE filings</h2><ul class="newslist">${(res.filings?.items || []).filter((x) => !/^(Updates|General Updates|Disclosure under SEBI Takeover)/i.test(x.desc)).slice(0, 50).map((x) => `<li><span class="small muted">${esc(x.t)} · <b>${esc(x.sym)}</b></span><br>${esc(x.desc)}${x.text ? `<span class="small muted"> — ${esc(x.text.slice(0, 160))}</span>` : ""}</li>`).join("")}</ul></div></div></div>
      <p class="note">Headlines are titles from the publishers' RSS feeds; filings are NSE's own descriptions. Updated several times a day.</p>`;
  }
  // read-only hooks for testing the research tools from the browser console
  window.__tradeosResearch = { macroDashboard, companyResearch, screen: (a) => screenTool(a, null), sectorView, news: newsTool, brief: () => dataBrief() };
