  // ================================================================ HOME, MARKETS, SYMBOL PAGES
  const istNow = () => new Date(Date.now() + 5.5 * 3600e3);
  function sessionLine() {
    const t = istNow(), wd = t.getUTCDay(), mins = t.getUTCHours() * 60 + t.getUTCMinutes(), weekday = wd >= 1 && wd <= 5;
    const open = weekday && mins >= 555 && mins < 930, pre = weekday && mins < 555;
    const date = t.toLocaleDateString("en-IN", { weekday: "long", day: "numeric", month: "long", timeZone: "UTC" });
    const nx = nextSessionIso(), nxs = new Date(nx + "T00:00:00Z").toLocaleDateString("en-IN", { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" });
    return `${date} · ${open ? "market open" : pre ? "opens at 09:15" : "market closed"} · ${open ? `data to the close of ${fmtDate(S.lastDay)}` : `next session ${nxs}`}`;
  }
  const heatBg = (x, span = 3) => { if (x == null || !isFinite(x)) return "var(--sunken)"; const k = Math.min(1, Math.abs(x) / span) * 55 + 6; return `color-mix(in srgb, var(${x >= 0 ? "--up" : "--down"}) ${k.toFixed(0)}%, var(--surface))`; };
  function movers(list, n = 6) {
    const rows = list.map((s) => ({ s, d: dayChg(s), m: retN(s, 21), c: lastPx(s) })).filter((r) => r.d != null && isFinite(r.d));
    const hi = []; for (const s of list) { const f = S.light[s]; if (!f || f.c.length < 260) continue; const L = f.c.length; let mx = -Infinity; for (let i = L - 252; i < L; i++) if (f.c[i] > mx) mx = f.c[i]; if (f.c[L - 1] >= mx * 0.995) hi.push({ s, d: dayChg(s), m: retN(s, 21), c: f.c[L - 1] }); }
    const lo = []; for (const s of list) { const f = S.light[s]; if (!f || f.c.length < 260) continue; const L = f.c.length; let mn = Infinity; for (let i = L - 252; i < L; i++) if (f.c[i] < mn) mn = f.c[i]; if (f.c[L - 1] <= mn * 1.005) lo.push({ s, d: dayChg(s), m: retN(s, 21), c: f.c[L - 1] }); }
    return { up: rows.slice().sort((a, b) => b.d - a.d).slice(0, n), down: rows.slice().sort((a, b) => a.d - b.d).slice(0, n), hi: hi.sort((a, b) => (b.m ?? 0) - (a.m ?? 0)), lo: lo.sort((a, b) => (a.m ?? 0) - (b.m ?? 0)),
      m1: rows.filter((r) => r.m != null).sort((a, b) => b.m - a.m).slice(0, n) };
  }
  const mrow = (r, extra) => `<li data-go="sym-${esc(r.s)}"><span style="min-width:0"><b>${esc(r.s)}</b> <span class="n">${esc(nameOfSym(r.s))}</span></span><span class="x muted">${px(r.c)}</span><span class="x ${cls(extra ?? r.d)}">${pct(extra ?? r.d, extra != null ? 1 : 2)}</span></li>`;

  // ---------------------------------------------------------------- HOME
  async function renderHome() {
    const box = $("view-home"); if (!S.man) return;
    const b = bookSummary(), desks = [...S.desks.values()], cfg = S.bookCfg || {};
    const pending = S.ordersList.filter((o) => o.status === "pending"), nx = S.bookState?.next_session || nextSessionIso();
    const queued = S.ordersList.filter((o) => o.session >= nx && o.status === "approved");
    const paperAgents = [...S.agents.values()].filter((a) => a.status === "paper"), loose = paperAgents.filter((a) => !a.desk_id || !S.desks.has(a.desk_id));
    const crit = S.alertEvents.filter((e) => e.severity === "critical" && e.date >= E.isoOf(E.dayOf(S.lastDay) - 3));
    const needs = [];
    if (cfg.kill_switch) needs.push(["crit", "i-stop", "Kill switch is on", "Every position closes at the next open", "book"]);
    for (const d of desks.filter((x) => x.status === "halted")) needs.push(["crit", "i-desks", `${d.name} is halted`, d.halted_reason || "Set it active to resume", "desks"]);
    if (pending.length) needs.push(["warn", "i-orders", `${pending.length} order${pending.length > 1 ? "s" : ""} need your approval`, `for ${fmtDate(pending[0].session)} · ${inrShort(pending.reduce((t, o) => t + (o.value || 0), 0))}`, "orders"]);
    for (const e of crit.slice(0, 3)) needs.push(["crit", "i-alerts", e.title, e.detail || fmtDate(e.date), "alerts"]);
    if (loose.length && desks.length) needs.push(["cio", "i-agent", `${loose.length} paper agent${loose.length > 1 ? "s are" : " is"} not on a desk`, "Their signals don't reach the book until they get a desk and an allocation", "desks"]);
    for (const ag of [...S.agents.values()].filter((x) => x.type === "watchlist" && x.status === "paper")) { const t = (ag.inbox_log || []).slice(-1)[0]; if (!t || t.date < todayIST()) needs.push(["cio", "i-agent", `Send today's names to ${ag.name}`, t ? `last list ${fmtDate(t.date)} · ${t.syms.length} names` : "no list sent yet", `agent-${ag.id}`]); }
    if (!desks.length) needs.push(["cio", "i-desks", "Set up the fund", "Create desks with capital and limits, then allocate agents", "desks"]);
    const stale = (Date.now() - Date.parse(S.lastDay + "T10:00:00Z")) / 864e5 > 4; if (stale) needs.push(["warn", "i-markets", `Market data stops at ${fmtDate(S.lastDay)}`, "The evening data refresh may not have run", "research"]);
    const note = await researchNote();
    const idx = [["NIFTY", "Nifty 50"], ["BANKNIFTY", "Bank Nifty"], ["NIFTY_MIDCAP_150", "Midcap 150"], ["NIFTY_SMALLCAP_250", "Smallcap 250"], ["INDIAVIX", "India VIX"], ["USDINR", "USD/INR"], ["BRENT", "Brent"], ["GOLD", "Gold"], ["US10Y", "US 10-year"], ["SPX", "S&P 500"]].filter(([s]) => S.light[s]);
    const sectors = Object.entries(S.man.symbols).filter(([, v]) => v.group === "sector" && v.val && !v.alias_of).map(([s, v]) => ({ s, n: v.name.replace(/^Nifty /, ""), d: dayChg(s), w: retN(s, 5), m: retN(s, 21) })).filter((x) => x.d != null);
    const hm = S.homeHeat || "d"; sectors.sort((a, c) => (c[hm] ?? -99) - (a[hm] ?? -99));
    const uni = (S.man.universes.nifty500 || []).filter((s) => S.man.symbols[s]?.kind === "stock"), mv = movers(uni);
    const H = S.bookHist || [];
    box.innerHTML = `<p class="small muted" style="margin-bottom:14px">${esc(sessionLine())}</p>
      <div class="hero" style="margin-bottom:18px">
        <div class="card bookhero">${b ? `<div class="row"><span class="eyebrow">The book</span><span class="grow"></span><button class="linkbtn" type="button" data-go="book">Open the book</button></div>
            <div class="big">${inrShort(b.equity)}</div>
            <div class="delta"><span>Today <b class="${cls(b.day)}">${pct(b.day, 2)}</b></span><span>Since start <b class="${cls(b.since)}">${pct(b.since)}</b></span><span>From peak <b class="${b.dd < -0.05 ? "neg" : ""}">${pct(b.dd)}</b></span><span>Invested <b>${pct(b.gross / (b.equity || 1) * 100, 0, false)}</b></span></div>
            <div class="chart" id="homeChart"></div>
            <div class="ladder">${desks.map((d) => { const f = deskFigs(b, d.id); return `<span class="pill ${esc(d.status || "active")}">${esc(d.name)} ${inrShort(f.equity || d.capital)}</span>`; }).join("")}</div>`
          : `<span class="eyebrow">The book</span><div class="big" style="font-size:2.2rem">Paper capital, ready to deploy</div>
            <p class="muted small" style="max-width:52ch">Nothing is allocated yet. The fund runs as the CIO, desks with their own capital and limits, and agents inside each desk. ${paperAgents.length} agent${paperAgents.length === 1 ? " is" : "s are"} already paper trading on their own.</p>
            <div class="row"><button class="btn cio" type="button" data-ask="Set up the fund for me: propose desks with mandates, capital and risk limits for ₹1 crore of paper capital, and assign our paper-trading agents with allocations." data-send="1"><svg><use href="#i-cio"/></svg>Let the CIO set it up</button><button class="btn ghost" type="button" data-go="desks">Set up desks myself</button></div>`}
        </div>
        <div class="cionote"><span class="who"><svg><use href="#i-cio"/></svg>CIO's note${note?.date ? ` · ${esc(fmtDate(note.date))}` : ""}</span>
          ${note?.body ? `<h2>${esc(noteHeadline(note.body))}</h2><div class="body">${md(noteRegime(note.body))}</div><div class="row"><button class="linkbtn" type="button" data-go="research">Read the full note</button><span class="grow"></span><button class="btn cio small" type="button" data-ask="Walk me through today's note: what changed, what it means for our book, and the trades you'd put on now.">Discuss it</button></div>`
            : `<h2>Every evening, after the close</h2><p class="small muted">The CIO writes a note on the regime, connects macro to sectors and stocks, and lists the trades worth testing. The first one appears after tonight's run.</p><button class="btn cio small" type="button" data-ask="Give me today's brief: the regime, what moved and why, and the 3 most interesting opportunities." data-send="1">Get a brief now</button>`}
        </div>
      </div>
      <div class="split" style="margin-bottom:18px">
        <div class="card"><div class="card-head"><h2>Needs you</h2></div><div class="needs">${needs.length ? needs.map(([k, ic, t, d, to]) => `<div class="need ${k}"><span class="ic"><svg><use href="#${ic}"/></svg></span><div style="min-width:0"><b>${esc(t)}</b><div class="d">${esc(d)}</div></div><button class="btn ghost small" type="button" data-go="${to}">Open</button></div>`).join("") : '<p class="muted small">Nothing needs a decision.</p>'}</div></div>
        <div class="card"><div class="card-head"><h2>Next open</h2><span class="small muted">${esc(fmtDate(nx))}</span></div>
          ${queued.length ? `<div class="stack" style="gap:8px">${[...new Set(queued.map((o) => o.desk))].map((d) => { const qs = queued.filter((o) => o.desk === d); return `<div class="row" style="justify-content:space-between"><span><b>${esc(deskName(d))}</b> <span class="muted small">${qs.length} order${qs.length > 1 ? "s" : ""}</span></span><span class="small">buy ${inrShort(qs.filter((o) => /BUY|COVER/.test(o.side)).reduce((t, o) => t + o.value, 0))} · sell ${inrShort(qs.filter((o) => /SELL|SHORT/.test(o.side)).reduce((t, o) => t + o.value, 0))}</span></div>`; }).join("")}<button class="linkbtn" type="button" data-go="orders">See every order</button></div>`
            : `<p class="muted small">${S.sigN ? `${S.sigN} signal${S.sigN > 1 ? "s" : ""} from paper agents for the next open.${desks.length ? "" : " They reach the book once the agents are on desks."}` : "No orders queued for the next session."}</p>`}
          <div class="ladder" style="margin-top:12px"><span><b>${paperAgents.length}</b> agents paper trading</span><span class="faint">·</span><span><b>${desks.length}</b> desks</span><span class="faint">·</span><button class="linkbtn" type="button" data-go="desks">Manage</button></div></div>
      </div>
      <div class="card-head" style="margin-bottom:10px"><h2>Markets</h2><button class="linkbtn" type="button" data-go="markets">Open markets</button></div>
      <div class="pulse" style="margin-bottom:18px">${idx.map(([s, n]) => { const c = dayChg(s); return `<button type="button" data-go="sym-${esc(s)}"><span class="n">${esc(n)}</span><span class="v">${px(lastPx(s))}</span><span class="c ${cls(c)}">${pct(c, 2)} <span class="muted" style="font-weight:500">· 1m ${pct(retN(s, 21), 1)}</span></span></button>`; }).join("")}</div>
      <div class="card" style="margin-bottom:18px"><div class="card-head"><h2>Sectors</h2><div class="seg" role="group" aria-label="Period" id="heatSeg">${[["d", "1D"], ["w", "1W"], ["m", "1M"]].map(([k, l]) => `<button type="button" data-h="${k}" aria-pressed="${hm === k}">${l}</button>`).join("")}</div></div>
        <div class="heat">${sectors.map((x) => `<button type="button" data-go="sym-${esc(x.s)}" style="background:${heatBg(x[hm], hm === "d" ? 2.5 : hm === "w" ? 5 : 10)}"><span>${esc(x.n)}</span><b>${pct(x[hm], hm === "d" ? 2 : 1)}</b></button>`).join("")}</div></div>
      <div class="card-head" style="margin-bottom:10px"><h2>What's interesting</h2><button class="btn cio small" type="button" data-ask="Scan the market for what's unusual right now — breakouts, new highs, results surprises, option IV spikes, sector rotation, filings — and tell me which are worth acting on and how." data-send="1">Ask the CIO to dig in</button></div>
      <div class="lists" id="homeLists">
        <div class="card"><h3 style="margin-bottom:6px">Up most today</h3><ul class="mlist">${mv.up.map((r) => mrow(r)).join("")}</ul></div>
        <div class="card"><h3 style="margin-bottom:6px">Down most today</h3><ul class="mlist">${mv.down.map((r) => mrow(r)).join("")}</ul></div>
        <div class="card"><h3 style="margin-bottom:6px">At 52-week highs <span class="badge">${mv.hi.length}</span></h3><ul class="mlist">${mv.hi.slice(0, 6).map((r) => mrow(r, r.m)).join("") || '<li class="muted small" style="cursor:default">None today.</li>'}</ul>${mv.hi.length ? '<p class="xs muted" style="margin-top:6px">Sorted by 1-month return.</p>' : ""}</div>
        <div class="card"><h3 style="margin-bottom:6px">At 52-week lows <span class="badge">${mv.lo.length}</span></h3><ul class="mlist">${mv.lo.slice(0, 6).map((r) => mrow(r, r.m)).join("") || '<li class="muted small" style="cursor:default">None today.</li>'}</ul></div>
        <div class="card" id="homeResults"><h3 style="margin-bottom:6px">Results this week</h3><p class="muted small">Loading…</p></div>
        <div class="card" id="homeFilings"><h3 style="margin-bottom:6px">Filings that matter</h3><p class="muted small">Loading…</p></div>
      </div>`;
    wireGo(box);
    box.querySelector("#heatSeg")?.addEventListener("click", (e) => { const t = e.target.closest("[data-h]"); if (t) { S.homeHeat = t.dataset.h; renderHome(); } });
    if (b && H.length >= 2) chart($("homeChart"), Float64Array.from(H.map((r) => E.dayOf(r.date))), [{ short: "Book", color: "var(--series-a)", values: Float64Array.from(H.map((r) => r.equity)), width: 2 }], { height: 120, aria: "Book equity", fmt: inrShort, fmtTip: inr });
    else if ($("homeChart")) $("homeChart").innerHTML = '<p class="xs muted">The equity curve builds up after each evening run.</p>';
    // research-driven lists
    const res = await loadResearch().catch(() => ({})); if (S.view !== "home") return;
    const n500 = new Set(uni), lim = E.isoOf(E.dayOf(S.lastDay) + 8);
    const ev = (res.events?.items || []).filter((e) => n500.has(e.sym) && /result/i.test(e.purpose) && e.date > S.lastDay && e.date <= lim).slice(0, 10);
    const KEY = /order|contract|acqui|merger|amalgam|buyback|buy-back|fund rais|qualified institutional|preferential|credit rating|resign|appointment of (md|ceo|managing)|default|insolvency|pledge|bonus|split|capacity|commission|usfda|warning letter|fraud|penalty/i;
    const since = E.isoOf(E.dayOf(S.lastDay) - 3), fl = (res.filings?.items || []).filter((x) => n500.has(x.sym) && x.t >= since && KEY.test(x.desc + " " + x.text)).slice(0, 8);
    const rb = $("homeResults"), fb = $("homeFilings");
    if (rb) rb.innerHTML = `<h3 style="margin-bottom:6px">Results this week <span class="badge">${ev.length}</span></h3><ul class="mlist">${ev.map((e) => `<li data-go="sym-${esc(e.sym)}"><span style="min-width:0"><b>${esc(e.sym)}</b> <span class="n">${esc(nameOfSym(e.sym))}</span></span><span class="x muted">${esc(new Date(e.date + "T00:00:00Z").toLocaleDateString("en-IN", { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" }))}</span><span class="x ${cls(retN(e.sym, 21))}">${pct(retN(e.sym, 21))}</span></li>`).join("") || '<li class="muted small" style="cursor:default">None in the Nifty 500 this week.</li>'}</ul>${ev.length ? '<p class="xs muted" style="margin-top:6px">Last column: 1-month move into results.</p>' : ""}`;
    if (fb) fb.innerHTML = `<h3 style="margin-bottom:6px">Filings that matter</h3><ul class="mlist">${fl.map((x) => `<li data-go="sym-${esc(x.sym)}" style="grid-template-columns:minmax(0,1fr) auto"><span style="min-width:0"><b>${esc(x.sym)}</b> <span class="n" style="white-space:normal">${esc(x.desc)}${x.text && x.text !== x.desc ? ` — ${esc(x.text.slice(0, 90))}` : ""}</span></span><span class="x xs muted">${esc(x.t.slice(5, 10))}</span></li>`).join("") || '<li class="muted small" style="cursor:default">Nothing notable in the last few days.</li>'}</ul>`;
    wireGo(box);
  }
  function noteHeadline(body) { const l = String(body).split("\n").map((x) => x.trim()).filter(Boolean); const first = l.find((x) => !/^#/.test(x)) || l[0] || ""; const s = first.replace(/\*\*/g, "").replace(/^Bottom line:\s*/i, ""); const cut = s.split(/(?<=\.)\s/)[0]; return cut.length > 160 ? cut.slice(0, 157) + "…" : cut; }
  function noteRegime(body) { const t = String(body); const i = t.search(/^##\s*Regime/m); if (i < 0) return t.slice(0, 900); const j = t.slice(i + 3).search(/^##\s/m); return t.slice(i, j < 0 ? i + 1400 : i + 3 + j); }

  // ---------------------------------------------------------------- MARKETS
  const DEFAULT_WATCH = ["NIFTY", "BANKNIFTY", "RELIANCE", "HDFCBANK", "ICICIBANK", "TCS", "INFY", "BHARTIARTL"];
  const watchList = () => (S.watch || DEFAULT_WATCH).filter((s) => S.man.symbols[s]);
  async function saveWatch(list) { S.watch = list; try { await mainCol().doc("watchlist").set({ kind: "watchlist", syms: list, updated: nowIso() }); } catch (e) { toast("Couldn't save the watchlist: " + (e.message || e)); } if (S.view === "markets") renderMarkets(); if (S.view === "symbol") renderSymbol(S.symView); }
  function renderMarkets() {
    const box = $("view-markets"), wl = watchList();
    const row = (s) => { const f = S.light[s]; if (!f) return ""; const ev = (x) => { try { const v = E.evaluate(E.parse(x), Object.assign(f, { sym: s }), { frames: S.light }); return typeof v === "number" ? v : v[v.length - 1]; } catch (e) { return null; } };
      const c = f.c, L = c.length, tail = Array.from(c.slice(Math.max(0, L - 66)));
      return `<tr class="click" data-go="sym-${esc(s)}"><td><span class="sym">${esc(s)}</span><span class="sub">${esc(nameOfSym(s))}</span></td><td class="r">${px(lastPx(s))}</td><td class="r ${cls(dayChg(s))}">${pct(dayChg(s), 2)}</td><td class="r ${cls(retN(s, 5))}">${pct(retN(s, 5))}</td><td class="r ${cls(retN(s, 21))}">${pct(retN(s, 21))}</td><td class="r ${cls(retN(s, 252))}">${pct(retN(s, 252))}</td><td class="r">${pct(ev("(close/sma(close,200)-1)*100"))}</td><td class="r">${n2(ev("rsi(close,14)"))}</td><td style="width:120px">${spark(tail, 120, 28)}</td><td><button class="linkbtn danger" type="button" data-unwatch="${esc(s)}" aria-label="Remove ${esc(s)}">Remove</button></td></tr>`; };
    const group = (g) => Object.entries(S.man.symbols).filter(([, v]) => v.kind === "index" && !v.alias_of && (v.group || "broad") === g).map(([s]) => s);
    const broad = ["NIFTY", "NIFTYNEXT50", "NIFTY_MIDCAP_150", "NIFTY_SMALLCAP_250", "NIFTY_500", "BANKNIFTY", "FINNIFTY", "INDIAVIX"].filter((s) => S.light[s]);
    const glob = ["SPX", "NASDAQ", "DOWJONES", "FTSE100", "DAX", "NIKKEI", "HANGSENG", "SHANGHAI", "MSCI_EM", "USVIX", "US10Y", "DXY", "USDINR", "BRENT", "GOLD", "SILVER", "COPPER", "BITCOIN"].filter((s) => S.light[s]);
    const n50 = (S.man.universes.nifty50 || []).filter((s) => S.light[s]).map((s) => ({ s, d: dayChg(s) })).sort((a, c) => (c.d ?? -99) - (a.d ?? -99));
    const mv = movers((S.man.universes.nifty500 || []).filter((s) => S.man.symbols[s]?.kind === "stock"), 8);
    const itab = (list, withPe) => `<div class="tablewrap"><table class="mkt"><thead><tr><th></th><th class="r">Last</th><th class="r">Today</th><th class="r">1m</th><th class="r">1y</th>${withPe ? '<th class="r">P/E</th>' : ""}</tr></thead><tbody>${list.map((s) => { const f = S.full[s] || S.light[s]; const pe = f?.pe ? f.pe[f.pe.length - 1] : null;
      return `<tr class="click" data-go="sym-${esc(s)}"><td><span class="sym" title="${esc(nameOfSym(s))}">${esc(String(TICK_NAME[s] || nameOfSym(s)).replace(/\s*\([^)]*\)\s*$/, ""))}</span></td><td class="r">${px(lastPx(s))}</td><td class="r ${cls(dayChg(s))}">${pct(dayChg(s), 2)}</td><td class="r ${cls(retN(s, 21))}">${pct(retN(s, 21))}</td><td class="r ${cls(retN(s, 252))}">${pct(retN(s, 252))}</td>${withPe ? `<td class="r">${pe ? n2(pe) : "–"}</td>` : ""}</tr>`; }).join("")}</tbody></table></div>`;
    box.innerHTML = pageHead("Markets", `Close of ${fmtDate(S.lastDay)}. NSE prices for ${Object.values(S.man.symbols).filter((v) => v.kind === "stock").length} stocks and every NSE index, plus world markets, rates, currencies and commodities.`,
      `<button class="btn cio" type="button" data-ask="What's the market telling us right now? Read breadth, sectors, flows, volatility and global cues, and connect it to what we should do." data-send="1"><svg><use href="#i-cio"/></svg>Ask the CIO</button>`)
      + `<div class="card" style="margin-bottom:18px"><div class="card-head"><h2>Watchlist</h2>${S.watch ? "" : '<span class="xs muted">Suggested — add or remove a name to make it yours</span>'}<form class="watch-add" id="watchForm"><input class="input" id="watchIn" list="watchSyms" placeholder="Add a symbol" autocomplete="off" style="width:200px" aria-label="Add a symbol to the watchlist"><datalist id="watchSyms">${Object.entries(S.man.symbols).filter(([, v]) => !v.alias_of).map(([s, v]) => `<option value="${esc(s)}">${esc(v.name || "")}</option>`).join("")}</datalist><button class="btn small" type="submit">Add</button></form></div>
        <div class="tablewrap"><table><thead><tr><th>Symbol</th><th class="r">Last</th><th class="r">Today</th><th class="r">1w</th><th class="r">1m</th><th class="r">1y</th><th class="r">vs 200d</th><th class="r">RSI</th><th>3 months</th><th></th></tr></thead><tbody>${wl.map(row).join("")}</tbody></table></div></div>
      <div class="split even" style="margin-bottom:18px"><div class="card"><h2 style="margin-bottom:8px">India</h2>${itab(broad, false)}</div><div class="card"><h2 style="margin-bottom:8px">World</h2>${itab(glob, false)}</div></div>
      <div class="card" style="margin-bottom:18px"><div class="card-head"><h2>Nifty 50 today</h2><span class="xs muted">${n50.filter((x) => x.d > 0).length} up · ${n50.filter((x) => x.d < 0).length} down</span></div><div class="heat">${n50.map((x) => `<button type="button" data-go="sym-${esc(x.s)}" style="background:${heatBg(x.d)}"><span>${esc(x.s)}</span><b>${pct(x.d, 2)}</b></button>`).join("")}</div></div>
      <div class="lists">
        <div class="card"><h3 style="margin-bottom:6px">Nifty 500: up most today</h3><ul class="mlist">${mv.up.map((r) => mrow(r)).join("")}</ul></div>
        <div class="card"><h3 style="margin-bottom:6px">Nifty 500: down most today</h3><ul class="mlist">${mv.down.map((r) => mrow(r)).join("")}</ul></div>
        <div class="card"><h3 style="margin-bottom:6px">Best month</h3><ul class="mlist">${mv.m1.map((r) => mrow(r, r.m)).join("")}</ul></div>
      </div>`;
    wireGo(box);
    box.querySelectorAll("[data-unwatch]").forEach((b) => b.addEventListener("click", (e) => { e.stopPropagation(); saveWatch(watchList().filter((s) => s !== b.dataset.unwatch)); }));
    box.querySelector("#watchForm").addEventListener("submit", (e) => { e.preventDefault(); const s = E.symKey($("watchIn").value || ""); if (!s) return; if (!S.man.symbols[s]) { toast(`No data for ${s}. Ask the CIO to add it.`); return; } if (!watchList().includes(s)) saveWatch([...watchList(), s]); });
  }

  // ---------------------------------------------------------------- SYMBOL
  S.symRange = "1Y"; S.symSma = true;
  const RANGES = { "1M": 22, "3M": 66, "6M": 130, "1Y": 252, "3Y": 756, "5Y": 1260, "Max": 1e9 };
  async function renderSymbol(sym) {
    sym = E.symKey(sym); S.symView = sym; const box = $("view-symbol"), m = S.man.symbols[sym];
    if (!m) { box.innerHTML = `<div class="card empty"><h2>No data for ${esc(sym)}</h2><p>It isn't in TradeOS yet. The CIO can request it: any NSE stock, index, ETF or global ticker.</p><button class="btn cio" type="button" data-ask="Add ${esc(sym)} to TradeOS's data (request_data), and tell me when it will be available." data-send="1">Ask the CIO to add it</button></div>`; return; }
    const isStock = m.kind === "stock", hasFund = isStock && S.man.fund?.companies?.[sym];
    if (!["basket", "series"].includes(m.kind)) await ensureFull([sym]).catch(() => null);
    if (S.symView !== sym) return;
    const f = S.full[sym] || S.light[sym]; f.sym = sym;
    const L = f.c.length, c = f.c[L - 1], prev = f.c[L - 2], ch = (c / prev - 1) * 100;
    const yr = Array.from(f.c.slice(Math.max(0, L - 252))), hi = Math.max(...yr), lo = Math.min(...yr);
    const ev = (x) => { try { const v = E.evaluate(E.parse(x), f, { frames: S.light }); return typeof v === "number" ? v : v[v.length - 1]; } catch (e) { return null; } };
    const watched = watchList().includes(sym);
    const inBook = (bookSummary()?.positions || []).filter((p) => p.sym === sym), ords = S.ordersList.filter((o) => o.sym === sym).slice(0, 8);
    const myAlerts = S.alertRules.filter((a) => a.sym === sym);
    const stats = [["Open", px(f.o?.[L - 1])], ["High", px(f.h?.[L - 1])], ["Low", px(f.l?.[L - 1])], ["Prev close", px(prev)],
      f.v ? ["Volume", `${(f.v[L - 1] / 1e5).toFixed(1)} L <span class="muted xs">${pct((f.v[L - 1] / (ev("sma(volume,20)") || 1) - 1) * 100, 0)} vs 20d</span>`] : null,
      ["1 week", `<span class="${cls(retN(sym, 5))}">${pct(retN(sym, 5))}</span>`], ["1 month", `<span class="${cls(retN(sym, 21))}">${pct(retN(sym, 21))}</span>`], ["3 months", `<span class="${cls(retN(sym, 63))}">${pct(retN(sym, 63))}</span>`], ["1 year", `<span class="${cls(retN(sym, 252))}">${pct(retN(sym, 252))}</span>`],
      ["vs 50 / 200 day", `${pct(ev("(close/sma(close,50)-1)*100"))} / ${pct(ev("(close/sma(close,200)-1)*100"))}`], ["RSI 14", n2(ev("rsi(close,14)"))], ["Volatility 20d", `${n2(ev("volatility(close,20)"))}%`],
      sym !== "NIFTY" ? ["Beta to Nifty (1y)", n2(ev('beta(ret(close,1), ref("NIFTY", ret(close,1)), 252)'))] : null, f.pe ? ["P/E · P/B · yield", `${n2(f.pe[L - 1])} · ${n2(f.pb?.[L - 1])} · ${n2(f.dy?.[L - 1])}%`] : null].filter(Boolean);
    box.innerHTML = `<div class="crumbs"><button type="button" data-go="markets">Markets</button><span aria-hidden="true">/</span><span>${esc(m.industry && m.industry !== "Index" ? m.industry : m.group || m.kind)}</span></div>
      <div class="symhead"><div><h1>${esc(m.name || sym)}</h1><p class="small muted" style="margin-top:4px">${esc(sym)}${m.ex === "BSE" ? ` · BSE${m.bse ? " " + esc(m.bse) : ""}` : m.kind === "stock" && m.series && m.series !== "EQ" ? ` · NSE ${esc(m.series)}` : ""}${m.fno ? ` · F&amp;O lot ${m.lot}` : ""}${m.n50 ? " · Nifty 50" : m.n200 ? " · Nifty 200" : m.n500 ? " · Nifty 500" : ""}</p></div>
        <div><div class="px">${px(c)}</div><div class="chg ${cls(ch)}">${pct(ch, 2)} <span class="small muted" style="font-weight:500">${fmtDate(E.isoOf(f.d[L - 1]))}</span></div></div>
        <div class="range52"><span>${S.man.keep_days ? "Range, last 6 months" : "52-week range"}</span><div class="bar"><i style="left:${((c - lo) / ((hi - lo) || 1) * 100).toFixed(1)}%"></i></div><div class="row" style="justify-content:space-between"><span>${px(lo)}</span><span>${px(hi)}</span></div></div>
        <span class="grow"></span>
        <div class="row"><button class="btn ghost" type="button" id="symWatch">${watched ? "Watching" : "Watch"}</button><button class="btn ghost" type="button" id="symAlert">Set alert</button><button class="btn cio" type="button" data-ask="${esc(isStock ? `Give me your full view on ${sym} (${m.name}): business, results trend, valuation vs history and peers, technicals, options positioning, catalysts and risks, and exactly how you'd trade it now — entry, size, stop, or an option structure — with a backtest of the idea.` : `Give me your view on ${m.name || sym}: trend, what's driving it, how it connects to our book and sectors, and how you'd trade it.`)}"><svg><use href="#i-cio"/></svg>Ask the CIO</button></div></div>
      <div class="split" style="margin-bottom:18px">
        <div class="card"><div class="chart-head"><div class="seg" role="group" aria-label="Range" id="symRange">${Object.keys(RANGES).map((k) => `<button type="button" data-r="${k}" aria-pressed="${S.symRange === k}">${k}</button>`).join("")}</div><span class="grow"></span><label class="xs muted row" style="gap:6px"><input type="checkbox" id="symSma" ${S.symSma ? "checked" : ""}> 50 &amp; 200-day averages</label></div><div class="chart" id="symChart"></div></div>
        <div class="card"><h2 style="margin-bottom:10px">Key figures</h2><dl class="kv">${stats.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join("")}</dl></div>
      </div>
      ${inBook.length || ords.length || myAlerts.length ? `<div class="card" style="margin-bottom:18px"><h2 style="margin-bottom:10px">In the fund</h2>${inBook.length ? `<p class="small">Held: ${inBook.map((p) => `<b>${p.qty.toLocaleString("en-IN")}</b> by ${esc(agentName(p.agent))} (${esc(deskName(p.desk))}) at ${px(p.avg)}, <span class="${cls(p.pnl)}">${inr(p.pnl)}</span>`).join("; ")}</p>` : ""}
        ${ords.length ? `<p class="small" style="margin-top:6px">Orders: ${ords.map((o) => `<span class="side-tag ${esc(o.side)}">${esc(o.side)}</span> ${o.qty} for ${fmtDate(o.session)} <span class="pill ${esc(o.status)}">${esc(ORDER_STATES[o.status] || o.status)}</span>`).join(" · ")}</p>` : ""}
        ${myAlerts.length ? `<p class="small" style="margin-top:6px">Alerts: ${myAlerts.map((a) => esc(alertSummary(a))).join("; ")}</p>` : ""}</div>` : ""}
      <div id="symMore" class="stack">${hasFund ? '<p class="muted small">Loading results, valuation, peers and news…</p>' : ""}</div>`;
    wireGo(box);
    const draw = () => candleChart($("symChart"), f, RANGES[S.symRange], S.symSma);
    draw();
    box.querySelector("#symRange").addEventListener("click", (e) => { const t = e.target.closest("[data-r]"); if (!t) return; S.symRange = t.dataset.r; box.querySelectorAll("#symRange button").forEach((x) => x.setAttribute("aria-pressed", String(x === t))); draw(); });
    box.querySelector("#symSma").addEventListener("change", (e) => { S.symSma = e.target.checked; draw(); });
    box.querySelector("#symWatch").addEventListener("click", () => saveWatch(watched ? watchList().filter((s) => s !== sym) : [...watchList(), sym]));
    box.querySelector("#symAlert").addEventListener("click", () => { alertForm = { kind: "price", sym, expr: `close > ${Math.round(hi)}`, name: `${sym} above ${px(hi)}` }; go("alerts"); });
    if (!isStock) return;
    // research for stocks: results, valuation, peers, options, news
    const d = await companyResearch(sym).catch((e) => ({ error: e.message })); if (S.symView !== sym) return;
    const more = $("symMore"); if (!more) return;
    if (d.error) { more.innerHTML = ""; return; }
    const r = d.results, v = d.valuation || {}, pf = d.profile, an = pf?.analysts;
    more.innerHTML = `${pf?.business ? `<div class="card"><h2 style="margin-bottom:8px">The business</h2><p class="small" style="max-width:95ch;color:var(--ink-2)">${esc(pf.business)}</p></div>` : ""}
      <div class="stats">${[["P/E (TTM)", v.pe_ttm ?? "–", v.pe_5y_percentile != null ? `${ord(v.pe_5y_percentile)} percentile of the data window · median ${v.pe_5y_median}` : ""], ["Market cap", v.mcap_cr != null ? (v.mcap_cr >= 1e5 ? `₹${(v.mcap_cr / 1e5).toFixed(2)} lakh cr` : `₹${Math.round(v.mcap_cr).toLocaleString("en-IN")} cr`) : "–", d.index_membership.join(" · ")],
        ["Profit growth (TTM)", `<span class="${cls(r?.ttm.profit_growth_pct)}">${pct(r?.ttm.profit_growth_pct)}</span>`, `sales ${pct(r?.ttm.sales_growth_pct)} · 3y profit CAGR ${pct(r?.ttm.profit_cagr_3y_pct)}`], ["Industry P/E", d.peers?.industry_medians.pe ?? "–", `median profit growth ${pct(d.peers?.industry_medians.profit_growth_ttm)}`],
        ["Promoters", d.shareholding ? `${d.shareholding.promoter_pct_history.slice(-1)[0][1]}%` : "–", d.shareholding?.promoter_pct_history.length > 1 ? `from ${d.shareholding.promoter_pct_history[Math.max(0, d.shareholding.promoter_pct_history.length - 5)][1]}% a year ago` : ""],
        ["Analysts", an ? esc(String(an.consensus || "").replace(/_/g, " ")) : "–", an ? `${an.count} · target ${px(an.target_mean)} (${pct((an.target_mean / c - 1) * 100)})` : "Yahoo snapshot"]].map(([k, val, s]) => `<div class="kpi"><span class="k">${k}</span><span class="v">${val}</span><span class="b">${esc(s)}</span></div>`).join("")}</div>
      ${r ? `<div class="card" style="padding:14px 10px 6px"><div class="card-head" style="padding-inline:8px"><h2>Quarterly results</h2><span class="xs muted">${esc(r.basis)} · ₹ crore · as first filed with NSE</span></div><div class="tablewrap"><table><thead><tr><th>Quarter</th><th>Filed</th><th class="r">Sales</th><th class="r">y/y</th><th class="r">Margin</th><th class="r">Profit</th><th class="r">y/y</th><th class="r">Net margin</th></tr></thead><tbody>
        ${r.quarters.slice(0, 10).map((q) => `<tr><td>${esc(q.quarter.slice(0, 7))}</td><td class="small muted">${esc(q.filed)}</td><td class="r">${q.sales_cr != null ? Math.round(q.sales_cr).toLocaleString("en-IN") : "–"}</td><td class="r ${cls(q.sales_yoy_pct)}">${pct(q.sales_yoy_pct, 0)}</td><td class="r">${q.ebitda_margin_pct != null ? q.ebitda_margin_pct + "%" : "–"}</td><td class="r ${cls(q.profit_cr)}">${q.profit_cr != null ? Math.round(q.profit_cr).toLocaleString("en-IN") : "–"}</td><td class="r ${cls(q.profit_yoy_pct)}">${pct(q.profit_yoy_pct, 0)}</td><td class="r">${q.net_margin_pct != null ? q.net_margin_pct + "%" : "–"}</td></tr>`).join("")}</tbody></table></div></div>` : ""}
      <div class="split even">
        ${d.peers ? `<div class="card" style="padding:14px 10px 6px"><div class="card-head" style="padding-inline:8px"><h2>Peers</h2><span class="xs muted">${esc(d.industry)}</span></div><div class="tablewrap"><table><thead><tr><th></th><th class="r">Mcap</th><th class="r">P/E</th><th class="r">Profit growth</th><th class="r">6m</th></tr></thead><tbody>${d.peers.largest.slice(0, 9).map((p) => `<tr class="click${p.symbol === sym ? "" : ""}" data-go="sym-${esc(p.symbol)}" ${p.symbol === sym ? 'style="font-weight:600"' : ""}><td>${esc(p.symbol)}</td><td class="r">${p.mcap_cr != null ? "₹" + Math.round(p.mcap_cr / 1000).toLocaleString("en-IN") + "k cr" : "–"}</td><td class="r">${p.pe ?? "–"}</td><td class="r ${cls(p.profit_growth_ttm)}">${pct(p.profit_growth_ttm, 0)}</td><td class="r ${cls(p.ret_6m_pct)}">${pct(p.ret_6m_pct)}</td></tr>`).join("")}</tbody></table></div></div>` : ""}
        <div class="card"><h2 style="margin-bottom:8px">News and filings</h2>${d.upcoming_events?.length ? `<p class="small" style="margin-bottom:8px"><b>Coming up:</b> ${d.upcoming_events.slice(0, 3).map((e) => `${esc(e.purpose)} on ${fmtDate(e.date)}`).join("; ")}</p>` : ""}
          <ul class="newslist" style="max-height:360px">${[...(d.recent_filings || []).map((x) => ({ t: x.time, a: "NSE filing", h: `${x.filing}${x.detail && x.detail !== x.filing ? " — " + x.detail : ""}` })), ...(d.headlines || []).map((x) => ({ t: x.time, a: x.source, h: x.headline }))].sort((a, b) => b.t.localeCompare(a.t)).slice(0, 25).map((x) => `<li><span class="xs muted">${esc(x.t)} · ${esc(x.a)}</span><br>${esc(x.h)}</li>`).join("") || '<li class="muted">Nothing recent.</li>'}</ul></div>
      </div>
      ${d.options ? `<div class="card"><div class="card-head"><h2>Options</h2><span class="xs muted">NSE F&amp;O, ${esc(fmtDate(d.options.date))}</span></div><div class="mini-kpis">${[["30-day IV", d.options.iv30_pct != null ? d.options.iv30_pct + "%" : "–", d.options.iv_1y_percentile != null ? `${ord(d.options.iv_1y_percentile)} percentile of the data window` : ""], ["Put/call OI", n2(d.options.put_call_oi), ""], ["Max pain", px(d.options.max_pain), ""], ["Skew", d.options.skew_vol_pts != null ? d.options.skew_vol_pts + " vol pts" : "–", "95% put minus 105% call IV"]].map(([k, val, s]) => `<div class="mini"><span class="k">${k}</span><span class="v">${val}</span><span class="b">${esc(s)}</span></div>`).join("")}</div></div>` : ""}`;
    wireGo(more);
  }

  // candlesticks (or a line for long ranges) with 50/200-day averages and volume, drawn to one scale
  function candleChart(el, f, n, sma) {
    if (!el) return;
    const L = f.c.length, i0 = Math.max(0, L - Math.min(n, L)), N = L - i0, ohlc = !!(f.o && f.h && f.l) && N <= 300;
    const W = Math.max(320, el.clientWidth || 640), H = 340, padL = 8, padR = 62, padT = 10, volH = f.v ? 54 : 0, padB = 22, ih = H - padT - padB - volH - (volH ? 8 : 0), iw = W - padL - padR;
    const s50 = sma ? E.evaluate(E.parse("sma(close,50)"), f) : null, s200 = sma ? E.evaluate(E.parse("sma(close,200)"), f) : null;
    let lo = Infinity, hi = -Infinity;
    for (let i = i0; i < L; i++) { const a = ohlc ? f.l[i] : f.c[i], b = ohlc ? f.h[i] : f.c[i]; if (a === a) lo = Math.min(lo, a); if (b === b) hi = Math.max(hi, b); for (const s of [s50, s200]) if (s && s[i] === s[i]) { lo = Math.min(lo, s[i]); hi = Math.max(hi, s[i]); } }
    const pad = (hi - lo) * 0.06 || 1; lo -= pad; hi += pad;
    const fy = (v) => padT + ih - (v - lo) / (hi - lo) * ih, step = iw / N, fx = (i) => padL + (i - i0 + 0.5) * step;
    const yt = niceTicks(lo, hi, 5);
    let svg = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Price chart"><g class="grid">${yt.map((v) => `<line x1="${padL}" x2="${W - padR}" y1="${fy(v).toFixed(1)}" y2="${fy(v).toFixed(1)}"/>`).join("")}</g><g class="axis">${yt.map((v) => `<text x="${W - padR + 6}" y="${(fy(v) + 4).toFixed(1)}">${v >= 1e4 ? Math.round(v).toLocaleString("en-IN") : +v.toFixed(2)}</text>`).join("")}`;
    // x labels: months or years
    const xl = []; let last = null;
    for (let i = i0; i < L; i++) { const dt = new Date(f.d[i] * 864e5), key = N > 400 ? dt.getUTCFullYear() : dt.getUTCFullYear() * 12 + dt.getUTCMonth(); if (key !== last) { xl.push([i, N > 400 ? String(dt.getUTCFullYear()) : dt.toLocaleDateString("en-IN", { month: "short", timeZone: "UTC" })]); last = key; } }
    const every = Math.max(1, Math.ceil(xl.length / Math.max(2, Math.floor(iw / 64))));
    svg += xl.filter((_, k) => k % every === 0 && k > 0).map(([i, t]) => `<text x="${fx(i).toFixed(1)}" y="${H - 6}" text-anchor="middle">${t}</text>`).join("") + "</g>";
    if (ohlc) {
      const bw = Math.max(1, Math.min(9, step * 0.62));
      for (let i = i0; i < L; i++) { const o = f.o[i], c = f.c[i], h = f.h[i], l = f.l[i]; if (!(o === o && c === c)) continue; const up = c >= o, col = up ? "var(--up)" : "var(--down)", x = fx(i);
        svg += `<line x1="${x.toFixed(1)}" x2="${x.toFixed(1)}" y1="${fy(h).toFixed(1)}" y2="${fy(l).toFixed(1)}" stroke="${col}" stroke-width="1"/><rect x="${(x - bw / 2).toFixed(1)}" y="${fy(Math.max(o, c)).toFixed(1)}" width="${bw.toFixed(1)}" height="${Math.max(1, Math.abs(fy(o) - fy(c))).toFixed(1)}" fill="${up ? "var(--surface)" : col}" stroke="${col}" stroke-width="1"/>`; }
    } else {
      let d = ""; for (let i = i0; i < L; i++) if (f.c[i] === f.c[i]) d += (d ? "L" : "M") + fx(i).toFixed(1) + " " + fy(f.c[i]).toFixed(1);
      svg += `<path d="${d} L${fx(L - 1).toFixed(1)} ${padT + ih} L${fx(i0).toFixed(1)} ${padT + ih} Z" fill="var(--accent-soft)" opacity="0.6"/><path d="${d}" fill="none" stroke="var(--series-a)" stroke-width="1.8"/>`;
    }
    for (const [s, col] of [[s50, "var(--series-b)"], [s200, "var(--series-c)"]]) { if (!s) continue; let d = ""; for (let i = i0; i < L; i++) if (s[i] === s[i]) d += (d ? "L" : "M") + fx(i).toFixed(1) + " " + fy(s[i]).toFixed(1); svg += `<path d="${d}" fill="none" stroke="${col}" stroke-width="1.4" opacity="0.9"/>`; }
    if (volH) { let vmax = 0; for (let i = i0; i < L; i++) if (f.v[i] > vmax) vmax = f.v[i]; const y0 = padT + ih + 8 + volH, bw = Math.max(1, step * 0.7);
      for (let i = i0; i < L; i++) { const v = f.v[i]; if (!(v > 0)) continue; const hgt = v / vmax * volH; svg += `<rect x="${(fx(i) - bw / 2).toFixed(1)}" y="${(y0 - hgt).toFixed(1)}" width="${bw.toFixed(1)}" height="${hgt.toFixed(1)}" fill="${f.c[i] >= (f.o?.[i] ?? f.c[i - 1]) ? "var(--up)" : "var(--down)"}" opacity="0.35"/>`; } }
    const lc = f.c[L - 1]; svg += `<line x1="${padL}" x2="${W - padR}" y1="${fy(lc).toFixed(1)}" y2="${fy(lc).toFixed(1)}" stroke="var(--ink)" stroke-dasharray="2 3" opacity="0.5"/><rect x="${W - padR + 2}" y="${(fy(lc) - 9).toFixed(1)}" width="${padR - 4}" height="18" rx="4" fill="var(--ink)"/><text x="${W - padR + 6}" y="${(fy(lc) + 4).toFixed(1)}" fill="var(--ground)" style="font-size:11px;font-weight:600">${lc >= 1e4 ? Math.round(lc).toLocaleString("en-IN") : +lc.toFixed(2)}</text>`;
    svg += `<line class="xh" x1="0" x2="0" y1="${padT}" y2="${H - padB}" stroke="var(--muted)" stroke-dasharray="3 3" visibility="hidden"/><rect x="${padL}" y="${padT}" width="${iw}" height="${H - padT - padB}" fill="transparent" style="cursor:crosshair"/></svg><div class="tip" hidden></div>`;
    el.innerHTML = svg + (sma ? `<div class="legend" style="margin-top:6px"><span><i style="background:var(--series-b)"></i>50-day</span><span><i style="background:var(--series-c)"></i>200-day</span>${volH ? '<span><i style="background:var(--muted)"></i>volume</span>' : ""}</div>` : "");
    el.__chart = { days: f.d.slice(i0), series: [{ name: "Close", values: f.c.slice(i0) }], W, padL, padR, title: "Price", fmt: px };
    const sv = el.querySelector("svg"), tip = el.querySelector(".tip"), xh = el.querySelector(".xh");
    sv.addEventListener("pointerleave", () => { tip.hidden = true; xh.setAttribute("visibility", "hidden"); });
    sv.addEventListener("pointermove", (e) => {
      const r = sv.getBoundingClientRect(), sx = (e.clientX - r.left) * W / r.width, i = Math.max(i0, Math.min(L - 1, i0 + Math.floor((sx - padL) / step)));
      const X = fx(i); xh.setAttribute("x1", X); xh.setAttribute("x2", X); xh.setAttribute("visibility", "visible");
      const chg = i > 0 ? (f.c[i] / f.c[i - 1] - 1) * 100 : null;
      tip.innerHTML = `<b>${fmtDate(E.isoOf(f.d[i]))}</b>${ohlc || f.o ? `<div>O ${px(f.o?.[i])} · H ${px(f.h?.[i])} · L ${px(f.l?.[i])}</div>` : ""}<div>Close <b>${px(f.c[i])}</b> <span class="${cls(chg)}">${pct(chg, 2)}</span></div>${f.v?.[i] ? `<div class="muted">Volume ${(f.v[i] / 1e5).toFixed(1)} L</div>` : ""}`;
      tip.hidden = false; const pxl = X / W * r.width, tw = tip.offsetWidth; tip.style.left = Math.min(Math.max(0, pxl + 12), r.width - tw) + "px"; tip.style.top = "6px";
    });
  }
