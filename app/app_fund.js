  // ================================================================ THE FUND: desks, book, orders, alerts (shared database)
  //   desks/{id}          {name, mandate, capital, status: active|paused|halted, approval: auto|manual, limits{max_position_pct, max_gross_pct, max_dd_pct, max_names}}
  //   agents/{id}         + desk_id, alloc_pct (share of the desk's capital)
  //   book/config         {kill_switch, max_dd_pct}        book/state  (lab/oms.js state)        book/history {rows:[{date, equity, gross, desks, sleeves}]}
  //   orders/{id}         one paper order for a session: pending | approved | blocked | filled | expired | rejected | cancelled
  //   alerts/{id}         a rule (lab/alerts.js)            alert_events/{id}  what fired, when
  // Trading happens NOW: agents decide on live NSE prices (the market-hours run, or "Run agents now" here), orders fill at once
  // at the live price with itemised charges, and the team can buy or sell from any stock page (app_live.js). The evening run
  // only marks the book at the close and checks alerts. This page shows it all and is where people decide.
  const O = window.TradeOMS, AL = window.TradeAlerts;
  S.desks = new Map(); S.bookCfg = {}; S.bookState = null; S.bookHist = []; S.ordersList = []; S.alertRules = []; S.alertEvents = []; S.watch = null; S.seen = {};
  const DESK_PRESETS = { max_position_pct: 15, max_gross_pct: 100, max_dd_pct: 25, max_names: 60 };
  const ORDER_STATES = { pending: "Awaiting approval", approved: "Approved", blocked: "Blocked by a limit", filled: "Filled", expired: "Expired", rejected: "Rejected", cancelled: "Cancelled" };
  const fundRO = () => S.readOnly;
  const nameOfSym = (s) => (S.man.symbols[s]?.name || s).replace(/ (Ltd|Limited)\.?$/i, "");
  // prices as of NOW: a live NSE quote newer than the stored daily bars wins (app_live.js); otherwise the last close
  const lastPx = (s) => { const q = quoteNow(s); if (q) return q.ltp; const f = S.light[s] || S.pitLight?.[s]; if (!f) return null; for (let i = f.c.length - 1; i >= 0; i--) if (f.c[i] === f.c[i]) return f.c[i]; return null; };
  function dayChg(s) { const q = quoteNow(s); if (q) return q.prev ? (q.ltp / q.prev - 1) * 100 : q.chg_pct ?? null; const f = S.light[s]; if (!f || f.c.length < 2) return null; const n = f.c.length; return (f.c[n - 1] / f.c[n - 2] - 1) * 100; }
  function retN(s, n) { const f = S.light[s], q = quoteNow(s); if (q && f && f.c.length >= n) return (q.ltp / f.c[f.c.length - n] - 1) * 100; if (!f || f.c.length <= n) return null; const L = f.c.length; return (f.c[L - 1] / f.c[L - 1 - n] - 1) * 100; }
  const nextSessionIso = () => { let d = E.dayOf(S.lastDay) + 1; while (((new Date(d * 864e5).getUTCDay() + 6) % 7) > 4) d++; return E.isoOf(d); };
  const deskName = (id) => S.desks.get(id)?.name || "—";
  const agentName = (id) => S.agents.get(id)?.name || S.bookState?.sleeves?.[id]?.name || "Agent";
  const pageHead = (title, sub, actions = "") => `<div class="pagehead"><div><h1>${title}</h1>${sub ? `<p>${sub}</p>` : ""}</div>${actions ? `<div class="actions">${actions}</div>` : ""}</div>`;
  const pxFn = (s) => lastPx(s);

  // ---------------------------------------------------------------- subscriptions
  function startFundData() {
    const on = (ref, f, label) => { try { ref.onSnapshot(f, () => { /* not created yet */ }); } catch (e) { console.warn(label, e); } };
    on(S.db.collection("desks"), (snap) => { S.desks = new Map(snap.docs.map((d) => [d.id, { id: d.id, ...d.data() }])); fundChanged("desks"); }, "desks");
    on(S.db.doc("book/config"), (snap) => { S.bookCfg = snap.exists ? snap.data() : {}; fundChanged("book"); }, "config");
    on(S.db.doc("book/state"), (snap) => { S.bookState = snap.exists ? snap.data() : null; fundChanged("book"); }, "state");
    on(S.db.doc("book/history"), (snap) => { S.bookHist = snap.exists ? (snap.data().rows || []) : []; fundChanged("book"); }, "history");
    on(S.db.collection("orders").orderBy("session", "desc").limit(500), (snap) => { S.ordersList = snap.docs.map((d) => ({ id: d.id, ...d.data() })); fundChanged("orders"); }, "orders");
    on(S.db.collection("alerts"), (snap) => { S.alertRules = snap.docs.map((d) => ({ id: d.id, ...d.data() })); fundChanged("alerts"); }, "alerts");
    on(S.db.collection("alert_events").orderBy("at", "desc").limit(300), (snap) => { S.alertEvents = snap.docs.map((d) => ({ id: d.id, ...d.data() })); fundChanged("alerts"); }, "events");
    on(mainCol().doc("watchlist"), (snap) => { S.watch = snap.exists ? (snap.data().syms || []) : null; fundChanged("watch"); }, "watch");
    on(mainCol().doc("seen"), (snap) => { S.seen = snap.exists ? snap.data() : {}; fundChanged("seen"); }, "seen");
  }
  let fundT = null;
  function fundChanged(kind) {
    setCount("orders", S.ordersList.filter((o) => o.status === "pending").length, true);
    const seenAt = S.seen?.alerts_at || ""; setCount("alerts", S.alertEvents.filter((e) => (e.at || "") > seenAt && !e.system).length, true);
    clearTimeout(fundT); fundT = setTimeout(() => {
      const v = S.view;
      if (v === "home") renderHome(); else if (v === "book") renderBook(); else if (v === "orders") renderOrders(); else if (v === "desks") renderDesks(); else if (v === "alerts") renderAlerts();
      else if (v === "markets" && (kind === "watch" || kind === "agents")) renderMarkets(); else if (v === "room" && kind === "desks") renderRoomHead();
    }, 120);
  }

  // ---------------------------------------------------------------- book maths shared by Home and Book
  function bookSummary() {
    const st = S.bookState, H = S.bookHist || [];
    if (!st || !st.sleeves || !Object.keys(st.sleeves).length) return null;
    const desks = {}; let eq = 0, gross = 0, cash = 0, capital = 0;
    for (const [aid, sl] of Object.entries(st.sleeves)) {
      const e = O.sleeveEquity(sl, pxFn); let g = 0; for (const [s, p] of Object.entries(sl.positions || {})) g += Math.abs(p.qty * (lastPx(s) ?? p.last ?? p.avg));
      const d = desks[sl.desk] || (desks[sl.desk] = { equity: 0, gross: 0, capital: 0, sleeves: [] });
      d.equity += e; d.gross += g; d.capital += sl.capital; d.sleeves.push({ id: aid, ...sl, equity: e, gross: g });
      eq += e; gross += g; cash += sl.cash; capital += sl.capital;
    }
    // today = equity now vs the book at the last close before today, net of capital added since (new sleeves, allocations)
    const today = todayIST(), prevRow = [...H].reverse().find((r) => r.date < today) || null;
    let base = 0; if (prevRow) for (const [id, sl] of Object.entries(st.sleeves)) { const pe = prevRow.sleeves?.[id]; base += pe != null ? pe + (sl.capital - (prevRow.caps?.[id] ?? sl.capital)) : sl.capital; }
    const peak = Math.max(st.book_peak || 0, eq), dd = peak > 0 ? (eq / peak - 1) * 100 : 0;
    const start = H.length ? H[0].equity : capital;
    const tt = tradesToday();
    return { equity: eq, gross, cash, capital, desks, dd, peak, start, since: capital ? (eq / capital - 1) * 100 : null,
      day: prevRow && base ? (eq / base - 1) * 100 : null, dayAbs: prevRow ? eq - base : null, prevRow,
      tradesToday: tt.length, chargesToday: tt.reduce((t, o) => t + (o.fee || 0), 0), charges: st.charges_total || 0,
      positions: O.bookPositions(st, pxFn, S.man.symbols), asof: st.asof };
  }
  const deskFigs = (b, id) => b?.desks?.[id] || { equity: 0, gross: 0, capital: 0, sleeves: [] };

  // ---------------------------------------------------------------- ticker (top bar)
  const TICKER = ["NIFTY", "BANKNIFTY", "NIFTY_MIDCAP_150", "INDIAVIX", "USDINR", "BRENT", "GOLD", "US10Y", "SPX"];
  const TICK_NAME = { NIFTY: "Nifty", BANKNIFTY: "Bank Nifty", NIFTY_MIDCAP_150: "Midcap 150", INDIAVIX: "VIX", USDINR: "USD/INR", BRENT: "Brent", GOLD: "Gold", US10Y: "US 10y", SPX: "S&P 500" };
  function renderTicker() {
    $("ticker").innerHTML = TICKER.filter((s) => S.light[s]).map((s) => { const c = dayChg(s); return `<button class="tk" type="button" data-go="sym-${esc(s)}"><b>${TICK_NAME[s] || s}</b><span class="v">${px(lastPx(s))}</span><span class="${cls(c)} chg">${pct(c, 2)}</span></button>`; }).join("");
    wireGo($("ticker"));
  }

  // ---------------------------------------------------------------- command palette
  let palItems = [], palSel = 0;
  const PAGES = [["home", "Home", "The fund at a glance"], ["cio", "CIO", "Ask, decide, delegate"], ["markets", "Markets", "Watchlist, indices, movers"], ["book", "Book", "Live positions, P&L and risk"], ["orders", "Orders & trades", "Every trade, at what price and cost; approvals"], ["backtests", "Backtests", "Every agent's rules replayed on history"], ["desks", "Desks & agents", "Capital, limits, allocations"], ["research", "Research", "Macro, sectors, companies, news"], ["alerts", "Alerts", "Inbox and rules"]];
  function openPalette() { $("palette").hidden = false; $("palInput").value = ""; palFilter(""); setTimeout(() => $("palInput").focus(), 10); }
  function closePalette() { $("palette").hidden = true; }
  function palFilter(q) {
    q = q.trim(); const k = q.toLowerCase(), out = [];
    const score = (key, name) => { const a = key.toLowerCase(), b = (name || "").toLowerCase(); if (!k) return 1; if (a === k) return 100; if (a.startsWith(k)) return 80; if (b.startsWith(k)) return 70; if (a.includes(k)) return 50; if (b.includes(k)) return 40; return 0; };
    for (const [id, n, d] of PAGES) { const sc = score(n, d); if (sc) out.push({ sc: sc + 5, kind: "page", go: id, title: n, sub: d, ic: "i-" + (id === "backtests" ? "backtest" : id) }); }
    if (k) {
      for (const [s, m] of Object.entries(S.man.symbols)) { if (m.alias_of) continue; const sc = score(s, m.name); if (sc) out.push({ sc: sc + (m.kind === "stock" ? 2 : 1), kind: "sym", go: "sym-" + s, title: s, sub: `${m.name || ""}${m.industry && m.industry !== "Index" ? " · " + m.industry : ""}`, icx: m.kind === "stock" ? "EQ" : m.kind === "series" ? "SR" : "IX" }); }
      for (const a of S.agents.values()) { const sc = score(a.name, a.universe); if (sc) out.push({ sc: sc + 3, kind: "agent", go: "agent-" + a.id, title: a.name, sub: `Agent · ${a.status}${a.desk_id ? " · " + deskName(a.desk_id) : ""}`, ic: "i-agent" }); }
      for (const d of S.desks.values()) { const sc = score(d.name, d.mandate); if (sc) out.push({ sc: sc + 3, kind: "desk", go: "desks", title: d.name, sub: "Desk", ic: "i-desks" }); }
    }
    out.sort((a, b) => b.sc - a.sc);
    palItems = out.slice(0, 14);
    if (q) palItems.push({ kind: "cio", title: `Ask the CIO: “${q.length > 70 ? q.slice(0, 70) + "…" : q}”`, sub: "Sends it straight to the CIO", q, ic: "i-cio" });
    palSel = 0; palRender();
  }
  function palRender() {
    $("palList").innerHTML = palItems.map((it, i) => `<button type="button" class="pal-item${it.kind === "cio" ? " cio" : ""}" role="option" aria-selected="${i === palSel}" data-i="${i}"><span class="ic">${it.ic ? `<svg><use href="#${it.ic}"/></svg>` : esc(it.icx || "")}</span><span style="min-width:0"><b>${esc(it.title)}</b><span class="d">${esc(it.sub || "")}</span></span><span class="k">${it.kind === "page" ? "Page" : it.kind === "sym" ? "Market" : it.kind === "agent" ? "Agent" : it.kind === "desk" ? "Desk" : ""}</span></button>`).join("") || '<p class="muted small" style="padding:14px">Nothing matches. Press Enter to ask the CIO.</p>';
    $("palList").querySelector('[aria-selected="true"]')?.scrollIntoView({ block: "nearest" });
  }
  function palGo(it) { closePalette(); if (!it) return; if (it.kind === "cio") askCio(it.q, true); else go(it.go); }
  $("palInput").addEventListener("input", (e) => palFilter(e.target.value));
  $("palInput").addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown") { e.preventDefault(); palSel = Math.min(palItems.length - 1, palSel + 1); palRender(); }
    else if (e.key === "ArrowUp") { e.preventDefault(); palSel = Math.max(0, palSel - 1); palRender(); }
    else if (e.key === "Enter") { e.preventDefault(); const q = $("palInput").value.trim(); palGo(palItems[palSel] || (q ? { kind: "cio", q } : null)); }
  });
  $("palList").addEventListener("click", (e) => { const b = e.target.closest("[data-i]"); if (b) palGo(palItems[+b.dataset.i]); });
  $("palette").addEventListener("click", (e) => { if (e.target.id === "palette") closePalette(); });

  // ---------------------------------------------------------------- BOOK (live)
  let bookTab = "positions";
  const tradeBtns = (sym, sleeve, held) => fundRO() ? "" : `<div class="row" style="flex-wrap:nowrap;gap:6px"><button class="btn small up" type="button" data-trade-sym="${esc(sym)}" data-side="BUY"${sleeve ? ` data-sleeve="${esc(sleeve)}"` : ""}>Buy</button>${held ? `<button class="btn small danger" type="button" data-trade-sym="${esc(sym)}" data-side="SELL"${sleeve ? ` data-sleeve="${esc(sleeve)}"` : ""}>Sell</button>` : ""}</div>`;
  const runBtn = () => fundRO() ? "" : `<button class="btn" type="button" data-run-agents="">Run agents now</button><button class="btn ghost" type="button" data-trade-sym="" data-side="BUY">New trade</button>`;
  async function renderBook() {
    const box = $("view-book"), b = bookSummary(), cfg = S.bookCfg || {};
    const kill = !!cfg.kill_switch;
    const killBtn = fundRO() ? "" : kill ? `<button class="btn ghost" type="button" id="killOff">Turn the kill switch off</button>` : `<button class="btn danger" type="button" id="killOn"><svg><use href="#i-stop"/></svg>Kill switch</button>`;
    const head = pageHead("Book", `Every desk's paper positions, valued at ${esc(liveLabel())}. Agents decide on live prices and trades fill at once at the live NSE price, with charges.`, `${runBtn()}${killBtn}<button class="btn cio" type="button" data-ask="Review the book at live prices: today's P&L and what drove it, concentration, sector and beta exposure, desks near their limits, and what you would buy or sell right now. Be specific."><svg><use href="#i-cio"/></svg>Ask the CIO</button>`);
    if (!b) {
      box.innerHTML = head + `<div class="card empty"><h2>The book is empty</h2><p>Capital reaches the book through desks: create a desk, give it capital and limits, and allocate agents that are paper trading. They trade on live prices during the session; you can also buy and sell yourself from any stock page.</p><div class="row" style="justify-content:center"><button class="btn" type="button" data-go="desks">Set up desks</button><button class="btn cio" type="button" data-ask="Set up the fund for me: propose desks with mandates, capital and risk limits, and assign our paper-trading agents with allocations." data-send="1">Let the CIO set it up</button></div></div>`;
      wireBookHead(box); return;
    }
    const pos = b.positions, totalAbs = pos.reduce((t, p) => t + Math.abs(p.value), 0) || 1;
    const bySym = {}; for (const p of pos) { const x = bySym[p.sym] || (bySym[p.sym] = { sym: p.sym, qty: 0, value: 0, cost: 0, pnl: 0, agents: [], industry: p.industry }); x.qty += p.qty; x.value += p.value; x.cost += p.qty * p.avg; x.pnl += p.pnl; x.agents.push(p); }
    const rows = Object.values(bySym).sort((a, c) => Math.abs(c.value) - Math.abs(a.value));
    const sect = {}; for (const r of rows) { const k = r.industry || "Other"; sect[k] = (sect[k] || 0) + r.value; }
    const sectRows = Object.entries(sect).sort((a, c) => Math.abs(c[1]) - Math.abs(a[1]));
    let beta = 0; for (const r of rows) { const f = S.light[r.sym]; if (!f) continue; const v = evalLast('beta(ret(close,1), ref("NIFTY", ret(close,1)), 252)', Object.assign(f, { sym: r.sym })); if (v != null && isFinite(v)) beta += v * r.value / (b.equity || 1); }
    const unreal = pos.reduce((t, p) => t + p.pnl, 0), realized = S.bookState.realized_total || 0;
    const kpis = [["Equity", inrShort(b.equity), `${esc(liveLabel())} · capital ${inrShort(b.capital)} (${pct(b.since)})`], ["Today", `<span class="${cls(b.dayAbs)}">${b.dayAbs != null ? inrShort(b.dayAbs) : "–"}</span>`, b.prevRow ? `${pct(b.day, 2)} vs the ${fmtDate(b.prevRow.date)} close` : "no earlier close yet"],
      ["Trades today", String(b.tradesToday), `charges ${inr(b.chargesToday)} · all time ${inr(b.charges)}`], ["From peak", `<span class="${b.dd < -0.05 ? "neg" : ""}">${pct(b.dd)}</span>`, cfg.max_dd_pct ? `kill switch at −${cfg.max_dd_pct}%` : "no book drawdown limit"],
      ["Invested", pct(b.gross / (b.equity || 1) * 100, 0, false), `cash ${inrShort(b.cash)} · beta ${n2(beta)}`], ["P&L", `<span class="${cls(unreal + realized)}">${inrShort(unreal + realized)}</span>`, `open ${inrShort(unreal)} · booked ${inrShort(realized)} (after charges)`]];
    const trades = fillsOf();
    box.innerHTML = head + (kill ? `<div class="banner bad" style="margin-bottom:16px"><b>Kill switch on.</b> Positions are closed at live prices on the next run and no new orders are created. ${esc(cfg.kill_reason || "")}</div>` : "") + `
      <div class="stats" style="margin-bottom:18px">${kpis.map(([k, v, s]) => `<div class="kpi"><span class="k">${k}</span><span class="v">${v}</span><span class="b">${s}</span></div>`).join("")}</div>
      <div class="tabs" role="tablist" id="bookTabs">${[["positions", `Positions <span class="badge">${rows.length}</span>`], ["trades", `Trades <span class="badge">${trades.length}</span>`], ["exposure", "Exposure"], ["sleeves", "Agents"], ["equity", "Equity"]].map(([k, l]) => `<button role="tab" type="button" data-btab="${k}" aria-selected="${bookTab === k}">${l}</button>`).join("")}</div>
      <div id="bookBody"></div>`;
    const body = $("bookBody");
    if (bookTab === "positions") body.innerHTML = rows.length ? `<div class="card" style="padding:6px 8px"><div class="tablewrap tall"><table class="orders"><thead><tr><th>Symbol</th><th class="r">Qty</th><th class="r">Avg cost</th><th class="r">Now</th><th class="r">Today</th><th class="r">Value</th><th class="r">Weight</th><th class="r">P&amp;L</th><th class="r">Return</th><th>Held by</th><th></th></tr></thead><tbody>
      ${rows.map((r) => { const avg = r.qty ? r.cost / r.qty : 0, last = lastPx(r.sym), ret = avg ? (last / avg - 1) * 100 * Math.sign(r.qty) : null, q = quoteNow(r.sym), one = r.agents.length === 1 ? r.agents[0].agent : null;
        return `<tr class="click" data-go="sym-${esc(r.sym)}"><td><span class="sym">${esc(r.sym)}</span><span class="sub">${esc(nameOfSym(r.sym))}</span></td><td class="r">${r.qty.toLocaleString("en-IN")}</td><td class="r">${px(avg)}</td><td class="r"><b>${px(last)}</b><span class="sub">${q ? `${esc(q.time.slice(0, 5))} IST` : `close ${esc(fmtDate(S.lastDay))}`}</span></td><td class="r ${cls(dayChg(r.sym))}">${pct(dayChg(r.sym), 2)}</td><td class="r">${inr(r.value)}</td><td class="r">${pct(r.value / totalAbs * 100, 1, false)}</td><td class="r ${cls(r.pnl)}">${inr(r.pnl)}</td><td class="r ${cls(ret)}">${pct(ret)}</td><td class="small muted"><span style="display:block;max-width:190px;overflow:hidden;text-overflow:ellipsis">${esc([...new Set(r.agents.map((p) => O.isManual(p.agent) ? "Manual" : agentName(p.agent)))].join(", "))}</span></td><td>${tradeBtns(r.sym, one, r.qty > 0)}</td></tr>`; }).join("")}</tbody></table></div></div>`
      : `<div class="card empty"><h2>No open positions</h2><p>Agents buy when their rules trigger on live prices; you can buy from any stock page.</p><div class="row" style="justify-content:center">${runBtn()}</div></div>`;
    else if (bookTab === "trades") body.innerHTML = tradeTable(trades);
    else if (bookTab === "exposure") body.innerHTML = `<div class="grid2"><div class="card"><h2 style="margin-bottom:12px">By sector</h2><div class="stack" style="gap:10px">${sectRows.map(([k, v]) => `<div class="limit"><div class="lbls"><span><b>${esc(k)}</b></span><span>${inrShort(v)} · ${pct(v / (b.equity || 1) * 100, 1, false)}</span></div><div class="meter"><i style="width:${Math.min(100, Math.abs(v) / (b.equity || 1) * 100).toFixed(1)}%"></i></div></div>`).join("") || '<p class="muted small">No positions.</p>'}</div></div>
      <div class="card"><h2 style="margin-bottom:12px">Desks</h2><div class="stack" style="gap:14px">${[...S.desks.values()].map((d) => { const f = deskFigs(b, d.id), L = O.limitsOf(d), peak = S.bookState.desk_peaks?.[d.id] || f.equity, dd = peak ? (f.equity / peak - 1) * 100 : 0, use = Math.min(100, Math.abs(dd) / L.max_dd_pct * 100);
        return `<div class="limit"><div class="lbls"><span><b>${esc(d.name)}</b> · ${inrShort(f.equity)}${d.status !== "active" ? ` · <span class="pill ${esc(d.status)}">${esc(d.status)}</span>` : ""}</span><span>${pct(dd)} of −${L.max_dd_pct}%</span></div><div class="meter ${use > 80 ? "bad" : use > 50 ? "warn" : ""}"><i style="width:${use.toFixed(0)}%"></i></div></div>`; }).join("") || '<p class="muted small">No desks.</p>'}</div></div></div>`;
    else if (bookTab === "equity") body.innerHTML = `<div class="card"><div class="chart-head"><h2 style="flex:1">Equity at each close</h2><div class="legend"><span><i style="background:var(--series-a)"></i>Book</span><span><i style="background:var(--series-b)"></i>Nifty, same money</span></div></div><div class="chart" id="bookChart"></div>${S.bookHist.length < 3 ? '<p class="note">One point per session, after each close.</p>' : ""}</div>`;
    else body.innerHTML = `<div class="card" style="padding:6px 8px"><div class="tablewrap"><table><thead><tr><th>Sleeve</th><th>Desk</th><th class="r">Capital</th><th class="r">Equity now</th><th class="r">Today</th><th class="r">Return</th><th class="r">Invested</th><th class="r">Positions</th><th>Trades by</th></tr></thead><tbody>
      ${Object.values(b.desks).flatMap((d) => d.sleeves).map((sl) => { const prev = b.prevRow?.sleeves?.[sl.id];
        return `<tr class="click" ${O.isManual(sl.id) ? "" : `data-go="agent-${esc(sl.id)}"`}><td><span class="sym">${esc(O.isManual(sl.id) ? "Manual trades" : agentName(sl.id))}</span>${sl.closing ? '<span class="sub">winding down</span>' : ""}</td><td>${esc(deskName(sl.desk))}</td><td class="r">${inrShort(sl.capital)}</td><td class="r">${inrShort(sl.equity)}</td><td class="r ${cls(prev ? sl.equity - prev : null)}">${prev ? inrShort(sl.equity - prev) : "–"}</td><td class="r ${cls(sl.equity - sl.capital)}">${pct((sl.equity / (sl.capital || 1) - 1) * 100)}</td><td class="r">${pct(sl.gross / (sl.equity || 1) * 100, 0, false)}</td><td class="r">${Object.keys(sl.positions || {}).length}</td><td class="small muted">${O.isManual(sl.id) ? "you, from the desk's unallocated capital" : sl.oms ? "the agent, at live prices" : "its own paper record, mirrored"}</td></tr>`; }).join("")}</tbody></table></div></div>`;
    wireGo(box); wireBookHead(box); wireTrades(box);
    box.querySelector("#bookTabs").addEventListener("click", (e) => { const t = e.target.closest("[data-btab]"); if (t) { bookTab = t.dataset.btab; renderBook(); } });
    const H = S.bookHist; if (bookTab === "equity" && H.length >= 2) {
      const days = Float64Array.from(H.map((r) => E.dayOf(r.date))), eq = Float64Array.from(H.map((r) => r.equity)), nf = S.light.NIFTY, nb = new Float64Array(H.length);
      let j = 0, last = NaN; for (let i = 0; i < H.length; i++) { while (nf && j < nf.d.length && nf.d[j] <= days[i]) { last = nf.c[j]; j++; } nb[i] = last; }
      const k = eq[0] / nb[0]; chart($("bookChart"), days, [{ short: "Nifty", color: "var(--series-b)", values: nb.map((x) => x * k), width: 1.5 }, { short: "Book", color: "var(--series-a)", values: eq, width: 2.2 }], { height: 240, endLabels: true, aria: "Book equity", fmt: inrShort, fmtEnd: inrShort, fmtTip: inr });
    }
  }
  function wireBookHead(box) {
    box.querySelector("#killOn")?.addEventListener("click", (e) => { const b = e.currentTarget; if (b.dataset.armed) { S.db.doc("book/config").set({ ...S.bookCfg, kill_switch: true, kill_reason: `turned on by ${nameOf(S.uid)}`, kill_at: nowIso() }).then(() => { S.bookCfg = { ...S.bookCfg, kill_switch: true }; }).then(() => { toast(marketOpenNow() ? "Kill switch on: closing every position at live prices" : "Kill switch on: positions close at live prices when the market opens"); if (marketOpenNow()) openRunAgents(null); }).catch((err) => toast(err.message || String(err))); return; }
      b.dataset.armed = "1"; b.textContent = "Tap again to close every position"; b.classList.add("solid"); setTimeout(() => { if (b.isConnected) { delete b.dataset.armed; b.classList.remove("solid"); b.innerHTML = '<svg><use href="#i-stop"/></svg>Kill switch'; } }, 5000); });
    box.querySelector("#killOff")?.addEventListener("click", () => S.db.doc("book/config").set({ ...S.bookCfg, kill_switch: false, kill_reason: null }).then(() => toast("Kill switch off")).catch((err) => toast(err.message || String(err))));
  }

  // ---------------------------------------------------------------- ORDERS & TRADES (live)
  let ordTab = "trades";
  function renderOrders() {
    const box = $("view-orders"), all = S.ordersList;
    const pend = all.filter((o) => o.status === "pending"), waiting = all.filter((o) => o.status === "approved"), trades = fillsOf(), today = tradesToday();
    const buys = today.filter((o) => /BUY|COVER/.test(o.side)), sells = today.filter((o) => /SELL|SHORT/.test(o.side));
    const val = (xs) => xs.reduce((t, o) => t + (o.gross_value ?? o.qty * o.fill_price), 0);
    const tabs = [["trades", "Trades", trades.length], ["pending", "Awaiting you", pend.length], ["all", "Every order", null]];
    if (ordTab === "trades" && !trades.length && pend.length) ordTab = "pending";
    const open = marketOpenNow();
    box.innerHTML = pageHead("Orders &amp; trades", `Agents decide on live NSE prices (every hour in the session, or now with the button) and their orders fill at once at the live price, with itemised charges. Desks set to manual approval wait for you — approving fills at the live price there and then. Paper only.`, `${runBtn()}<button class="btn cio" type="button" data-ask="Go through today's trades and anything awaiting approval: what was bought and sold, at what cost, what's risky or oversized, and what you'd approve, reject or trade now."><svg><use href="#i-cio"/></svg>Ask the CIO</button>`)
      + `<div class="stats" style="margin-bottom:18px">${[["Trades today", String(today.length), `${open ? "market open" : "market closed"} · ${esc(liveLabel())}`], ["Bought today", inrShort(val(buys)), `${buys.length} trade(s)`], ["Sold today", inrShort(val(sells)), `${sells.length} trade(s) · realised ${inr(sells.reduce((t, o) => t + (o.net_realized ?? o.realized ?? 0), 0))}`],
        ["Charges today", inr(today.reduce((t, o) => t + (o.fee || 0), 0)), "STT, exchange, SEBI, stamp, GST, DP"], ["Awaiting you", String(pend.length), pend.length ? `${inrShort(pend.reduce((t, o) => t + (o.value || 0), 0))} · approve to fill now` : waiting.length ? `${waiting.length} approved, fill at the next run` : "nothing to decide"]].map(([k, v, s]) => `<div class="kpi"><span class="k">${k}</span><span class="v">${v}</span><span class="b">${s}</span></div>`).join("")}</div>
      <div class="tabs" role="tablist" id="ordTabs">${tabs.map(([k, l, n]) => `<button role="tab" type="button" data-otab="${k}" aria-selected="${ordTab === k}">${l}${n ? ` <span class="badge${k === "pending" ? " hot" : ""}">${n}</span>` : ""}</button>`).join("")}</div>
      ${ordTab === "pending" && pend.length && !fundRO() ? `<div class="bulk"><b>${pend.length} order(s) need a decision.</b> ${open ? "Approving fills now at the live price." : "The market is closed: approved orders fill at live prices on the next run."}<span class="grow"></span><button class="btn small up" type="button" data-bulk="approved">Approve all</button><button class="btn small danger" type="button" data-bulk="rejected">Reject all</button></div>` : ""}
      <div id="ordBody"></div>
      <p class="note" style="margin-top:12px">Paper only: nothing is sent to a broker. Fills use NSE's live price (1–3 minutes behind) plus ${O.SLIP_PCT}% slippage; charges follow an Indian discount broker's schedule (equity delivery: STT 0.1% each side, exchange ${O.CHARGES.delivery.exch}%, SEBI ₹10/crore, stamp duty ${O.CHARGES.delivery.stamp_buy}% on buys, GST 18%, DP ₹${O.CHARGES.delivery.dp_sell} per sell). Click a trade for its breakdown.</p>`;
    const ob = $("ordBody");
    if (ordTab === "trades") ob.innerHTML = tradeTable(trades);
    else {
      const list = ordTab === "pending" ? pend : all;
      ob.innerHTML = list.length ? `<div class="card" style="padding:6px 8px"><div class="tablewrap tall"><table class="orders"><thead><tr><th>Side</th><th>Symbol</th><th class="r">Qty</th><th class="r">${ordTab === "pending" ? "Now" : "Price"}</th><th class="r">Value</th><th>Desk · agent</th><th>Why</th>${ordTab === "pending" ? "<th></th>" : "<th>When</th><th>Status</th>"}</tr></thead><tbody>
        ${list.map((o) => `<tr class="ordrow"><td><span class="side-tag ${esc(o.side)}">${esc(o.side)}</span></td><td><button class="linkbtn" style="color:var(--ink);padding:0" type="button" data-go="sym-${esc(o.sym)}"><span class="sym">${esc(o.sym)}</span></button><span class="sub">${esc(nameOfSym(o.sym))}</span></td>
          <td class="r">${ordTab === "pending" && !fundRO() ? `<input class="input alloc" type="number" min="0" step="any" value="${o.qty}" data-qty="${esc(o.id)}" aria-label="Quantity">` : Number(o.qty).toLocaleString("en-IN")}</td><td class="r">${px(o.status === "filled" ? o.fill_price : ordTab === "pending" ? lastPx(o.sym) : o.price)}${o.status === "filled" ? '<span class="sub">filled</span>' : ordTab === "pending" ? `<span class="sub">decided at ${px(o.price)}</span>` : ""}</td><td class="r">${inr(o.status === "filled" ? (o.gross_value ?? o.value) : Math.abs(o.qty * (lastPx(o.sym) || o.price)))}</td>
          <td><span class="small">${esc(deskName(o.desk))}</span><span class="sub">${esc(O.isManual(o.agent) ? "Manual trades" : agentName(o.agent))}</span></td><td class="small">${esc(o.reason || "")}${o.checks?.length ? `<span class="checks" style="display:block">${esc(o.checks.join("; "))}</span>` : ""}</td>${ordTab === "pending" ? "" : `<td class="small">${o.fill_time ? esc(tradeTime(o)) : o.decided_at ? `${fmtDate(o.date)} ${istClock(o.decided_at)}` : fmtDate(o.session)}</td>
          <td><span class="pill ${esc(o.status)}">${esc(ORDER_STATES[o.status] || o.status)}</span>${o.note ? `<span class="sub">${esc(o.note)}</span>` : ""}${o.decided_by ? `<span class="sub">by ${esc(nameOf(o.decided_by))}</span>` : ""}</td>`}
          ${ordTab === "pending" ? `<td>${fundRO() ? "" : `<div class="row" style="flex-wrap:nowrap;gap:6px"><button class="btn small up" type="button" data-dec="approved" data-oid="${esc(o.id)}">${open ? "Approve &amp; fill" : "Approve"}</button><button class="btn small danger" type="button" data-dec="rejected" data-oid="${esc(o.id)}">Reject</button></div>`}</td>` : ""}</tr>`).join("")}</tbody></table></div></div>`
        : `<div class="card empty"><h2>${ordTab === "pending" ? "Nothing awaiting you" : "No orders yet"}</h2><p>${S.desks.size ? "Agents on desks set to manual approval send their orders here; the rest fill at once." : "Orders come from agents inside desks. Set up a desk and allocate agents to start."}</p>${S.desks.size ? "" : '<button class="btn" type="button" data-go="desks">Set up desks</button>'}</div>`;
    }
    wireGo(box); wireTrades(box);
    box.querySelector("#ordTabs").addEventListener("click", (e) => { const t = e.target.closest("[data-otab]"); if (t) { ordTab = t.dataset.otab; renderOrders(); } });
    box.querySelectorAll("[data-dec]").forEach((b) => b.addEventListener("click", () => decideOrders([b.dataset.oid], b.dataset.dec, box)));
    box.querySelectorAll("[data-bulk]").forEach((b) => b.addEventListener("click", () => decideOrders(pend.map((o) => o.id), b.dataset.bulk, box)));
  }
  async function decideOrders(ids, status, box) {
    const list = ids.map((id) => S.ordersList.find((x) => x.id === id)).filter((o) => o && o.status === "pending");
    if (!list.length) return;
    const qtyOf = (o) => { const q = box.querySelector(`[data-qty="${CSS.escape(o.id)}"]`); return q ? Math.max(0, Number(q.value) || 0) : o.qty; };
    box.querySelectorAll("[data-dec],[data-bulk]").forEach((b) => { b.disabled = true; });
    try {
      if (status === "rejected") { for (const o of list) await S.db.doc(`orders/${o.id}`).update({ status: "rejected", decided_by: S.uid, decided_at: nowIso() }); toast(`${list.length} order${list.length > 1 ? "s" : ""} rejected`); return; }
      const r = await approveNow(list, qtyOf);
      toast(r.filled.length ? `${r.filled.length} filled at live prices${r.filled.length === 1 ? `: ${r.filled[0].side} ${r.filled[0].qty} ${r.filled[0].sym} @ ${px(r.filled[0].fill_price)}` : ""}${r.failed.length ? ` · ${r.failed.length} wait for a live price` : ""}` : `${r.approved} approved — they fill at live prices on the next run`);
    } catch (e) { toast(e.message || String(e)); box.querySelectorAll("[data-dec],[data-bulk]").forEach((b) => { b.disabled = false; }); }
  }

  // ---------------------------------------------------------------- DESKS & AGENTS
  let deskEdit = null, showRetired = false;
  function renderDesks() {
    const box = $("view-desks"), b = bookSummary(), desks = [...S.desks.values()].sort((a, c) => (a.created_at || "").localeCompare(c.created_at || ""));
    const agents = [...S.agents.values()], unassigned = agents.filter((a) => !a.desk_id || !S.desks.has(a.desk_id)).filter((a) => showRetired || a.status !== "retired");
    const totalCap = desks.reduce((t, d) => t + (d.capital || 0), 0);
    const head = pageHead("Desks &amp; agents", "The CIO runs desks; desks run agents. Each desk has its own capital, risk limits and approval rule; each agent gets a share of its desk's capital.",
      `${fundRO() ? "" : '<button class="btn" type="button" id="newDeskBtn">New desk</button>'}<button class="btn cio" type="button" data-ask="Review the desks: mandates, capital split, limits and agent allocations. Propose a better structure with the reasons, and the changes as actions I can apply."><svg><use href="#i-cio"/></svg>Ask the CIO to restructure</button>`);
    const ladder = `<div class="ladder" style="margin-bottom:18px"><span class="pill plain" style="background:var(--cio-soft);color:var(--cio)">CIO</span><span>→</span><b>${desks.length}</b> desk${desks.length === 1 ? "" : "s"} with ${inrShort(totalCap)}<span>→</span><b>${agents.filter((a) => a.desk_id && S.desks.has(a.desk_id) && a.status !== "retired").length}</b> agents allocated<span class="faint">·</span><span>${unassigned.filter((a) => a.status !== "retired").length} not on a desk</span></div>`;
    const form = deskEdit === "new" ? deskForm({}) : "";
    box.innerHTML = head + ladder + form + `<div class="deskgrid">${desks.map((d) => deskCard(d, b, agents)).join("") || (deskEdit === "new" ? "" : `<div class="card empty"><h2>No desks yet</h2><p>A desk is a sub-fund with a mandate (say, “Equity momentum” or “Options income”), its own capital, risk limits and approval rule. Agents trade inside desks.</p><div class="row" style="justify-content:center">${fundRO() ? "" : '<button class="btn" type="button" id="newDeskBtn2">Create the first desk</button>'}<button class="btn cio" type="button" data-ask="Set up the fund for me: propose desks with mandates, capital and risk limits for ₹1 crore of paper capital, and assign our paper-trading agents with allocations." data-send="1">Let the CIO set it up</button></div></div>`)}</div>
      <div class="card" style="margin-top:22px"><div class="card-head"><h2>Agents not on a desk</h2><label class="small muted row" style="gap:6px"><input type="checkbox" id="showRet" ${showRetired ? "checked" : ""}> Show retired</label></div>
        ${unassigned.length ? `<div class="tablewrap"><table><thead><tr><th>Agent</th><th>Type</th><th>Status</th><th>Paper record</th><th>Assign</th></tr></thead><tbody>${unassigned.sort((a, c) => ({ paper: 0, testing: 1, paused: 2, retired: 3 }[a.status] - { paper: 0, testing: 1, paused: 2, retired: 3 }[c.status])).map((a) => `<tr><td><button class="linkbtn" style="color:var(--ink);padding:0" type="button" data-go="agent-${esc(a.id)}"><span class="sym">${esc(a.name)}</span></button><span class="sub">${esc(a.universe || "")}</span></td><td class="small">${esc(TYPE_LABEL[a.type] || a.type)}</td><td><span class="pill ${esc(a.status)}">${esc(a.status)}</span></td><td class="small muted">${a.status === "paper" ? "trades once it has a desk" : "—"} · <button class="linkbtn" type="button" data-go="backtests">backtest</button></td>
          <td>${fundRO() || !desks.length ? '<span class="xs muted">create a desk first</span>' : `<select class="input" style="min-height:30px;padding:3px 8px;width:auto" data-assign="${esc(a.id)}" aria-label="Assign ${esc(a.name)} to a desk"><option value="">Choose a desk…</option>${desks.map((d) => `<option value="${esc(d.id)}">${esc(d.name)}</option>`).join("")}</select>`}</td></tr>`).join("")}</tbody></table></div>` : '<p class="muted small">Every agent is on a desk.</p>'}
        <p class="note" style="margin-top:10px">New agents come from the CIO: describe a strategy and it builds, backtests and proposes it.</p></div>`;
    wireGo(box); wireDesks(box);
  }
  function deskCard(d, b, agents) {
    const f = deskFigs(b, d.id), L = O.limitsOf(d), mine = agents.filter((a) => a.desk_id === d.id), allocSum = mine.filter((a) => a.status !== "retired").reduce((t, a) => t + (Number(a.alloc_pct) || 0), 0);
    const peak = S.bookState?.desk_peaks?.[d.id] || f.equity, dd = peak ? (f.equity / peak - 1) * 100 : 0, ddUse = Math.min(100, Math.abs(dd) / L.max_dd_pct * 100), gUse = f.equity ? Math.min(100, f.gross / f.equity * 100 / L.max_gross_pct * 100) : 0;
    const pending = S.ordersList.filter((o) => o.desk === d.id && o.status === "pending").length;
    const sl = Object.fromEntries((f.sleeves || []).map((s) => [s.id, s]));
    const st = d.status || "active", ro = fundRO();
    return `<article class="desk ${esc(st)}" data-desk="${esc(d.id)}">
      <div class="desk-head"><div><div class="row" style="gap:8px"><h2>${esc(d.name)}</h2><span class="pill ${esc(st)}">${esc(st)}</span><span class="pill ${d.approval === "manual" ? "manual" : "auto"}">${d.approval === "manual" ? "you approve orders" : "orders auto-approved"}</span>${pending ? `<button class="badge hot" type="button" data-go="orders" style="border:0;cursor:pointer;white-space:nowrap;width:auto;padding-inline:8px">${pending} awaiting</button>` : ""}</div>
        ${d.mandate ? `<p class="mandate">${esc(d.mandate)}</p>` : ""}${st === "halted" && d.halted_reason ? `<p class="flag bad" style="margin-top:8px">Halted: ${esc(d.halted_reason)}. Set it active to resume.</p>` : ""}</div>
        <div class="row">${ro ? "" : `${st === "active" ? `<button class="btn ghost small" type="button" data-dstatus="paused">Pause</button><button class="btn danger small" type="button" data-dstatus="halted">Halt &amp; flatten</button>` : `<button class="btn small" type="button" data-dstatus="active">Set active</button>`}<button class="btn ghost small" type="button" data-dedit="${esc(d.id)}">Edit</button>`}</div></div>
      <div class="desk-figs">
        <div><span class="k">Capital</span><div class="v">${inrShort(d.capital)}</div></div>
        <div><span class="k">Equity</span><div class="v">${f.equity ? inrShort(f.equity) : "–"}</div><span class="xs ${cls(f.equity - f.capital)}">${f.capital ? pct((f.equity / f.capital - 1) * 100) : ""}</span></div>
        <div class="limit"><span class="k" style="font-weight:600">Drawdown</span><div class="lbls"><b>${pct(dd)}</b><span>halts at −${L.max_dd_pct}%</span></div><div class="meter ${ddUse > 80 ? "bad" : ddUse > 50 ? "warn" : ""}"><i style="width:${ddUse.toFixed(0)}%"></i></div></div>
        <div class="limit"><span class="k" style="font-weight:600">Invested</span><div class="lbls"><b>${f.equity ? pct(f.gross / f.equity * 100, 0, false) : "–"}</b><span>max ${L.max_gross_pct}%</span></div><div class="meter ${gUse > 95 ? "warn" : ""}"><i style="width:${gUse.toFixed(0)}%"></i></div></div>
        <div><span class="k">Per name</span><div class="v">${L.max_position_pct}%</div><span class="xs muted">up to ${L.max_names} names</span></div>
      </div>
      ${deskEdit === d.id ? deskForm(d) : ""}
      <div class="desk-body"><div class="tablewrap"><table class="desk-agents"><thead><tr><th>Agent</th><th>Status</th><th class="r">Allocation</th><th class="r">Capital</th><th class="r">Equity now</th><th class="r">Today</th><th>Trades</th><th></th></tr></thead><tbody>
        ${mine.filter((a) => showRetired || a.status !== "retired").map((a) => { const s = sl[a.id]; return `<tr><td><button class="linkbtn" style="color:var(--ink);padding:0" type="button" data-go="agent-${esc(a.id)}"><span class="sym">${esc(a.name)}</span></button><span class="sub">${esc(TYPE_LABEL[a.type] || a.type)} · ${esc(a.universe || "")}</span></td><td><span class="pill ${esc(a.status)}">${esc(a.status)}</span></td>
          <td class="r">${ro ? `${a.alloc_pct || 0}%` : `<input class="input alloc" type="number" min="0" max="100" step="1" value="${a.alloc_pct || 0}" data-alloc="${esc(a.id)}" aria-label="Allocation % for ${esc(a.name)}">`}</td><td class="r">${inrShort((d.capital || 0) * (a.alloc_pct || 0) / 100)}</td><td class="r">${s ? inrShort(s.equity) : '<span class="xs muted">opens on the next run</span>'}</td><td class="r ${cls(s && b?.prevRow?.sleeves?.[a.id] != null ? s.equity - b.prevRow.sleeves[a.id] : null)}">${s && b?.prevRow?.sleeves?.[a.id] != null ? inrShort(s.equity - b.prevRow.sleeves[a.id]) : "–"}</td>
          <td class="xs muted">${O.OMS_TYPES.has(a.type) ? (a.status === "paper" ? `${fillsOf((o) => o.agent === a.id && (o.fill_date || "") === todayIST()).length} today · at live prices` : "start paper trading to trade") : "own paper record, mirrored"}</td><td>${ro ? "" : `<button class="linkbtn danger" type="button" data-unassign="${esc(a.id)}">Remove</button>`}</td></tr>`; }).join("") || `<tr><td colspan="8" class="muted small">No agents yet. Assign one below, or ask the CIO to build one for this mandate.</td></tr>`}
      </tbody></table></div></div>
      <div class="desk-foot"><span class="small ${allocSum > 100 ? "neg" : "muted"}">${allocSum}% of the desk allocated${allocSum > 100 ? " — over 100%" : allocSum < 100 ? ` · ${inrShort((d.capital || 0) * (100 - allocSum) / 100)} idle` : ""}</span><span class="grow"></span>
        ${ro ? "" : `<select class="input" style="min-height:30px;padding:3px 8px;width:auto" data-addto="${esc(d.id)}" aria-label="Add an agent to ${esc(d.name)}"><option value="">Add an agent…</option>${[...S.agents.values()].filter((a) => a.desk_id !== d.id && a.status !== "retired").map((a) => `<option value="${esc(a.id)}">${esc(a.name)}${a.desk_id && S.desks.has(a.desk_id) ? ` (from ${esc(deskName(a.desk_id))})` : ""}</option>`).join("")}</select>`}
        <button class="btn cio small" type="button" data-ask="${esc(`Review the ${d.name} desk: its mandate (${d.mandate || "none"}), agents and allocations, limits, recent orders and P&L. What would you change? Give the changes as actions.`)}">Ask the CIO</button></div>
    </article>`;
  }
  function deskForm(d) {
    const L = { ...DESK_PRESETS, ...(d.limits || {}) }, isNew = !d.id;
    return `<form class="limits-form" data-deskform="${esc(d.id || "new")}" ${isNew ? 'style="border:1px solid var(--line);border-radius:var(--r-lg);margin-bottom:16px;background:var(--surface)"' : ""}>
      ${isNew ? '<h2 style="grid-column:1/-1">New desk</h2>' : ""}
      <div class="field" style="grid-column:span 2"><label for="dfName">Name</label><input class="input" id="dfName" name="name" required maxlength="60" value="${esc(d.name || "")}" placeholder="e.g. Equity momentum"></div>
      <div class="field"><label for="dfCap">Capital (₹)</label><input class="input" id="dfCap" name="capital" type="number" min="0" step="10000" required value="${d.capital ?? 2500000}"></div>
      <div class="field"><label for="dfAppr">Orders</label><select class="input" id="dfAppr" name="approval"><option value="auto" ${d.approval !== "manual" ? "selected" : ""}>Approved automatically</option><option value="manual" ${d.approval === "manual" ? "selected" : ""}>I approve each order</option></select></div>
      <div class="field" style="grid-column:1/-1"><label for="dfMand">Mandate</label><input class="input" id="dfMand" name="mandate" maxlength="300" value="${esc(d.mandate || "")}" placeholder="What this desk is for, in a sentence"></div>
      <div class="field"><label for="dfPos">Max per name (% of desk)</label><input class="input" id="dfPos" name="max_position_pct" type="number" min="1" max="100" step="0.5" value="${L.max_position_pct}"></div>
      <div class="field"><label for="dfGross">Max invested (% of desk)</label><input class="input" id="dfGross" name="max_gross_pct" type="number" min="1" max="300" step="5" value="${L.max_gross_pct}"><span class="help">Over 100% means leverage.</span></div>
      <div class="field"><label for="dfDD">Halt at drawdown (%)</label><input class="input" id="dfDD" name="max_dd_pct" type="number" min="1" max="90" step="1" value="${L.max_dd_pct}"><span class="help">The desk halts and closes its positions.</span></div>
      <div class="field"><label for="dfNames">Max names</label><input class="input" id="dfNames" name="max_names" type="number" min="1" max="500" step="1" value="${L.max_names}"></div>
      <div class="row" style="grid-column:1/-1"><button class="btn" type="submit">${isNew ? "Create desk" : "Save changes"}</button><button class="btn ghost" type="button" data-dcancel>Cancel</button>${isNew ? "" : '<span class="grow"></span><button class="btn danger small" type="button" data-ddelete>Close this desk</button>'}</div>
    </form>`;
  }
  function wireDesks(box) {
    const newBtn = () => { deskEdit = "new"; renderDesks(); setTimeout(() => $("dfName")?.focus(), 20); };
    box.querySelector("#newDeskBtn")?.addEventListener("click", newBtn); box.querySelector("#newDeskBtn2")?.addEventListener("click", newBtn);
    box.querySelector("#showRet")?.addEventListener("change", (e) => { showRetired = e.target.checked; renderDesks(); });
    box.querySelectorAll("[data-dedit]").forEach((b) => b.addEventListener("click", () => { deskEdit = b.dataset.dedit; renderDesks(); }));
    box.querySelectorAll("[data-dcancel]").forEach((b) => b.addEventListener("click", () => { deskEdit = null; renderDesks(); }));
    box.querySelectorAll("[data-ddelete]").forEach((b) => b.addEventListener("click", async () => {
      const id = b.closest("[data-deskform]").dataset.deskform;
      if (!b.dataset.armed) { b.dataset.armed = "1"; b.textContent = "Tap again: agents leave, positions close"; return; }
      try { for (const a of [...S.agents.values()].filter((x) => x.desk_id === id)) await patchAgent(a.id, { desk_id: null, alloc_pct: 0 }); await S.db.doc(`desks/${id}`).delete(); deskEdit = null; toast(marketOpenNow() ? "Desk closed; closing its positions at live prices" : "Desk closed; its positions close at live prices when the market opens"); if (marketOpenNow()) setTimeout(() => openRunAgents(null), 800); } catch (e) { toast(e.message || String(e)); }
    }));
    box.querySelectorAll("[data-deskform]").forEach((f) => f.addEventListener("submit", async (e) => {
      e.preventDefault(); const g = (n) => f.elements[n].value, id = f.dataset.deskform;
      const data = { name: g("name").trim(), mandate: g("mandate").trim(), capital: Math.max(0, Number(g("capital")) || 0), approval: g("approval"),
        limits: { max_position_pct: Number(g("max_position_pct")), max_gross_pct: Number(g("max_gross_pct")), max_dd_pct: Number(g("max_dd_pct")), max_names: Math.trunc(Number(g("max_names"))) }, updated_at: nowIso(), updated_by: S.uid };
      try {
        if (id === "new") { const nid = newId("d"); await S.db.doc(`desks/${nid}`).set({ ...data, status: "active", created_at: nowIso(), created_by: S.uid }); toast(`Desk “${data.name}” created`); }
        else { await S.db.doc(`desks/${id}`).update(data); toast("Desk saved"); }
        deskEdit = null;
      } catch (err) { toast(err.message || String(err)); }
    }));
    box.querySelectorAll("[data-dstatus]").forEach((b) => b.addEventListener("click", async () => {
      const id = b.closest("[data-desk]").dataset.desk, st = b.dataset.dstatus;
      if (st === "halted" && !b.dataset.armed) { b.dataset.armed = "1"; b.textContent = "Tap again to halt"; setTimeout(() => { if (b.isConnected) { delete b.dataset.armed; b.innerHTML = "Halt &amp; flatten"; } }, 5000); return; }
      try { await S.db.doc(`desks/${id}`).update({ status: st, ...(st === "active" ? { halted_reason: null } : {}), updated_at: nowIso(), updated_by: S.uid }); toast(st === "active" ? "Desk active" : st === "paused" ? "Desk paused: no new orders" : marketOpenNow() ? "Desk halted: closing its positions at live prices" : "Desk halted: positions close at live prices when the market opens"); if (st === "halted" && marketOpenNow()) setTimeout(() => openRunAgents(null), 800); } catch (e) { toast(e.message || String(e)); }
    }));
    box.querySelectorAll("[data-alloc]").forEach((i) => i.addEventListener("change", async () => { const v = Math.max(0, Math.min(100, Number(i.value) || 0)); try { await patchAgent(i.dataset.alloc, { alloc_pct: v }); toast(`Allocation ${v}%`); } catch (e) { toast(e.message || String(e)); } }));
    box.querySelectorAll("[data-unassign]").forEach((b) => b.addEventListener("click", async () => { try { await patchAgent(b.dataset.unassign, { desk_id: null, alloc_pct: 0 }); toast(marketOpenNow() ? "Removed from the desk; its positions close on the next run" : "Removed from the desk; its positions close at live prices when the market opens"); } catch (e) { toast(e.message || String(e)); } }));
    const assign = async (aid, did) => { if (!aid || !did) return; const d = S.desks.get(did), used = [...S.agents.values()].filter((a) => a.desk_id === did && a.status !== "retired").reduce((t, a) => t + (Number(a.alloc_pct) || 0), 0);
      try { await patchAgent(aid, { desk_id: did, alloc_pct: Math.max(0, Math.min(100 - used, 25)) }); toast(`Added to ${d?.name || "the desk"} — set its allocation`); } catch (e) { toast(e.message || String(e)); } };
    box.querySelectorAll("[data-assign]").forEach((s) => s.addEventListener("change", () => assign(s.dataset.assign, s.value)));
    box.querySelectorAll("[data-addto]").forEach((s) => s.addEventListener("change", () => assign(s.value, s.dataset.addto)));
  }

  // ---------------------------------------------------------------- ALERTS
  let alertTab = "inbox", alertForm = null;
  const ALERT_KINDS = { price: "Price or indicator", signal: "Agent sends orders", drawdown: "Drawdown", move: "Daily move", news: "News or filing", results: "Results coming up" };
  function alertSummary(a) {
    if (a.kind === "price") return `${a.sym}: ${a.expr}${a.mode === "while" ? " (every day while true)" : " (when it turns true)"}`;
    if (a.kind === "signal") return `${agentName(a.agent_id)} has orders for the next session`;
    if (a.kind === "drawdown" || a.kind === "move") return `${a.scope === "book" ? "The book" : a.scope === "desk" ? deskName(a.id_ref) : agentName(a.id_ref)} ${a.kind === "drawdown" ? "falls" : "moves"} ${a.pct}%${a.kind === "drawdown" ? " from its peak" : " in a day"}`;
    if (a.kind === "news") return `${a.sym || "Any company"}${a.query ? ` · “${a.query}”` : ""}`;
    if (a.kind === "results") return `${a.sym} within ${a.days || 7} days`;
    return a.kind;
  }
  function liveAlertState(a) { // price rules only: is it true on the latest close?
    if (a.kind !== "price") return null;
    try { const f = S.light[a.sym] || S.full[a.sym]; if (!f) return "no data"; const v = E.evaluate(E.parse(a.expr), Object.assign(f, { sym: a.sym }), { frames: S.light }); const x = typeof v === "number" ? v : v[v.length - 1]; return x === x && x !== 0 ? "true now" : "not now"; } catch (e) { return "needs full data"; }
  }
  function renderAlerts() {
    const box = $("view-alerts"), ev = S.alertEvents, seenAt = S.seen?.alerts_at || "";
    const unread = ev.filter((e) => (e.at || "") > seenAt && !e.system).length;
    box.innerHTML = pageHead("Alerts", "Rules on prices and indicators, agents, desks, the book and news. The evening run checks them after the close and sends a push; anything true right now shows here too.",
      `${fundRO() ? "" : '<button class="btn" type="button" id="newAlertBtn">New alert</button>'}<button class="btn cio" type="button" data-ask="Suggest the alerts I should have on the book, the desks and our largest holdings, and create them."><svg><use href="#i-cio"/></svg>Ask the CIO to suggest</button>`)
      + (alertForm ? alertFormHtml(alertForm) : "")
      + `<div class="tabs" role="tablist" id="alTabs"><button role="tab" type="button" data-atab="inbox" aria-selected="${alertTab === "inbox"}">Inbox${unread ? ` <span class="badge alarm">${unread}</span>` : ""}</button><button role="tab" type="button" data-atab="rules" aria-selected="${alertTab === "rules"}">Rules <span class="badge">${S.alertRules.length}</span></button></div>`
      + (alertTab === "inbox" ? (ev.length ? `<div class="card">${ev.slice(0, 150).map((e) => `<div class="alert-ev"><span class="sev ${esc(e.severity || "info")}"></span><div style="min-width:0"><b>${esc(e.title)}</b>${(e.at || "") > seenAt && !e.system ? ' <span class="pill plain" style="background:var(--accent-soft);color:var(--accent)">new</span>' : ""}${e.detail ? `<p class="small muted">${esc(e.detail)}</p>` : ""}</div><span class="xs muted">${esc(fmtDate(e.date))}${e.sym ? `<br><button class="linkbtn" type="button" data-go="sym-${esc(e.sym)}">${esc(e.sym)}</button>` : ""}</span></div>`).join("")}</div>`
          : `<div class="card empty"><h2>No alerts yet</h2><p>When a rule fires, or a desk halts, or an agent joins the book, it lands here.</p></div>`)
        : (S.alertRules.length ? `<div class="card" style="padding:6px 8px"><div class="tablewrap"><table><thead><tr><th>Alert</th><th>Rule</th><th>Now</th><th>Last fired</th><th></th></tr></thead><tbody>${S.alertRules.map((a) => { const live = liveAlertState(a);
            return `<tr><td><span class="sym">${esc(a.name || ALERT_KINDS[a.kind] || a.kind)}</span><span class="sub">${esc(ALERT_KINDS[a.kind] || a.kind)}</span></td><td class="small">${esc(alertSummary(a))}</td><td>${live ? `<span class="pill ${live === "true now" ? "warning" : "info"}">${esc(live)}</span>` : '<span class="xs muted">checked each evening</span>'}</td><td class="small">${a.last_fired ? fmtDate(a.last_fired) : "never"}</td>
              <td>${fundRO() ? "" : `<div class="row" style="flex-wrap:nowrap;gap:6px"><button class="btn ghost small" type="button" data-aact="${esc(a.id)}">${a.active === false ? "Turn on" : "Turn off"}</button><button class="btn danger small" type="button" data-adel="${esc(a.id)}">Delete</button></div>`}</td></tr>`; }).join("")}</tbody></table></div></div>`
          : `<div class="card empty"><h2>No rules</h2><p>Set alerts on a price level, an indicator (“rsi(close,14) &lt; 30”), an agent's orders, a desk's drawdown, a daily move in the book, or filings and results for a company.</p>${fundRO() ? "" : '<button class="btn" type="button" id="newAlertBtn2">New alert</button>'}</div>`));
    wireGo(box);
    box.querySelector("#alTabs").addEventListener("click", (e) => { const t = e.target.closest("[data-atab]"); if (t) { alertTab = t.dataset.atab; renderAlerts(); } });
    const nb = () => { alertForm = { kind: "price" }; renderAlerts(); setTimeout(() => $("afName")?.focus(), 20); };
    box.querySelector("#newAlertBtn")?.addEventListener("click", nb); box.querySelector("#newAlertBtn2")?.addEventListener("click", nb);
    wireAlertForm(box);
    box.querySelectorAll("[data-aact]").forEach((b) => b.addEventListener("click", async () => { const a = S.alertRules.find((x) => x.id === b.dataset.aact); try { await S.db.doc(`alerts/${a.id}`).update({ active: a.active === false }); } catch (e) { toast(e.message || String(e)); } }));
    box.querySelectorAll("[data-adel]").forEach((b) => b.addEventListener("click", async () => { if (!b.dataset.armed) { b.dataset.armed = "1"; b.textContent = "Tap again"; return; } try { await S.db.doc(`alerts/${b.dataset.adel}`).delete(); toast("Alert deleted"); } catch (e) { toast(e.message || String(e)); } }));
    if (alertTab === "inbox" && unread) mainCol().doc("seen").set({ kind: "seen", ...S.seen, alerts_at: nowIso() }).catch(() => {});
  }
  function alertFormHtml(f) {
    const k = f.kind, opt = (v, l, cur) => `<option value="${esc(v)}" ${String(cur) === String(v) ? "selected" : ""}>${esc(l)}</option>`;
    const symIn = (v) => `<div class="field"><label for="afSym">Symbol</label><input class="input" id="afSym" name="sym" list="afSyms" value="${esc(v || f.sym || "")}" placeholder="e.g. RELIANCE" autocomplete="off"><datalist id="afSyms">${Object.keys(S.man.symbols).filter((s) => !S.man.symbols[s].alias_of).map((s) => `<option value="${esc(s)}">`).join("")}</datalist></div>`;
    const scopeIn = `<div class="field"><label for="afScope">Of</label><select class="input" id="afScope" name="scope">${opt("book", "The book", f.scope)}${[...S.desks.values()].map((d) => opt("desk:" + d.id, `Desk: ${d.name}`, f.scope)).join("")}${[...S.agents.values()].filter((a) => a.status === "paper").map((a) => opt("agent:" + a.id, `Agent: ${a.name}`, f.scope)).join("")}</select></div>`;
    const fields = k === "price" ? `${symIn()}<div class="field" style="grid-column:span 2"><label for="afExpr">Condition (rule language)</label><input class="input mono" id="afExpr" name="expr" required value="${esc(f.expr || "close > sma(close, 200)")}"><span class="help">e.g. close &gt; 2500 · rsi(close,14) &lt; 30 · cross_above(close, highest(close,252)) · pe &lt; 15</span></div><div class="field"><label for="afMode">Fire</label><select class="input" id="afMode" name="mode">${opt("cross", "When it turns true", f.mode)}${opt("while", "Every day while true", f.mode)}</select></div>`
      : k === "signal" ? `<div class="field" style="grid-column:span 2"><label for="afAgent">Agent</label><select class="input" id="afAgent" name="agent_id">${[...S.agents.values()].filter((a) => a.status !== "retired").map((a) => opt(a.id, a.name, f.agent_id)).join("")}</select></div>`
      : k === "drawdown" || k === "move" ? `${scopeIn}<div class="field"><label for="afPct">${k === "drawdown" ? "Fall from peak (%)" : "Move in a day (±%)"}</label><input class="input" id="afPct" name="pct" type="number" min="0.1" step="0.1" value="${f.pct || (k === "drawdown" ? 10 : 2)}"></div>`
      : k === "news" ? `${symIn()}<div class="field"><label for="afQ">Words (optional)</label><input class="input" id="afQ" name="query" value="${esc(f.query || "")}" placeholder="e.g. order|acquisition"></div>`
      : `${symIn()}<div class="field"><label for="afDays">Within (days)</label><input class="input" id="afDays" name="days" type="number" min="1" max="60" value="${f.days || 7}"></div>`;
    return `<form class="card limits-form" id="alertForm" style="margin-bottom:18px;border-radius:var(--r-lg)"><h2 style="grid-column:1/-1">New alert</h2>
      <div class="field"><label for="afKind">When</label><select class="input" id="afKind" name="kind">${Object.entries(ALERT_KINDS).map(([v, l]) => opt(v, l, k)).join("")}</select></div>
      <div class="field" style="grid-column:span 2"><label for="afName">Name (optional)</label><input class="input" id="afName" name="name" maxlength="80" value="${esc(f.name || "")}" placeholder="What should the alert say?"></div>
      ${fields}
      <div class="field"><label for="afSev">Importance</label><select class="input" id="afSev" name="severity">${opt("info", "Note", f.severity)}${opt("warning", "Important", f.severity || "warning")}${opt("critical", "Critical", f.severity)}</select></div>
      <div class="row" style="grid-column:1/-1"><button class="btn" type="submit">Save alert</button><button class="btn ghost" type="button" id="afCancel">Cancel</button><span class="status" id="afStatus"></span></div></form>`;
  }
  function wireAlertForm(box) {
    const f = box.querySelector("#alertForm"); if (!f) return;
    f.elements.kind.addEventListener("change", () => { alertForm = { ...alertForm, kind: f.elements.kind.value, name: f.elements.name.value }; renderAlerts(); });
    box.querySelector("#afCancel").addEventListener("click", () => { alertForm = null; renderAlerts(); });
    f.addEventListener("submit", async (e) => {
      e.preventDefault(); const g = (n) => f.elements[n] ? f.elements[n].value.trim() : undefined, kind = g("kind"), st = box.querySelector("#afStatus");
      const a = { kind, name: g("name") || "", severity: g("severity"), active: true, created_by: S.uid, created_at: nowIso() };
      try {
        if (kind === "price") { a.sym = E.symKey(g("sym")); a.expr = g("expr"); a.mode = g("mode"); E.validate(a.expr); if (!S.man.symbols[a.sym]) throw new Error(`No data for ${a.sym}`); }
        if (kind === "signal") a.agent_id = g("agent_id");
        if (kind === "drawdown" || kind === "move") { const [sc, id] = g("scope").split(":"); a.scope = sc; if (id) a.id_ref = id; a.pct = Number(g("pct")); }
        if (kind === "news") { a.sym = g("sym") ? E.symKey(g("sym")) : null; a.query = g("query") || null; }
        if (kind === "results") { a.sym = E.symKey(g("sym")); a.days = Number(g("days")) || 7; }
        const id = newId("al"); await S.db.doc(`alerts/${id}`).set(a); alertForm = null; alertTab = "rules"; toast("Alert saved"); renderAlerts();
      } catch (err) { st.classList.add("err"); st.textContent = err.message || String(err); }
    });
  }
