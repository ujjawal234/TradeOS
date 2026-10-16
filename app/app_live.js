  // ================================================================ NOW: live prices, paper trades at live prices, agents deciding now
  // Prices come from NSE's own live data through the viewer's "cm-market" connector (stocks by first letter with
  // cm_get_equity_stocks or one by one with cm_get_stock_quote; every NSE index in one cm_get_live_indices call; NSE's
  // gainers/losers lists) and from the database snapshot live/quotes that the market-hours run writes (every NSE stock).
  // A quote counts once it is newer than the stored daily bars: lastPx, dayChg and retN then use it, so every page shows
  // prices as of now. Paper trades fill at the live price ± slippage with itemised Indian charges (lab/oms.js). Paper only.
  S.q = new Map(); S.qMeta = { at: 0, err: null, snapAsof: null }; S.movers = null;
  const LIVE_TAB = Math.random().toString(36).slice(2, 8);
  const mktMins = () => { const t = istNow(); return t.getUTCHours() * 60 + t.getUTCMinutes(); };
  const tradingDay = () => { const wd = istNow().getUTCDay(); return wd >= 1 && wd <= 5; };
  const marketOpenNow = () => tradingDay() && mktMins() >= 555 && mktMins() < 930;   // 09:15–15:30 IST
  const istClock = (iso) => iso ? new Date(Date.parse(iso) + 5.5 * 3600e3).toISOString().slice(11, 16) : "";
  function quoteNow(s) { const q = S.q && S.q.get(s); return q && q.date && q.date > (S.lastDay || "") ? q : null; }
  function putQuote(s, q) { if (!s || !q || !(q.ltp > 0) || !q.date) return; const o = S.q.get(s); if (o && o.stamp > q.stamp) return; S.q.set(s, q); rec1m(s, q); }
  // ---- today's 1-minute bars: every live price the page reads goes into a bar for its NSE time (minute after 09:15);
  // the db doc live_1m/<SYM> (written by the hourly market-hours run from the intraday runner's minute bars) fills the
  // day from 09:15, so the 1D chart shows today as it happens. Same rules as tradeos/live/minute_bars.py.
  S.t1m = new Map(); S.seed1m = new Map();
  const liveDocId = (sym) => String(sym).replace(/[^A-Za-z0-9_\-.:@+]/g, (c) => "~" + c.charCodeAt(0).toString(16).toUpperCase().padStart(2, "0"));
  function rec1m(s, q) {
    if (q.date !== todayIST()) return;
    const t = String(q.time || ""), mm = +t.slice(0, 2) * 60 + +t.slice(3, 5) - 555; if (!(mm >= 0 && mm < 375)) return;
    let r = S.t1m.get(s); if (!r || r.date !== q.date) S.t1m.set(s, (r = { date: q.date, bars: new Map(), prev: null }));
    const ltp = q.ltp, hi = q.high || 0, lo = q.low || 0, vol = q.volume || 0, p = r.prev;
    let b = r.bars.get(mm); if (!b) r.bars.set(mm, (b = [ltp, ltp, ltp, ltp, 0]));
    b[1] = Math.max(b[1], ltp); b[2] = Math.min(b[2], ltp); b[3] = ltp;
    if (p) { if (hi > 0 && p[0] > 0 && hi > p[0]) b[1] = Math.max(b[1], hi); if (lo > 0 && p[1] > 0 && lo < p[1]) b[2] = Math.min(b[2], lo); if (vol > p[2]) b[4] += vol - p[2]; }
    r.prev = [hi || (p ? p[0] : 0), lo || (p ? p[1] : 0), Math.max(vol, p ? p[2] : 0)];
  }
  // the stored part of today (db live_1m/<SYM>), read again when it's over 3 minutes old
  async function seed1m(sym) {
    const c = S.seed1m.get(sym); if (c && Date.now() - c.at < 180e3) return c.doc;
    let doc = null; try { const snap = await S.db.doc(`live_1m/${liveDocId(sym)}`).get(); doc = snap.exists ? snap.data() : null; } catch (e) { doc = c?.doc || null; }
    S.seed1m.set(sym, { at: Date.now(), doc }); return doc;
  }
  // today's bars for the chart: the stored minutes, then the page's own live minutes after them (or where the store has none)
  function today1m(sym, doc) {
    const day = todayIST(), dn = E.dayOf(day), m = new Map();
    if (doc && doc.date === day && Array.isArray(doc.m)) doc.m.forEach((k, i) => { if (doc.c[i] > 0) m.set(k, [doc.o[i], doc.h[i], doc.l[i], doc.c[i], doc.v?.[i] ?? NaN]); });
    const last = m.size ? Math.max(...m.keys()) : -1, r = S.t1m.get(sym);
    if (r && r.date === day) for (const [k, b] of r.bars) if (k > last || !m.has(k)) m.set(k, b.slice());
    return [...m.keys()].sort((a, b) => a - b).map((k) => { const b = m.get(k); return { d: dn, k, min: k, o: b[0], h: b[1], l: b[2], c: b[3], v: b[4] > 0 ? b[4] : NaN }; });
  }
  const todayLive = () => tradingDay() && mktMins() >= 555;   // today has (or will soon have) bars
  const qOf = (ltp, prev, open, high, low, date, time, src, extra = {}) => ({ ltp: +ltp, prev: prev > 0 ? +prev : null, open: open > 0 ? +open : null, high: high > 0 ? +high : null, low: low > 0 ? +low : null, date, time: time || "", stamp: `${date} ${time || ""}`, src, ...extra });
  // the newest quote time on screen, e.g. "14:07"
  function liveAsOf() { let best = ""; for (const q of S.q.values()) if (q.date > (S.lastDay || "") && q.stamp > best) best = q.stamp; return best ? { date: best.slice(0, 10), time: best.slice(11, 16) } : null; }
  const anyLive = () => !!liveAsOf();
  function liveLabel() { const a = liveAsOf(); if (!a) return `close of ${fmtDate(S.lastDay)}`; return `${marketOpenNow() ? "live" : "last traded"} ${a.time} IST${a.date !== todayIST() ? ` ${fmtDate(a.date)}` : ""}`; }

  // ---------------------------------------------------------------- fetching
  async function poolRun(items, n, fn) { let i = 0; const run = async () => { while (i < items.length) { const x = items[i++]; await fn(x); } }; await Promise.all(Array.from({ length: Math.min(n, items.length) }, run)); }
  function stockQuote(r) { const [d, t] = String(r.latestTimestamp || "").split(" "); return qOf(r.lastTradedPrice, r.preClosePrice, r.openPrice, r.highPrice, r.lowPrice, d, t, "NSE", { chg_pct: r.perChange, value_cr: r.value, volume: r.volume }); }
  async function fetchIndexQuotes() {
    const t = await nseIndexTable(), ts = nseIsoTs(t.ts) || "";
    for (const [s, m] of Object.entries(S.man.symbols)) {
      if (m.kind !== "index") continue;
      const r = nseIndexRow(s, t); if (!r || r.last == null) continue;
      const at = nseIsoTs(r.timeVal) || ts; putQuote(s, qOf(r.last, r.previousClose, r.open, r.high, r.low, at.slice(0, 10), at.slice(11), "NSE", { chg_pct: r.percChange }));
    }
  }
  // stocks: a first letter with 4+ wanted names is one call (up to 500 rows); the rest, and anything a letter call missed, one by one
  async function fetchStockQuotes(syms) {
    const want = [...new Set(syms)].filter((s) => S.man.symbols[s]?.kind === "stock" && S.man.symbols[s]?.ex !== "BSE");
    const by = {}; for (const s of want) (by[s[0]] ||= []).push(s);
    const letters = Object.keys(by).filter((k) => by[k].length >= 4), single = Object.keys(by).filter((k) => by[k].length < 4).flatMap((k) => by[k]), left = [];
    await poolRun(letters, 4, async (L) => {
      const p = await nseCall("cm_get_equity_stocks", { limit: 500, symbolFilter: L }), got = new Set(), mine = new Set(by[L]);
      for (const r of p?.stocks || []) if (mine.has(r.symbol)) { putQuote(r.symbol, stockQuote(r)); got.add(r.symbol); }
      for (const s of by[L]) if (!got.has(s)) left.push(s);
    });
    await poolRun([...single, ...left], 6, async (s) => {
      try { const p = await nseCall("cm_get_stock_quote", { symbol: s }); if (p?.stock) putQuote(s, stockQuote(p.stock)); }
      catch (e) { if (e?.code !== "nse_error") throw e; }
    });
  }
  async function fetchMovers() {
    const [g, l] = await Promise.all([nseCall("cm_get_live_market_data", { index: "gainers" }), nseCall("cm_get_live_market_data", { index: "loosers" })]);
    const rows = (p) => { const m = new Map(); for (const [grp, v] of Object.entries(p?.data || {})) for (const r of v?.data || []) if (!m.has(r.symbol)) m.set(r.symbol, { ...r, grp, ts: v.timestamp }); return [...m.values()]; };
    const up = rows(g), down = rows(l);
    for (const r of [...up, ...down]) { const at = nseIsoTs(r.ts) || ""; if (S.man.symbols[r.symbol]) putQuote(r.symbol, qOf(r.ltp, r.prev_price, r.open_price, r.high_price, r.low_price, at.slice(0, 10), at.slice(11), "NSE", { chg_pct: r.perChange })); }
    S.movers = { up, down, at: Date.now() };
  }
  // prices for these symbols, fetched now (used before trading and when an agent decides): returns {ok, missing, error}
  async function quotesFor(syms, progress) {
    syms = [...new Set(syms)].filter((s) => S.man.symbols[s]);
    if (!S.mcp) return { ok: [], missing: syms, error: "Live prices need the cm-market connector, which isn't available in this view." };
    const idx = syms.filter((s) => S.man.symbols[s].kind === "index"), stk = syms.filter((s) => S.man.symbols[s].kind === "stock");
    progress && progress(`Reading live NSE prices for ${syms.length} symbol${syms.length > 1 ? "s" : ""}…`);
    let error = null;
    try { await Promise.all([idx.length ? fetchIndexQuotes() : null, stk.length ? fetchStockQuotes(stk) : null]); }
    catch (e) { error = nseHint(e?.code) ? `NSE live data is off: ${nseHint(e.code)}.` : `Couldn't read live prices: ${e?.message || e?.code || e}`; }
    const ok = syms.filter((s) => quoteNow(s)), missing = syms.filter((s) => !quoteNow(s));
    return { ok, missing, error };
  }
  // the database snapshot of every NSE stock (written by the market-hours run)
  function ingestSnapshot(doc) {
    if (!doc || !doc.date || !doc.quotes) return;
    const t = String(doc.asof || "").slice(11, 19);
    for (const [s, v] of Object.entries(doc.quotes)) putQuote(s, qOf(v[0], v[4], v[1], v[2], v[3], doc.date, (v[6] || t) + (String(v[6] || "").length === 5 ? ":00" : ""), "NSE snapshot", { value_cr: v[5] }));
    for (const [s, v] of Object.entries(doc.indices || {})) putQuote(s, qOf(v[0], v[4], v[1], v[2], v[3], doc.date, (v[6] || t) + (String(v[6] || "").length === 5 ? ":00" : ""), "snapshot"));
    const nx = {}; for (const [n, v] of Object.entries(doc.nse_indices || {})) nx[E.nseNorm(n)] = v;
    if (Object.keys(nx).length) for (const [s, m] of Object.entries(S.man.symbols)) { if (m.kind !== "index") continue; const v = E.nseIndexRow(s, nx, S.man.symbols); if (v) putQuote(s, qOf(v[0], v[4], v[1], v[2], v[3], doc.date, (v[6] || t) + ":00", "NSE snapshot")); }
    S.qMeta.snapAsof = doc.asof || null;
  }

  // ---------------------------------------------------------------- the refresh loop
  function interestSyms() {
    const out = new Set(["NIFTY", "BANKNIFTY", "INDIAVIX"]);
    for (const sl of Object.values(S.bookState?.sleeves || {})) for (const s of Object.keys(sl.positions || {})) out.add(s);
    try { for (const s of watchList()) out.add(s); } catch (e) { /* not ready */ }
    for (const o of S.ordersList || []) if (o.status === "pending" || o.status === "approved") out.add(o.sym);
    if (S.view === "symbol" && S.symView) out.add(S.symView);
    if (S.view === "markets") for (const s of S.man.universes.nifty50 || []) out.add(s);
    for (const s of S.liveExtra || []) out.add(s);
    return [...out].filter((s) => S.man.symbols[s]);
  }
  let liveBusy = false;
  async function liveTick(force) {
    if (liveBusy || !S.man || !S.mcp || (document.hidden && !force)) return;
    const open = marketOpenNow(), m = mktMins(), todaysClose = tradingDay() && m >= 930 && (S.lastDay || "") < todayIST();
    if (!open && !todaysClose) return;                                     // nothing newer than the daily bars
    if (!open && !force && S.qMeta.at && Date.now() - S.qMeta.at < 15 * 60e3) return; // after the close: every 15 minutes is plenty
    liveBusy = true;
    try {
      const syms = interestSyms(), wantMovers = (S.view === "home" || S.view === "markets") && Date.now() - (S.movers?.at || 0) > 4 * 60e3;
      await Promise.all([fetchIndexQuotes(), fetchStockQuotes(syms.filter((s) => S.man.symbols[s].kind === "stock")), wantMovers ? fetchMovers() : null]);
      S.qMeta.at = Date.now(); S.qMeta.err = null;
    } catch (e) { S.qMeta.err = nseHint(e?.code) || e?.message || String(e); }
    finally { liveBusy = false; }
    liveChanged();
  }
  function liveChanged() {
    renderTicker(); renderLiveChip();
    const typing = /INPUT|TEXTAREA|SELECT/.test(document.activeElement?.tagName || ""), sheet = [...document.querySelectorAll(".sheet")].some((x) => !x.hidden);
    if (typing || sheet || !$("palette").hidden) return;
    const v = S.view;
    if (v === "home") renderHome(); else if (v === "markets") renderMarkets(); else if (v === "book") renderBook(); else if (v === "orders") renderOrders(); else if (v === "desks") renderDesks();
    else if (v === "symbol") { updateSymLive(); if (S.symRange === "1D" && S.symDay === 0 || S.symRange === "1W") redrawToday(); }
  }
  function renderLiveChip() {
    const el = $("dataChip"), dot = $("dataStat")?.querySelector(".dot"); if (!el) return;
    const a = liveAsOf(), open = marketOpenNow();
    if (a && open) { el.textContent = `Live NSE · ${a.time} IST`; dot?.classList.remove("stale", "off"); }
    else if (a) { el.textContent = `Market closed · last traded ${a.time} IST`; dot?.classList.add("stale"); }
    else if (S.qMeta.err && open) { el.textContent = `Live prices off · close of ${fmtDate(S.lastDay)}`; dot?.classList.add("stale"); el.title = S.qMeta.err; }
  }
  function startLive() {
    try { S.db.doc("live/quotes").onSnapshot((snap) => { if (snap.exists) { ingestSnapshot(snap.data()); liveChanged(); } }, () => { /* none yet */ }); } catch (e) { /* optional */ }
    setInterval(() => liveTick(false), 60e3);
    document.addEventListener("visibilitychange", () => { if (!document.hidden) liveTick(false); });
    liveTick(true);
  }

  // ---------------------------------------------------------------- the book, changed safely from the page
  // A short lease on book/lock keeps two tabs (or two people) from writing the book at the same moment; the market-hours run
  // writes with a version check and re-runs if the page changed the book meanwhile.
  async function withBook(fn) {
    const lock = S.db.doc("book/lock");
    if (typeof lock.acquire === "function") {
      let got = null;
      for (let i = 0; i < 4 && !(got && got.acquired); i++) { got = await lock.acquire({ holder: `${S.uid || "anon"}:${LIVE_TAB}`, ttlMs: 20000 }).catch(() => ({ acquired: true })); if (!got.acquired) await new Promise((r) => setTimeout(r, 1200)); }
      if (!got.acquired) throw new Error("Someone else is recording trades right now — try again in a few seconds.");
    }
    const snap = await S.db.doc("book/state").get(), st = snap.exists ? JSON.parse(JSON.stringify(snap.data())) : O.emptyState(0, todayIST());
    delete st.id;
    const events = O.syncSleeves(st, [...S.desks.values()], [...S.agents.values()], todayIST());
    const out = await fn(st, events);
    st.updated_at = nowIso(); st.marked = { at: nowIso(), by: "the app", prices: "NSE live" };
    await S.db.doc("book/state").set(st);
    S.bookState = st; fundChanged("book");
    return out;
  }
  const hhmm = () => istNow().toISOString().slice(11, 16).replace(":", "");
  const tradeId = (sleeve, sym) => `${todayIST()}T${hhmm()}_${sleeve}_${sym}_${Math.random().toString(36).slice(2, 5)}`.replace(/[^A-Za-z0-9_\-.~:@+]/g, "-");
  function freshQuote(sym) {
    const q = quoteNow(sym); if (!q) return null;
    if (q.date !== todayIST()) return null;
    const t = q.time ? Date.parse(`${q.date}T${q.time.length === 5 ? q.time + ":00" : q.time}+05:30`) : 0;
    return Date.now() - t <= 15 * 60e3 ? q : null;  // within 15 minutes
  }
  function closedMsg() { const m = mktMins(); return !tradingDay() ? "The market is closed today. Paper orders fill at live NSE prices on trading days, 09:15–15:30 IST." : m < 555 ? "The market opens at 09:15 IST. Paper orders fill at live NSE prices from then." : "The market closed at 15:30 IST. Paper orders fill at live NSE prices on the next trading day, 09:15–15:30."; }

  // One paper trade NOW at the live price: BUY or SELL `qty` of `sym` in a sleeve (an agent's, or a desk's manual sleeve).
  async function tradeNow({ sym, side, qty, sleeve, desk, reason, note }) {
    if (fundRO()) throw new Error("You have view-only access.");
    if (!marketOpenNow()) throw new Error(closedMsg());
    sym = E.symKey(sym); qty = Number(qty);
    if (!S.man.symbols[sym]) throw new Error(`No data for ${sym}.`);
    if (!(qty > 0)) throw new Error("Enter a quantity.");
    if (S.man.symbols[sym].kind === "stock" && Math.floor(qty) !== qty) throw new Error("Stocks trade in whole shares.");
    await quotesFor([sym]);
    const q = freshQuote(sym); if (!q) throw new Error(`No live NSE price for ${sym} right now${S.man.symbols[sym].ex === "BSE" ? " (BSE-only stocks have no NSE live price)" : ""}. Try again in a minute.`);
    return withBook(async (st) => {
      let sid = sleeve;
      if (!sid || sid === "manual") { const d = S.desks.get(desk); if (!d) throw new Error("Choose a desk."); sid = O.manualSleeve(st, d, [...S.agents.values()], todayIST()); }
      const sl = st.sleeves[sid]; if (!sl) throw new Error("That sleeve isn't open (the agent needs a desk and an allocation).");
      const have = sl.positions?.[sym]?.qty || 0;
      if (side === "SELL" && qty > have + 1e-9) throw new Error(`Only ${have.toLocaleString("en-IN")} ${sym} held in ${sl.name || "this sleeve"} — paper trading here doesn't sell short.`);
      if (side === "BUY") { const need = qty * q.ltp * (1 + O.SLIP_PCT / 100) * 1.0013; if (need > sl.cash + 1) throw new Error(`Not enough cash in ${sl.name || "the sleeve"}: ${inr(sl.cash)} available, ${inr(need)} needed.${O.isManual(sid) ? " Manual trades use the desk's capital not allocated to agents — lower an allocation or the desk capital to free some." : ""}`); }
      const at = nowIso(), f = O.applyFill(st, sid, sym, side, qty, q.ltp, { meta: S.man.symbols, at, date: todayIST() });
      const id = tradeId(sid, sym), o = { date: todayIST(), session: todayIST(), desk: sl.desk, agent: sid, sym, side, qty, price: q.ltp, value: Math.round(qty * q.ltp), from_qty: have, to_qty: f.pos_after,
        reason: reason || "manual trade", note: note || null, checks: [], status: "filled", auto: false, created_at: at, created_by: S.uid, decided_by: S.uid, decided_at: at, live_ts: `${q.date} ${q.time}`, live_src: q.src, ...f };
      await S.db.doc(`orders/${id}`).set(o);
      return { id, ...o };
    });
  }
  // Approve pending orders: during the session they fill at once at the live price; outside it they fill at the next live run.
  async function approveNow(orders, qtyOf) {
    const open = marketOpenNow(), out = { filled: [], approved: 0, failed: [] };
    if (!open) {
      for (const o of orders) { const qty = qtyOf(o); await S.db.doc(`orders/${o.id}`).update({ status: qty > 0 ? "approved" : "rejected", ...(qty > 0 && qty !== o.qty ? { qty, value: Math.round(qty * o.price), note: `quantity changed from ${o.qty}` } : {}), decided_by: S.uid, decided_at: nowIso() }); out.approved++; }
      return out;
    }
    await quotesFor(orders.map((o) => o.sym));
    await withBook(async (st) => {
      for (const o of orders) {
        const qty = qtyOf(o), q = freshQuote(o.sym);
        if (!(qty > 0)) { await S.db.doc(`orders/${o.id}`).update({ status: "rejected", decided_by: S.uid, decided_at: nowIso() }); continue; }
        if (!q || !st.sleeves[o.agent]) { await S.db.doc(`orders/${o.id}`).update({ status: "approved", decided_by: S.uid, decided_at: nowIso(), ...(qty !== o.qty ? { qty } : {}) }); out.failed.push(o.sym); out.approved++; continue; }
        const at = nowIso(), f = O.applyFill(st, o.agent, o.sym, o.side, qty, q.ltp, { meta: S.man.symbols, at, date: todayIST() });
        await S.db.doc(`orders/${o.id}`).update({ status: "filled", qty, value: Math.round(qty * q.ltp), ...(qty !== o.qty ? { note: `quantity changed from ${o.qty}` } : {}), decided_by: S.uid, decided_at: at, live_ts: `${q.date} ${q.time}`, live_src: q.src, ...f });
        out.filled.push({ ...o, qty, ...f });
      }
    });
    return out;
  }

  // ---------------------------------------------------------------- agents decide NOW on live prices
  // For each paper agent with a sleeve: its rules run with today's live quote appended as the latest bar, its target book is
  // sized inside the desk's limits, and the orders fill at once at the live price (manual desks' orders wait for approval).
  async function agentNowPlan(a, sl, progress) {
    const vs = await S.db.doc(`agents/${a.id}/versions/${verId(a.paper?.version || a.version)}`).get(); if (!vs.exists) throw new Error("its paper version is missing");
    const v = vs.data(), spec = E.normalize(v.spec, S.man.universes), tday = E.dayOf(todayIST());
    let frames, list = [], held = {};
    if (spec.type === "watchlist") {
      list = E.watchLive(a.inbox_log || [], Array.from(S.light.NIFTY?.d || []).filter((d) => d < tday), spec.list_days, true);
      for (const [s, p] of Object.entries(sl.positions || {})) if (p.qty) held[s] = { qty: p.qty, avg: p.avg, since: p.since || todayIST() };
      frames = await framesFor(spec, null, [...list, ...Object.keys(held)]);
    } else frames = await framesFor(spec);
    const need = Object.keys(frames).filter((s) => ["stock", "index"].includes(S.man.symbols[s]?.kind));
    const qr = await quotesFor(need, progress); if (qr.error && !qr.ok.length) throw new Error(qr.error);
    const L = E.withLiveBars(frames, (s) => { const q = freshQuote(s); return q ? { ltp: q.ltp, open: q.open, high: q.high, low: q.low, value_cr: q.value_cr, volume: q.volume } : null; }, tday);
    const res = spec.type === "watchlist" ? { watch: E.watchSignals(spec, L.frames, { list, held, over: a.auto_learn && a.learned?.params ? a.learned.params : null }) }
      : E.run(spec, L.frames, S.man.universes, { start: v.test?.start || "2012-01-01" });
    let nx = tday + 1; while (((new Date(nx * 864e5).getUTCDay() + 6) % 7) > 4) nx++;
    return { spec, res, live: L.live, of: need.length, missing: qr.missing, nextSession: E.isoOf(nx) };
  }
  async function runAgentsNow(ids, progress = () => {}) {
    if (fundRO()) throw new Error("You have view-only access.");
    if (!marketOpenNow()) throw new Error(closedMsg());
    const kill = !!S.bookCfg?.kill_switch, flatten = kill || [...S.desks.values()].some((d) => d.status === "halted") || Object.values(S.bookState?.sleeves || {}).some((sl) => sl.closing && Object.keys(sl.positions || {}).length);
    const agents = kill ? [] : [...S.agents.values()].filter((a) => a.status === "paper" && O.OMS_TYPES.has(a.type) && (!ids || ids.includes(a.id)) && S.bookState?.sleeves?.[a.id] && !S.bookState.sleeves[a.id].closing);
    if (!agents.length && !flatten) throw new Error(ids ? "This agent has no open sleeve: put it on a desk with an allocation and start paper trading." : "No paper-trading agent has a sleeve yet: put agents on desks with allocations.");
    const plans = {}, notes = [];
    for (const a of agents) {
      progress(`${a.name}: deciding on live prices…`);
      try { const sl = S.bookState.sleeves[a.id], P = await agentNowPlan(a, sl, (t) => progress(`${a.name}: ${t}`)); plans[a.id] = { P, a }; notes.push(`${a.name}: decided on ${P.live} of ${P.of} live prices${P.missing.length ? ` (no live price for ${P.missing.slice(0, 4).join(", ")}${P.missing.length > 4 ? "…" : ""}; last close used)` : ""}`); }
      catch (e) { notes.push(`${a.name}: ${e.message || e}`); }
    }
    progress("Sizing orders inside the desks' limits and filling them at live prices…");
    const result = await withBook(async (st, events) => {
      const px = (s) => freshQuote(s)?.ltp ?? lastPx(s), tg = {};
      for (const [id, { P, a }] of Object.entries(plans)) tg[id] = O.agentTargets(a, P.spec, P.res, O.sleeveEquity(st.sleeves[id], px), px, S.man.symbols, P.nextSession);
      const nextSession = Object.values(plans)[0]?.P.nextSession || nextSessionIso(), stamp = `${todayIST()}T${hhmm()}`;
      const built = O.buildOrders({ state: st, book: S.bookCfg || {}, desks: [...S.desks.values()], agents: [...S.agents.values()], plans: tg, px, meta: S.man.symbols, date: todayIST(), nextSession, stamp });
      const at = nowIso(), mine = built.orders.filter((o) => !ids || ids.includes(o.agent) || ["desk halted", "agent left the desk"].includes(o.reason));
      const existing = new Set(S.ordersList.map((o) => o.id)), out = { fills: [], pending: [], blocked: [], waiting: [], notes, events: [...events, ...built.events] };
      for (const o of mine) {
        if (existing.has(o.id)) continue;
        const doc = { ...o, decided_at: at, decided_on: "live prices", created_by: S.uid };
        if (o.status === "approved") {
          const q = freshQuote(o.sym);
          if (q) { const f = O.applyFill(st, o.agent, o.sym, o.side, o.qty, q.ltp, { meta: S.man.symbols, at, date: todayIST() }); Object.assign(doc, { status: "filled", live_ts: `${q.date} ${q.time}`, live_src: q.src }, f); out.fills.push(doc); }
          else out.waiting.push(doc);
        } else if (o.status === "pending") out.pending.push(doc); else out.blocked.push(doc);
        await S.db.doc(`orders/${o.id}`).set(doc);
      }
      const newIds = mine.filter((o) => !existing.has(o.id));
      for (const u of O.supersede(S.ordersList, newIds, at)) await S.db.doc(`orders/${u.id}`).update({ status: u.status, note: u.note }).catch(() => null);
      for (const [id, u] of Object.entries(built.deskUpdates)) await S.db.doc(`desks/${id}`).update(u).catch(() => null);
      if (built.kill && !S.bookCfg?.kill_switch) await S.db.doc("book/config").set({ ...(S.bookCfg || {}), kill_switch: true, kill_reason: `book drawdown ${built.bookDD.toFixed(1)}%`, kill_at: todayIST() });
      st.last_live_run = at;
      return out;
    });
    return result;
  }

  // ---------------------------------------------------------------- UI: the trade ticket and the "run agents now" sheet
  function sleeveOptions(sym) {
    const st = S.bookState || { sleeves: {} }, opts = [];
    for (const d of [...S.desks.values()].filter((x) => (x.status || "active") === "active")) {
      const idle = O.idleCapital(d, [...S.agents.values()]), msl = st.sleeves["manual_" + d.id];
      opts.push({ v: `manual:${d.id}`, label: `${d.name} — manual trades (cash ${inrShort(msl ? msl.cash : idle)})`, held: msl?.positions?.[sym]?.qty || 0 });
    }
    for (const [id, sl] of Object.entries(st.sleeves || {})) if (!O.isManual(id) && sl.oms && !sl.closing) opts.push({ v: id, label: `${sl.name || agentName(id)} (${deskName(sl.desk)}, cash ${inrShort(sl.cash)})`, held: sl.positions?.[sym]?.qty || 0 });
    return opts;
  }
  function chargesRows(f) {
    const c = f.charges; if (!c) return `<tr><td>Costs</td><td class="r">${inr(f.fee)}</td></tr>`;
    return [["Slippage (in the fill price)", f.slippage], ["STT", c.stt], ["Exchange fees", c.exchange], ["SEBI fee", c.sebi], ["Stamp duty", c.stamp], ["GST", c.gst], ["DP charge", c.dp], ["Brokerage", c.brokerage]].filter(([, x]) => x).map(([k, x]) => `<tr><td>${k}</td><td class="r">₹${Number(x).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</td></tr>`).join("");
  }
  function openTradeTicket(sym, side = "BUY", opts = {}) {
    const sh = $("tradeSheet"), body = $("tradeBody"); sym = sym ? E.symKey(sym) : "";
    const held = opts.sleeve ? (S.bookState?.sleeves?.[opts.sleeve]?.positions?.[sym]?.qty || 0) : 0;
    const sOpts = sleeveOptions(sym), def = opts.sleeve || (sOpts.find((o) => o.held && side === "SELL")?.v) || sOpts[0]?.v || "";
    body.innerHTML = `<div class="seg" role="group" aria-label="Side" id="ttSide"><button type="button" data-side="BUY" aria-pressed="${side === "BUY"}">Buy</button><button type="button" data-side="SELL" aria-pressed="${side === "SELL"}">Sell</button></div>
      <div class="field"><label for="ttSym">Symbol</label><input class="input" id="ttSym" list="ttSyms" value="${esc(sym)}" placeholder="RELIANCE" autocomplete="off"><datalist id="ttSyms">${Object.entries(S.man.symbols).filter(([, v]) => ["stock", "index"].includes(v.kind) && !v.alias_of && v.ex !== "BSE").slice(0, 4000).map(([s, v]) => `<option value="${esc(s)}">${esc(v.name || "")}</option>`).join("")}</datalist></div>
      <div class="field"><label for="ttSleeve">From</label><select class="input" id="ttSleeve">${sOpts.map((o) => `<option value="${esc(o.v)}" ${o.v === def ? "selected" : ""}>${esc(o.label)}${o.held ? ` · holds ${o.held.toLocaleString("en-IN")}` : ""}</option>`).join("") || '<option value="">Create a desk first</option>'}</select></div>
      <div class="grid2" style="gap:10px"><div class="field"><label for="ttQty">Quantity</label><input class="input" id="ttQty" type="number" min="0" step="1" value="${held && side === "SELL" ? held : ""}" inputmode="numeric"></div><div class="field"><label for="ttAmt">or amount (₹)</label><input class="input" id="ttAmt" type="number" min="0" step="1000" inputmode="numeric"></div></div>
      <div id="ttQuote" class="card" style="padding:12px"><p class="muted small">Pick a symbol to see its live price.</p></div>
      <div class="row"><button class="btn up" type="button" id="ttGo" disabled>Place paper order</button><span class="status" id="ttStatus"></span></div>
      <p class="xs muted">Paper only — nothing goes to a broker. Fills at the live NSE price (1–3 min behind) plus ${O.SLIP_PCT}% slippage, with STT, exchange, SEBI, stamp duty, GST and DP charges as an Indian discount broker charges them.</p>`;
    sh.hidden = false;
    let curSide = side, q = null;
    const est = () => {
      const s = E.symKey($("ttSym").value || ""), qty = Number($("ttQty").value) || 0, box = $("ttQuote"), go = $("ttGo");
      $("ttTitle").textContent = `${curSide === "BUY" ? "Buy" : "Sell"} ${s || ""} now`.trim();
      go.className = `btn ${curSide === "BUY" ? "up" : "danger solid"}`; go.textContent = `${curSide === "BUY" ? "Buy" : "Sell"} now at the live price`;
      q = s ? quoteNow(s) : null;
      if (!s || !S.man.symbols[s]) { box.innerHTML = '<p class="muted small">Pick a symbol to see its live price.</p>'; go.disabled = true; return; }
      const ref = q?.ltp ?? lastPx(s), buy = curSide === "BUY", fpx = ref * (1 + (buy ? 1 : -1) * O.SLIP_PCT / 100), value = qty * fpx, ch = O.charges(buy, value, O.productOf(S.man.symbols, s));
      box.innerHTML = `<div class="row" style="justify-content:space-between"><span><b>${esc(s)}</b> <span class="muted small">${esc(nameOfSym(s))}</span></span><span><b>${px(ref)}</b> <span class="${cls(q ? (q.prev ? (q.ltp / q.prev - 1) * 100 : q.chg_pct) : dayChg(s))}">${pct(q ? (q.prev ? (q.ltp / q.prev - 1) * 100 : q.chg_pct) : dayChg(s), 2)}</span></span></div>
        <p class="xs muted">${q ? `NSE ${marketOpenNow() ? "live" : "last traded"} ${esc(q.time.slice(0, 5))} IST${q.date !== todayIST() ? " · " + fmtDate(q.date) : ""}` : `close of ${fmtDate(S.lastDay)} — fetching the live price…`}</p>
        ${qty > 0 ? `<div class="tablewrap" style="margin-top:8px"><table><tbody><tr><td>${qty.toLocaleString("en-IN")} × ${px(fpx)} (with slippage)</td><td class="r">${inr(value)}</td></tr>${chargesRows({ charges: ch, slippage: Math.abs(fpx - ref) * qty })}<tr><td><b>${buy ? "You pay" : "You receive"}</b></td><td class="r"><b>${inr(buy ? value + ch.total : value - ch.total)}</b></td></tr></tbody></table></div>` : ""}
        ${marketOpenNow() ? "" : `<p class="flag" style="margin-top:8px">${esc(closedMsg())}</p>`}`;
      go.disabled = !(qty > 0) || !marketOpenNow() || fundRO() || !$("ttSleeve").value;
    };
    const refetch = async () => { const s = E.symKey($("ttSym").value || ""); if (!S.man.symbols[s]) return est(); est(); await quotesFor([s]); est(); };
    $("ttSide").addEventListener("click", (e) => { const b = e.target.closest("[data-side]"); if (!b) return; curSide = b.dataset.side; $("ttSide").querySelectorAll("button").forEach((x) => x.setAttribute("aria-pressed", String(x === b))); est(); });
    $("ttSym").addEventListener("change", refetch);
    $("ttQty").addEventListener("input", () => { $("ttAmt").value = ""; est(); });
    $("ttAmt").addEventListener("input", () => { const s = E.symKey($("ttSym").value || ""), p = quoteNow(s)?.ltp ?? lastPx(s), a = Number($("ttAmt").value) || 0; if (p > 0) $("ttQty").value = S.man.symbols[s]?.kind === "stock" ? Math.floor(a / p) : (a / p).toFixed(2); est(); });
    $("ttSleeve").addEventListener("change", est);
    $("ttGo").addEventListener("click", async () => {
      const st = $("ttStatus"), go = $("ttGo"), sv = $("ttSleeve").value; go.disabled = true; st.classList.remove("err"); st.textContent = "Filling at the live price…";
      try {
        const r = await tradeNow({ sym: $("ttSym").value, side: curSide, qty: Number($("ttQty").value), sleeve: sv.startsWith("manual:") ? "manual" : sv, desk: sv.startsWith("manual:") ? sv.slice(7) : null, reason: opts.reason || "manual trade" });
        body.innerHTML = `<div class="flag ok"><b>${r.side === "BUY" ? "Bought" : "Sold"} ${r.qty.toLocaleString("en-IN")} ${esc(r.sym)} at ${px(r.fill_price)}</b> (live ${px(r.ref_price)} at ${esc(String(r.live_ts).slice(11, 16))} IST)</div>
          <div class="tablewrap"><table><tbody><tr><td>Value</td><td class="r">${inr(r.gross_value)}</td></tr>${chargesRows(r)}<tr><td><b>Charges</b></td><td class="r"><b>${inr(r.fee)}</b></td></tr><tr><td><b>Net ${r.net_amount < 0 ? "paid" : "received"}</b></td><td class="r"><b>${inr(Math.abs(r.net_amount))}</b></td></tr>${r.realized ? `<tr><td>Realised P&amp;L (after charges)</td><td class="r ${cls(r.net_realized)}">${inr(r.net_realized)}</td></tr>` : ""}</tbody></table></div>
          <div class="row"><button class="btn ghost" type="button" data-go="orders" data-close-sheet>See every trade</button><button class="btn ghost" type="button" data-close-sheet>Done</button></div>`;
        wireGo(body); toast(`${r.side === "BUY" ? "Bought" : "Sold"} ${r.qty} ${r.sym} at ${px(r.fill_price)}`);
      } catch (e) { st.classList.add("err"); st.textContent = e.message || String(e); go.disabled = false; }
    });
    est(); if (sym) refetch(); setTimeout(() => (sym ? $("ttQty") : $("ttSym")).focus({ preventScroll: true }), 30);
  }
  async function openRunAgents(ids) {
    const sh = $("tradeSheet"), body = $("tradeBody");
    $("ttTitle").textContent = ids && ids.length === 1 ? `${agentName(ids[0])}: decide and trade now` : "Run every agent now";
    sh.hidden = false;
    if (!marketOpenNow()) { body.innerHTML = `<p class="flag">${esc(closedMsg())}</p><p class="small muted">During the session (09:15–15:30 IST) the runner checks every paper agent about once a minute on its own.</p><button class="btn ghost" type="button" data-close-sheet>Close</button>`; return; }
    body.innerHTML = '<p class="thinking" id="raProg">Starting<span class="dots"></span></p>';
    try {
      const r = await runAgentsNow(ids, (t) => { const el = $("raProg"); if (el) el.innerHTML = `${esc(t)}<span class="dots"></span>`; });
      const row = (o) => `<tr><td><span class="side-tag ${esc(o.side)}">${esc(o.side)}</span></td><td><b>${esc(o.sym)}</b><span class="sub">${esc(agentName(o.agent))}</span></td><td class="r">${Number(o.qty).toLocaleString("en-IN")}</td><td class="r">${px(o.fill_price ?? o.price)}</td><td class="r">${inr(o.fee)}</td></tr>`;
      body.innerHTML = `${r.fills.length ? `<div class="flag ok"><b>${r.fills.length} paper trade${r.fills.length > 1 ? "s" : ""} filled at live prices</b> · traded ${inr(r.fills.reduce((t, f) => t + f.gross_value, 0))} · charges ${inr(r.fills.reduce((t, f) => t + f.fee, 0))}</div>
          <div class="tablewrap"><table><thead><tr><th>Side</th><th>Symbol</th><th class="r">Qty</th><th class="r">Fill</th><th class="r">Charges</th></tr></thead><tbody>${r.fills.map(row).join("")}</tbody></table></div>` : '<p class="flag ok">No trades: every agent\'s book already matches what it wants at live prices.</p>'}
        ${r.pending.length ? `<p class="flag">${r.pending.length} order(s) wait for your approval (manual desks): <button class="linkbtn" type="button" data-go="orders" data-close-sheet>approve now</button></p>` : ""}
        ${r.blocked.length ? `<p class="small muted">${r.blocked.length} blocked by desk limits.</p>` : ""}${r.waiting.length ? `<p class="small muted">${r.waiting.length} approved but no live price yet; they fill at the next run.</p>` : ""}
        <details class="fold"><summary>What each agent saw</summary><ul class="small">${r.notes.map((n) => `<li>${esc(n)}</li>`).join("")}</ul></details>
        <div class="row"><button class="btn ghost" type="button" data-go="orders" data-close-sheet>See every trade</button><button class="btn ghost" type="button" data-close-sheet>Done</button></div>`;
      wireGo(body);
    } catch (e) { body.innerHTML = `<p class="flag bad">${esc(e.message || e)}</p><button class="btn ghost" type="button" data-close-sheet>Close</button>`; }
  }
  // the trade log: every fill with time, prices, costs and P&L. Click a row for the charges.
  const tradeTime = (o) => o.fill_time ? `${fmtDate(String(o.fill_time).slice(0, 10)) === fmtDate(todayIST()) ? "Today" : fmtDate(new Date(Date.parse(o.fill_time) + 5.5 * 3600e3).toISOString().slice(0, 10))} ${istClock(o.fill_time)}` : `${fmtDate(o.fill_date || o.session)} ${o.fill_at === "close" ? "close" : "open"}`;
  function tradeTable(list, { limit = 300, agentCol = true } = {}) {
    if (!list.length) return '<div class="card empty"><h2>No trades yet</h2><p>Trades appear here the moment they fill: when an agent runs on live prices, when you approve an order, or when you buy or sell from a stock page.</p></div>';
    const rows = list.slice(0, limit);
    return `<div class="card" style="padding:6px 8px"><div class="tablewrap tall"><table class="orders trades"><thead><tr><th>Time</th><th>Side</th><th>Symbol</th><th class="r">Qty</th><th class="r">Live</th><th class="r">Fill</th><th class="r">Value</th><th class="r">Charges</th><th class="r">Net</th><th class="r">Realised</th>${agentCol ? "<th>Desk · agent</th>" : ""}<th>Why</th></tr></thead><tbody>
      ${rows.map((o) => { const old = !o.charges, net = o.net_amount ?? -(o.qty * o.fill_price * (/BUY|COVER/.test(o.side) ? 1 : -1)) - (o.fee || 0);
        return `<tr class="click" data-trade="${esc(o.id)}"><td class="small">${esc(tradeTime(o))}</td><td><span class="side-tag ${esc(o.side)}">${esc(o.side)}</span></td><td><span class="sym">${esc(o.sym)}</span><span class="sub">${esc(nameOfSym(o.sym))}</span></td><td class="r">${Number(o.qty).toLocaleString("en-IN")}</td>
          <td class="r">${px(o.ref_price ?? null)}${o.live_ts ? `<span class="sub">${esc(String(o.live_ts).slice(11, 16))}</span>` : old ? '<span class="sub">day bar</span>' : ""}</td><td class="r"><b>${px(o.fill_price)}</b></td><td class="r">${inr(o.gross_value ?? o.qty * o.fill_price)}</td><td class="r">${inr(o.fee)}</td><td class="r ${cls(net)}">${inr(net)}</td><td class="r ${cls(o.net_realized ?? o.realized)}">${o.realized ? inr(o.net_realized ?? o.realized) : "–"}</td>
          ${agentCol ? `<td><span class="small">${esc(deskName(o.desk))}</span><span class="sub">${esc(O.isManual(o.agent) ? "Manual trades" : agentName(o.agent))}</span></td>` : ""}<td class="small">${esc(o.reason || "")}${o.decided_by && !o.auto ? `<span class="sub">by ${esc(nameOf(o.decided_by))}</span>` : ""}</td></tr>
          <tr class="trade-more" data-more="${esc(o.id)}" hidden><td colspan="${agentCol ? 12 : 11}"><div class="tablewrap" style="max-width:420px"><table><tbody>${old ? `<tr><td>Filled at the ${esc(o.fill_at || "open")} of ${fmtDate(o.fill_date)} (before trading moved to live prices)</td><td></td></tr><tr><td>Costs (flat ${O.COST_PCT}%) and slippage ${O.SLIP_PCT}%</td><td class="r">${inr(o.fee)}</td></tr>` : `<tr><td>${Number(o.qty).toLocaleString("en-IN")} × ${px(o.fill_price)} · live ${px(o.ref_price)} ${o.live_ts ? `at ${esc(String(o.live_ts).slice(11, 16))} IST` : ""} (${esc(o.live_src || "NSE")})</td><td class="r">${inr(o.gross_value)}</td></tr>${chargesRows(o)}<tr><td><b>Charges</b> (${esc(O.CHARGES[o.charges.product]?.label || o.charges.product)})</td><td class="r"><b>${inr(o.fee)}</b></td></tr>`}
            <tr><td>Position after</td><td class="r">${o.pos_after != null ? Number(o.pos_after).toLocaleString("en-IN") : Number(o.to_qty ?? 0).toLocaleString("en-IN")}${o.avg_after ? ` @ ${px(o.avg_after)}` : ""}</td></tr></tbody></table></div></td></tr>`; }).join("")}</tbody></table></div>${list.length > limit ? `<p class="small muted" style="padding:6px">${list.length - limit} older trades not shown.</p>` : ""}</div>`;
  }
  function wireTrades(box) { box.querySelectorAll("[data-trade]").forEach((r) => r.addEventListener("click", (e) => { if (e.target.closest("button,a,[data-go]")) return; const m = box.querySelector(`[data-more="${CSS.escape(r.dataset.trade)}"]`); if (m) m.hidden = !m.hidden; })); }
  const fillsOf = (filter = () => true) => S.ordersList.filter((o) => o.status === "filled" && filter(o)).sort((a, c) => String(c.fill_time || c.fill_date || "").localeCompare(String(a.fill_time || a.fill_date || "")));
  const tradesToday = () => fillsOf((o) => (o.fill_date || "") === todayIST());
  // wire buttons any page renders: [data-trade-sym] opens the ticket, [data-run-agents] runs agents now
  document.addEventListener("click", (e) => {
    const t = e.target.closest("[data-trade-sym]"); if (t) { e.preventDefault(); e.stopPropagation(); openTradeTicket(t.dataset.tradeSym, t.dataset.side || "BUY", { sleeve: t.dataset.sleeve || null }); return; }
    const r = e.target.closest("[data-run-agents]"); if (r) { e.preventDefault(); openRunAgents(r.dataset.runAgents ? r.dataset.runAgents.split(",") : null); }
  }, true);

  // ---------------------------------------------------------------- BACKTESTS: the one place for history replays
  let btShowRetired = false;
  function renderBacktests() {
    const box = $("view-backtests"), list = [...S.agents.values()].filter((a) => btShowRetired || a.status !== "retired")
      .sort((a, c) => ({ paper: 0, testing: 1, paused: 2, retired: 3 }[a.status] ?? 4) - ({ paper: 0, testing: 1, paused: 2, retired: 3 }[c.status] ?? 4) || (c.headline?.cagr ?? -1e9) - (a.headline?.cagr ?? -1e9));
    const H = (a) => a.headline || {};
    box.innerHTML = pageHead("Backtests", "Every agent's rules replayed on history — the only place in TradeOS that looks back. Everything else (book, orders, trades, agents' pages) runs on live prices now. Results include costs; the universe is today's index members unless the agent uses a survivorship-free one.",
      `<button class="btn cio" type="button" data-ask="Backtest a new idea for me: " >Ask the CIO to backtest an idea</button>`)
      + `<div class="card" style="padding:6px 8px"><div class="row" style="padding:8px"><span class="small muted">${list.length} agent(s) · figures from each agent's saved version</span><span class="grow"></span><label class="small muted row" style="gap:6px"><input type="checkbox" id="btRet" ${btShowRetired ? "checked" : ""}> Show retired</label></div>
        <div class="tablewrap tall"><table><thead><tr><th>Agent</th><th>Status</th><th>Period</th><th class="r">CAGR</th><th class="r">Benchmark</th><th class="r">Worst fall</th><th class="r">Sharpe</th><th class="r">Trades</th><th class="r">Win %</th><th>Train → test</th><th></th></tr></thead><tbody>
        ${list.map((a) => { const h = H(a); return `<tr><td><button class="linkbtn" style="color:var(--ink);padding:0" type="button" data-bt="${esc(a.id)}"><span class="sym">${esc(a.name)}</span></button><span class="sub">${esc(TYPE_LABEL[a.type] || a.type)} · ${esc(a.universe || "")} · v${a.version || 1}</span></td><td><span class="pill ${esc(a.status)}">${esc(a.status)}</span></td>
          <td class="small">${h.start ? `${esc(String(h.start).slice(0, 7))} – ${esc(String(h.end || "").slice(0, 7))}` : "–"}</td><td class="r ${cls(h.cagr)}">${pct(h.cagr)}</td><td class="r">${pct(h.nifty_cagr)}</td><td class="r">${pct(h.mdd)}</td><td class="r">${n2(h.sharpe)}</td><td class="r">${h.trades ?? h.cycles ?? "–"}</td><td class="r">${pct(h.win, 0, false)}</td>
          <td class="small">${h.train_cagr != null ? `${pct(h.train_cagr)} → <span class="${cls(h.test_cagr)}">${pct(h.test_cagr)}</span>` : "–"}${h.verdict ? `<span class="sub">${esc(h.verdict)}</span>` : ""}</td><td><button class="btn ghost small" type="button" data-bt="${esc(a.id)}">Open backtest</button></td></tr>`; }).join("") || '<tr><td colspan="11" class="muted small">No agents yet. Describe a strategy to the CIO: it builds it and backtests it here.</td></tr>'}</tbody></table></div></div>`;
    wireGo(box);
    box.querySelector("#btRet")?.addEventListener("change", (e) => { btShowRetired = e.target.checked; renderBacktests(); });
    box.querySelectorAll("[data-bt]").forEach((b) => b.addEventListener("click", () => { S.room.tab = "backtest"; go("agent-" + b.dataset.bt); }));
  }
