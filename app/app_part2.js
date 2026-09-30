  // ================================================================ AGENTS (fleet)
  let fleetFilter = "active";
  async function renderFleet() {
    const all = [...S.agents.values()];
    const paper = all.filter((a) => a.status === "paper"), testing = all.filter((a) => a.status === "testing");
    $("agentCount").textContent = all.filter((a) => a.status !== "retired").length;
    const papers = await Promise.all(paper.map(async (a) => { try { return [a.id, await paperResult(a)]; } catch (e) { return [a.id, null]; } }));
    const P = Object.fromEntries(papers);
    const live = papers.map(([, p]) => p).filter((p) => p && !p.pending);
    const avg = live.length ? live.reduce((s, p) => s + p.ret, 0) / live.length : null, avgN = live.length ? live.reduce((s, p) => s + (p.nifty ?? 0), 0) / live.length : null;
    const actions = paper.reduce((n, a) => n + ((P[a.id]?.signals || []).filter((s) => isAction(s)).length), 0);
    $("fleetStats").innerHTML = [["Agents", String(all.length), `${paper.length} paper · ${testing.length} testing`], ["Paper return (avg)", pct(avg), avg == null ? "starts after the next daily update" : `Nifty ${pct(avgN)} over the same days`],
      ["Signals today", String(actions), "buy / sell actions for next session"], ["Data", fmtDate(S.lastDay), "latest daily close"]]
      .map(([k, v, b]) => `<div class="kpi"><span class="k">${k}</span><span class="v">${v}</span><span class="b">${esc(b)}</span></div>`).join("");
    const show = all.filter((a) => fleetFilter === "all" ? true : fleetFilter === "active" ? a.status !== "retired" : a.status === fleetFilter)
      .sort((a, b) => ({ paper: 0, testing: 1, paused: 2, retired: 3 }[a.status] - { paper: 0, testing: 1, paused: 2, retired: 3 }[b.status]) || (b.updated_at || "").localeCompare(a.updated_at || ""));
    await names(show.map((a) => a.updated_by || a.created_by));
    if (!show.length) { $("fleetTable").innerHTML = `<div class="empty"><h2>No agents here yet</h2><p class="muted">Ask the Main Agent for an idea. Proposals you accept become agents.</p><button class="btn" type="button" data-go="main">Talk to the Main Agent</button></div>`; wireGo($("fleetTable")); return; }
    $("fleetTable").innerHTML = `<table><thead><tr><th>Agent</th><th>Status</th><th>Trades in</th><th class="r">Backtest CAGR</th><th class="r">vs benchmark</th><th class="r">Worst fall</th><th class="r">Out-of-sample</th><th class="r">Paper return</th><th>Today</th><th>Version</th><th>Updated</th></tr></thead><tbody>${show.map((a) => {
      const h = a.headline || {}, p = P[a.id], sig = (p?.signals || []).filter((s) => isAction(s, true));
      const today = a.status !== "paper" ? '<span class="muted">—</span>' : sig.length ? sig.slice(0, 3).map((s) => `<span class="act ${s.action.replace(/ /g, "-")}">${esc(s.action)} ${esc(s.symbol)}</span>`).join(" ") + (sig.length > 3 ? ` +${sig.length - 3}` : "") : '<span class="muted">No action</span>';
      return `<tr class="link" data-open="${esc(a.id)}" tabindex="0"><td><b>${esc(a.name)}</b><div class="small muted">${esc(TYPE_LABEL[a.type] || a.type)}</div></td><td><span class="pill ${esc(a.status)}">${esc(a.status)}</span></td><td>${esc(a.universe || "")}</td>
        <td class="r ${cls(h.cagr)}">${pct(h.cagr)}</td><td class="r ${cls((h.cagr ?? 0) - (h.nifty_cagr ?? 0))}">${h.cagr == null ? "–" : pct(h.cagr - (h.nifty_cagr ?? 0)) + " pts"}</td><td class="r">${pct(h.mdd)}</td>
        <td class="r">${h.verdict ? `<span class="pill ${h.verdict === "consistent" ? "paper" : "paused"}">${h.verdict === "consistent" ? "holds up" : "caution"}</span>` : '<span class="muted">no split</span>'}</td>
        <td class="r">${a.status === "paper" && p ? (p.pending ? '<span class="muted">starts next session</span>' : `<span class="${cls(p.ret)}">${pct(p.ret)}</span> <span class="small muted">/ Nifty ${pct(p.nifty)}</span>`) : '<span class="muted">—</span>'}</td>
        <td>${today}</td><td>v${a.version}</td><td class="small muted">${esc(fmtWhen(a.updated_at))} by ${esc(nameOf(a.updated_by || a.created_by))}</td></tr>`; }).join("")}</tbody></table>`;
    $("fleetTable").querySelectorAll("[data-open]").forEach((r) => { const f = () => go("agent-" + r.dataset.open); r.addEventListener("click", f); r.addEventListener("keydown", (e) => { if (e.key === "Enter") f(); }); });
  }
  async function renderSignals() {
    const paper = [...S.agents.values()].filter((a) => a.status === "paper");
    $("sigAsOf").textContent = `Latest close ${fmtDate(S.lastDay)}`;
    if (!paper.length) { $("sigTable").innerHTML = `<div class="empty"><h2>No agents are paper trading</h2><p class="muted">Open an agent and press “Start paper trading”. Its daily buy, sell and hold signals appear here.</p><button class="btn" type="button" data-go="agents">Open agents</button></div>`; wireGo($("sigTable")); $("sigCount").textContent = "0"; return; }
    $("sigTable").innerHTML = '<p class="small muted">Working out today’s signals…</p>';
    const rows = [];
    for (const a of paper) { try { const p = await paperResult(a); for (const s of p?.signals || []) rows.push({ a, s, pending: p.pending }); } catch (e) { rows.push({ a, s: { action: "WAIT", symbol: "-", note: e.message } }); } }
    const act = rows.filter((r) => isAction(r.s, true));
    $("sigCount").textContent = String(act.length); $("sigCount").classList.toggle("hot", act.length > 0);
    const ord = { BUY: 0, SHORT: 0, "SELL NEW": 0, SELL: 1, COVER: 1, EXITED: 2 };
    const sorted = [...act.sort((x, y) => (ord[x.s.action] ?? 5) - (ord[y.s.action] ?? 5)), ...rows.filter((r) => /HOLD/.test(r.s.action))];
    $("sigTable").innerHTML = sorted.length ? `<table><thead><tr><th>Action</th><th>Symbol</th><th>Agent</th><th class="r">Price</th><th class="r">Entry</th><th class="r">Stop</th><th class="r">Target</th><th class="r">P&amp;L</th><th>Note</th></tr></thead><tbody>${sorted.map(({ a, s }) =>
      `<tr class="link" data-open="${esc(a.id)}"><td><span class="act ${s.action.replace(/ /g, "-")}">${esc(s.action)}</span></td><td><b>${esc(s.symbol)}</b></td><td>${esc(a.name)}</td><td class="r">${px(s.price)}</td><td class="r">${px(s.entry)}</td><td class="r">${px(s.stop)}</td><td class="r">${px(s.target)}</td><td class="r ${cls(s.pnl_pct)}">${pct(s.pnl_pct)}</td><td class="wrap small muted">${esc(s.note || "")}</td></tr>`).join("")}</tbody></table>`
      : `<p class="muted">No buy or sell actions today. Every paper agent is holding or waiting.</p>`;
    $("sigTable").querySelectorAll("[data-open]").forEach((r) => r.addEventListener("click", () => go("agent-" + r.dataset.open)));
  }

  // ================================================================ AGENT ROOM
  function openRoom(id) {
    S.room.unsubs.forEach((u) => u()); S.room = { versions: [], messages: [], ver: null, tab: S.room.tab || "overview", unsubs: [], id };
    $("roomBody").innerHTML = '<p class="muted">Loading…</p>'; $("roomLog").innerHTML = "";
    S.room.unsubs.push(S.db.collection(`agents/${id}/versions`).orderBy("n").onSnapshot((snap) => {
      S.room.versions = snap.docs.map((d) => d.data()); const a = S.agents.get(id);
      if (S.room.ver == null || !S.room.versions.find((v) => v.n === S.room.ver)) S.room.ver = a?.version || S.room.versions.length;
      renderRoomHead(); renderRoomBody();
    }, () => toast("Couldn't load this agent's versions.")));
    S.room.unsubs.push(S.db.collection(`agents/${id}/messages`).orderBy("at").limit(300).onSnapshot((snap) => { S.room.messages = snap.docs.map((d) => ({ id: d.id, ...d.data() })); renderRoomLog(); }));
  }
  const curAgent = () => S.agents.get(S.room.id);
  const curVersion = () => S.room.versions.find((v) => v.n === S.room.ver);
  function renderRoomHead() {
    const a = curAgent(); if (!a) { $("roomName").textContent = "Agent not found"; return; }
    $("roomName").textContent = a.name; $("roomStatus").textContent = a.status; $("roomStatus").className = "pill " + a.status; $("roomType").textContent = TYPE_LABEL[a.type] || a.type;
    $("roomSummary").textContent = a.summary || "";
    $("roomVersion").innerHTML = S.room.versions.slice().reverse().map((v) => `<option value="${v.n}" ${v.n === S.room.ver ? "selected" : ""}>v${v.n}${v.n === a.version ? " (current)" : ""}${a.paper && a.paper.version === v.n ? " · paper" : ""}</option>`).join("");
    const btn = (label, st, cls = "ghost") => `<button class="btn ${cls} small" type="button" data-status="${st}" ${S.readOnly ? "disabled" : ""}>${label}</button>`;
    let acts = "";
    if (a.status === "testing") acts = btn("Start paper trading", "paper", "") + btn("Retire", "retired", "danger");
    else if (a.status === "paper") acts = (a.paper && a.paper.version !== a.version ? btn(`Restart paper on v${a.version}`, "paper", "") : "") + btn("Pause", "paused") + btn("Retire", "retired", "danger");
    else if (a.status === "paused") acts = btn(`Resume paper (v${a.version})`, "paper", "") + btn("Retire", "retired", "danger");
    else acts = btn("Reactivate", "testing");
    $("roomActions").innerHTML = acts;
    $("roomActions").querySelectorAll("[data-status]").forEach((b) => b.addEventListener("click", async () => {
      b.disabled = true; try { await setStatus(a, b.dataset.status); toast("Updated"); } catch (e) { toast(e.message || String(e)); b.disabled = false; } }));
  }
  let roomRenderSeq = 0;
  async function renderRoomBody() {
    const a = curAgent(), v = curVersion(), body = $("roomBody"), seq = ++roomRenderSeq;
    document.querySelectorAll("#roomTabs button").forEach((b) => b.setAttribute("aria-selected", String(b.dataset.tab === S.room.tab)));
    if (!a || !v) { body.innerHTML = '<p class="muted">Loading…</p>'; return; }
    const test = v.test || { start: "2012-01-01" };
    let res;
    try { if (!S.cache.has(specKey(v.spec, test))) body.innerHTML = '<p class="muted">Running the backtest…</p>'; res = await runSpec(v.spec, test, (d, n) => { if (seq === roomRenderSeq) body.innerHTML = `<p class="muted">Loading prices ${d} of ${n}…</p>`; }); }
    catch (e) { body.innerHTML = `<p class="flag">${esc(e.message || e)}</p>`; return; }
    if (seq !== roomRenderSeq) return;
    const t = S.room.tab;
    if (t === "overview") await tabOverview(a, v, res, test, body, seq);
    else if (t === "performance") tabPerformance(a, v, res, test, body);
    else if (t === "stress") await tabStress(a, v, res, test, body, seq);
    else if (t === "trades") tabTrades(v, res, body);
    else tabRules(a, v, res, test, body);
  }
  function signalTable(sigs, limit = 60) {
    if (!sigs.length) return '<p class="muted">No signals.</p>';
    return `<div class="tablewrap tall"><table><thead><tr><th>Action</th><th>Symbol</th><th class="r">Price</th><th class="r">Entry</th><th class="r">Stop</th><th class="r">Target</th><th class="r">P&amp;L</th><th>Note</th></tr></thead><tbody>${sigs.slice(0, limit).map((s) =>
      `<tr><td><span class="act ${s.action.replace(/ /g, "-")}">${esc(s.action)}</span>${s.due === false ? ' <span class="small muted" title="Takes effect on the next rebalance day">preview</span>' : ""}</td><td><b>${esc(s.symbol)}</b>${s.weight_pct != null ? ` <span class="small muted">${pct(s.weight_pct, 0, false)}</span>` : ""}</td><td class="r">${px(s.price)}</td><td class="r">${px(s.entry)}</td><td class="r">${px(s.stop)}</td><td class="r">${px(s.target)}</td><td class="r ${cls(s.pnl_pct)}">${pct(s.pnl_pct)}</td><td class="wrap small muted">${esc(s.note || "")}</td></tr>`).join("")}</tbody></table></div>${sigs.length > limit ? `<p class="small muted">${sigs.length - limit} more waiting symbols not shown.</p>` : ""}`;
  }
  function kpiTiles(res) {
    const m = res.metrics, b = res.benchMetrics || {};
    const count = m.cycles != null ? ["Option cycles", String(m.cycles), `${pct(m.win_rate_pct, 1, false)} winners · PF ${n2(m.profit_factor)}`]
      : m.rebalances != null ? ["Orders", String(m.orders ?? m.executions), `${m.rebalances} rebalances · ${m.round_trips ?? "–"} round trips (${pct(m.win_rate_pct, 0, false)} won) · turnover ${m.turnover_pct_yr ?? "–"}%/yr · fees ${inrShort(m.total_fees)}`]
      : ["Trades", String(m.trades ?? 0), `${pct(m.win_rate_pct, 1, false)} winners · PF ${n2(m.profit_factor)}`];
    const bl = benchLabel(res);
    return `${m.notes?.length ? `<p class="flag">${esc(m.notes.join(" "))}</p>` : ""}<div class="stats">${[["CAGR", pct(m.cagr_pct), `${bl} ${pct(b.cagr_pct)}`], ["Total return", pct(m.total_return_pct, 0), `${bl} ${pct(b.total_return_pct, 0)}`], ["Worst fall", pct(m.max_drawdown_pct), `${bl} ${pct(b.max_drawdown_pct)}`],
      ["Sharpe", n2(m.sharpe), `${bl} ${n2(b.sharpe)} · rf 6.5%`], count, ["Final value", inrShort(m.end_equity), `from ${inrShort(m.start_equity)}`]].map(([k, v, s]) => `<div class="kpi"><span class="k">${k}</span><span class="v">${v}</span><span class="b">${esc(s)}</span></div>`).join("")}</div>`;
  }
  function verdictLine(res) { const m = res.metrics, b = res.benchMetrics || {}, d = (m.cagr_pct ?? 0) - (b.cagr_pct ?? 0);
    return `<p class="verdict">${pct(m.cagr_pct)} a year vs ${esc(benchLabel(res))}'s ${pct(b.cagr_pct)} — <span class="${d >= 0 ? "up" : "down"}">${d >= 0 ? "ahead" : "behind"} by ${Math.abs(d).toFixed(1)} points</span>, worst fall ${pct(m.max_drawdown_pct)} vs ${pct(b.max_drawdown_pct)}.</p>`; }
  async function tabOverview(a, v, res, test, body, seq) {
    let paperHtml = "";
    if (a.status === "paper" || a.status === "paused") {
      const p = await paperResult(a).catch(() => null); if (seq !== roomRenderSeq) return;
      if (p?.pending) paperHtml = `<div class="banner">Paper trading on v${p.version} from the next session after ${fmtDate(p.since)}. Results appear after the next daily update.</div>`;
      else if (p) paperHtml = `<div class="card"><div class="row"><h2>Paper trading</h2><span class="pill paper">v${p.version} since ${fmtDate(p.since)}</span><span class="grow"></span><span class="small muted">${p.days} trading days</span></div>
        <div class="mini-kpis" style="margin-top:10px"><div class="mini"><span class="k">Return</span><span class="v ${cls(p.ret)}">${pct(p.ret)}</span><span class="b">Nifty ${pct(p.nifty)}</span></div><div class="mini"><span class="k">Worst fall</span><span class="v">${pct(p.mdd)}</span><span class="b">since start</span></div>
        <div class="mini"><span class="k">Value</span><span class="v">${inrShort(p.res.metrics.end_equity)}</span><span class="b">from ${inrShort(p.res.metrics.start_equity)}</span></div></div>
        <div class="chart" id="paperChart" style="margin-top:10px"></div></div>`;
      if (a.paper && a.paper.version !== v.n) paperHtml = `<div class="banner warn">You're viewing v${v.n}. Paper trading runs v${a.paper.version}; its record stays tied to that version.</div>` + paperHtml;
    }
    const runs = (a.paper_runs || []).filter((r) => r.since);
    const h = headline(res, test);
    const split = test.split ? E.splitMetrics(res, test.split) : null;
    const signals = a.status === "paper" ? ((await paperResult(a).catch(() => null))?.signals || res.signals) : res.signals;
    if (seq !== roomRenderSeq) return;
    const survivor = v.spec.type !== "option_selling" && E.symbolsNeeded(v.spec, S.man.universes).some((x) => S.man.symbols[x]?.kind === "stock")
      ? `<p class="flag">Survivorship bias: this tests today's index members over the whole period, so stocks that fell out of the index are missing and returns look better than they would have been. Treat the paper-trading record as the real test.</p>` : "";
    body.innerHTML = `${paperHtml}
      <div class="card stack"><div class="row"><h2>${a.status === "paper" ? "Today's signals (paper account)" : "Signals if this ran today"}</h2><span class="grow"></span><span class="small muted">close of ${fmtDate(S.lastDay)} · act at next open</span></div>${signalTable(signals, 40)}</div>
      <div class="card stack"><div class="row"><h2>Backtest v${v.n}</h2><span class="small muted">${fmtDate(h.start)} – ${fmtDate(h.end)}</span></div>${verdictLine(res)}${survivor}${kpiTiles(res)}
        ${split ? `<div class="grid2">${["train", "test"].map((k) => { const s = split[k].strategy, n = split[k].nifty || {}; return `<div class="mini" style="padding:12px"><span class="k">${k === "train" ? "Training" : "Test (unseen)"} · ${fmtDate(s.start)} – ${fmtDate(s.end)}</span><span class="v">${pct(s.cagr_pct)} <span class="small muted" style="font-family:var(--font-body);font-weight:400">vs ${esc(benchLabel(res))} ${pct(n.cagr_pct)}</span></span><span class="b">worst fall ${pct(s.max_drawdown_pct)} · Sharpe ${n2(s.sharpe)}${s.trades != null && v.spec.type !== "rotation" ? ` · ${s.trades} ${v.spec.type === "option_selling" ? "cycles" : "trades"}` : ""}</span></div>`; }).join("")}</div>
          ${split.flags.length ? `<p class="flag">${esc(split.flags.join(". "))}.</p>` : `<p class="flag ok">Results hold up on the unseen test period.</p>`}` : `<p class="small muted">No train/test split set for this version. Set one under Rules & versions to check for overfitting.</p>`}</div>
      ${runs.length ? `<div class="card"><h2>Earlier paper runs</h2><div class="tablewrap"><table><thead><tr><th>Version</th><th>From</th><th>Until</th></tr></thead><tbody>${runs.map((r) => `<tr><td>v${r.version}</td><td>${fmtDate(r.since)}</td><td>${fmtDate(r.until)}</td></tr>`).join("")}</tbody></table></div></div>` : ""}`;
    const pc = document.getElementById("paperChart");
    if (pc) { const p = await paperResult(a); if (p && !p.pending) chart(pc, p.res.days, [{ short: benchLabel(p.res), color: "var(--series-b)", values: p.res.bench || [], width: 1.6 }, { short: "Paper", color: "var(--series-a)", values: p.res.eq, width: 2 }], { height: 200, endLabels: true, aria: "Paper equity", fmt: inrShort, fmtEnd: inrShort, fmtTip: inr }); }
  }
  function yearly(days, eq) { const out = new Map(); let prev = eq[0];
    for (let i = 0; i < days.length; i++) { const y = new Date(days[i] * 864e5).getUTCFullYear(), nx = i + 1 < days.length ? new Date(days[i + 1] * 864e5).getUTCFullYear() : null; if (nx !== y) { out.set(y, (eq[i] / prev - 1) * 100); prev = eq[i]; } } return out; }
  function tabPerformance(a, v, res, test, body) {
    const ys = yearly(res.days, res.eq), yb = res.bench ? yearly(res.days, res.bench) : new Map(), m = res.metrics;
    let breakdown = "";
    if (v.spec.type === "rule") { const rows = Object.entries(res.perSymbol).sort((x, y) => (y[1].total_return_pct ?? -1e9) - (x[1].total_return_pct ?? -1e9));
      breakdown = `<h2>By symbol</h2><div class="tablewrap tall"><table><thead><tr><th>Symbol</th><th class="r">Return</th><th class="r">CAGR</th><th class="r">Worst fall</th><th class="r">Trades</th><th class="r">Win %</th></tr></thead><tbody>${rows.map(([s, r]) => r.note ? `<tr><td>${esc(s)}</td><td colspan="5" class="muted">${esc(r.note)}</td></tr>` : `<tr><td>${esc(s)}</td><td class="r ${cls(r.total_return_pct)}">${pct(r.total_return_pct, 0)}</td><td class="r">${pct(r.cagr_pct)}</td><td class="r">${pct(r.max_drawdown_pct)}</td><td class="r">${r.trades ?? 0}</td><td class="r">${pct(r.win_rate_pct, 0, false)}</td></tr>`).join("")}</tbody></table></div>`; }
    else if (v.spec.type === "rotation") breakdown = `<h2>Leaders now</h2><div class="tablewrap"><table><thead><tr><th>#</th><th>Symbol</th><th class="r">${v.spec.score === "momentum" && !v.spec.factors ? "Momentum" : "Score"}</th></tr></thead><tbody>${res.ranking.map(([s, x], i) => `<tr><td>${i + 1}</td><td>${esc(s)} <span class="small muted">${esc(S.man.symbols[s]?.name || "")}</span></td><td class="r ${cls(x)}">${v.spec.score === "momentum" && !v.spec.factors ? pct(x) : n2(x / 100)}</td></tr>`).join("")}</tbody></table></div>`;
    else { const g = {}; for (const c of res.trades) { const x = g[c.reason] || (g[c.reason] = { n: 0, pnl: 0 }); x.n++; x.pnl += c.pnl; }
      breakdown = `<h2>How cycles ended</h2><div class="tablewrap"><table><thead><tr><th>Exit</th><th class="r">Cycles</th><th class="r">Total P&amp;L</th><th class="r">Average</th></tr></thead><tbody>${Object.entries(g).map(([k, x]) => `<tr><td>${esc(k)}</td><td class="r">${x.n}</td><td class="r ${cls(x.pnl)}">${inr(x.pnl)}</td><td class="r ${cls(x.pnl)}">${inr(x.pnl / x.n)}</td></tr>`).join("")}</tbody></table></div>`; }
    body.innerHTML = `${kpiTiles(res)}
      <div class="card"><div class="chart-head"><h2 style="margin:0">Growth of capital</h2><div class="legend"><span><i style="background:var(--series-a)"></i>v${v.n}</span><span><i style="background:var(--series-b)"></i>${esc(benchLabel(res) === "Nifty" ? "Nifty 50" : benchLabel(res))} buy &amp; hold</span></div>
        <div class="seg" role="group" aria-label="Scale"><button type="button" data-scale="lin" aria-pressed="${!S.log}">Linear</button><button type="button" data-scale="log" aria-pressed="${S.log}">Log</button></div></div>
        <div class="chart" id="eqChart"></div><p class="subtitle">Drawdown from previous peak</p><div class="chart" id="ddChart"></div>${test.split ? `<p class="small muted">Dashed line: train/test split on ${fmtDate(test.split)}.</p>` : ""}</div>
      <div class="grid2"><div class="card"><h2>Year by year</h2><div class="tablewrap"><table><thead><tr><th>Year</th><th class="r">Strategy</th><th class="r">${esc(benchLabel(res))}</th><th class="r">Difference</th></tr></thead><tbody>${[...ys.entries()].reverse().map(([y, x]) => { const bx = yb.get(y), d = bx == null ? null : x - bx;
        return `<tr><td>${y}${test.split && String(y) >= test.split.slice(0, 4) ? ' <span class="small muted">test</span>' : ""}</td><td class="r ${cls(x)}">${pct(x)}</td><td class="r ${cls(bx)}">${pct(bx)}</td><td class="r ${cls(d)}">${d == null ? "–" : pct(d)}</td></tr>`; }).join("")}</tbody></table></div></div>
      <div class="card">${breakdown}</div></div>
      <p class="small muted">${m.start} to ${m.end}. ${v.spec.type === "rule" ? `Signals at close, fills at next open; costs ${v.spec.cost_pct}% per side.` : v.spec.type === "rotation" ? `Rebalancing at close with ${v.spec.cost_pct}% costs.` : "Model-priced with Black-Scholes and India VIX; no skew."} Stocks are today's index members for the whole period (survivorship bias).</p>`;
    drawPerf(res, test);
    body.querySelectorAll("[data-scale]").forEach((b) => b.addEventListener("click", () => { S.log = b.dataset.scale === "log"; body.querySelectorAll("[data-scale]").forEach((x) => x.setAttribute("aria-pressed", String((x.dataset.scale === "log") === S.log))); drawPerf(res, test); }));
  }
  function drawPerf(res, test) {
    const el = document.getElementById("eqChart"); if (!el) return;
    const A = { short: "Strategy", color: "var(--series-a)", values: res.eq, width: 2 }, B = { short: benchLabel(res), color: "var(--series-b)", values: res.bench || [], width: 1.6 };
    const mark = test?.split ? E.dayOf(test.split) : null;
    chart(el, res.days, res.bench ? [B, A] : [A], { height: 300, log: S.log, endLabels: true, mark, aria: "Growth of capital", fmt: inrShort, fmtEnd: inrShort, fmtTip: inr });
    chart(document.getElementById("ddChart"), res.days, res.bench ? [{ ...B, values: dd(res.bench), width: 1.2 }, { ...A, values: dd(res.eq), area: true, color: "var(--bad)", width: 1.4 }] : [{ ...A, values: dd(res.eq), area: true, color: "var(--bad)" }],
      { height: 130, zeroTop: true, endLabels: true, mark, aria: "Drawdown", fmt: (x) => minus(Math.round(x) + "%"), fmtEnd: (x) => pct(x), fmtTip: (x) => pct(x) });
  }
  const dd = (vals) => { const o = new Float64Array(vals.length); let pk = -Infinity; for (let i = 0; i < vals.length; i++) { const x = vals[i]; if (!isFinite(x)) { o[i] = NaN; continue; } pk = Math.max(pk, x); o[i] = (x / pk - 1) * 100; } return o; };
  const stressCache = new Map();
  async function tabStress(a, v, res, test, body, seq) {
    const key = specKey(v.spec, test);
    if (!stressCache.has(key)) {
      body.innerHTML = '<p class="thinking">Running stress tests: crisis replays, 1,000 Monte Carlo paths, 4 parameter variants and 2 cost shocks. This takes a few seconds on large universes<span class="dots"></span></p>';
      await new Promise((r) => setTimeout(r, 60));
      stressCache.set(key, E.stressAll(v.spec, res, res.frames, S.man.universes, { start: test.start, end: test.end }));
    }
    if (seq !== roomRenderSeq) return;
    const st = stressCache.get(key), r = st.risk, mc = st.monteCarlo;
    const tile = (k, val, b) => `<div class="kpi"><span class="k">${k}</span><span class="v">${val}</span><span class="b">${esc(b)}</span></div>`;
    const base = st.sensitivity.find((x) => x.factor === 1)?.cagr_pct ?? 0, spread = Math.max(...st.sensitivity.map((x) => Math.abs((x.cagr_pct ?? 0) - base)));
    body.innerHTML = `<div class="stats">${tile(`Beta to ${benchLabel(res)}`, n2(r.beta), `correlation ${n2(r.correlation)}`)}${tile(`If ${benchLabel(res)} falls 10%`, pct(r.nifty_fall_10_impact_pct), "expected move from beta")}${tile("1-day VaR (95%)", pct(-r.var95_daily_pct), `average of worst 5%: ${pct(-r.cvar95_daily_pct)}`)}
        ${tile("Worst month", pct(r.worst_month?.pct), r.worst_month?.month || "")}${tile("Months positive", pct(r.positive_months_pct, 0, false), `best ${pct(r.best_month?.pct)} (${r.best_month?.month || ""})`)}${tile("Longest drawdown", `${Math.round(r.longest_drawdown_days / 30.4)} mo`, `${r.longest_drawdown_days} days below a prior peak`)}</div>
      <div class="card"><h2>Crisis replays</h2><p class="small muted" style="margin:4px 0 8px">How this version behaved through past Indian market shocks.</p><div class="tablewrap"><table><thead><tr><th>Period</th><th>Dates</th><th class="r">Strategy</th><th class="r">${esc(benchLabel(res))}</th><th class="r">Strategy worst fall</th><th class="r">${esc(benchLabel(res))} worst fall</th></tr></thead><tbody>${st.crises.map((c) => c.note
        ? `<tr><td>${esc(c.name)}</td><td class="small muted">${fmtDate(c.from)} – ${fmtDate(c.to)}</td><td colspan="4" class="muted">${esc(c.note)}</td></tr>`
        : `<tr><td>${esc(c.name)}</td><td class="small muted">${fmtDate(c.from)} – ${fmtDate(c.to)}</td><td class="r ${cls(c.strategy_pct)}">${pct(c.strategy_pct)}</td><td class="r ${cls(c.nifty_pct)}">${pct(c.nifty_pct)}</td><td class="r">${pct(c.strategy_max_dd_pct)}</td><td class="r">${pct(c.nifty_max_dd_pct)}</td></tr>`).join("")}</tbody></table></div></div>
      <div class="grid2">
        <div class="card"><h2>Monte Carlo · next 12 months</h2><p class="small muted" style="margin:4px 0 8px">1,000 reshuffles of this strategy's own daily returns in 20-day blocks.</p>${mc ? `<dl class="kv"><dt>Bad year (5th percentile)</dt><dd class="${cls(mc.return_p5)}">${pct(mc.return_p5)}</dd><dt>Typical year (median)</dt><dd class="${cls(mc.return_p50)}">${pct(mc.return_p50)}</dd><dt>Good year (95th percentile)</dt><dd class="${cls(mc.return_p95)}">${pct(mc.return_p95)}</dd>
          <dt>Chance of losing money</dt><dd>${pct(mc.prob_loss_pct, 0, false)}</dd><dt>Typical worst fall</dt><dd>${pct(mc.max_dd_p50)}</dd><dt>Chance of a fall worse than 20%</dt><dd>${pct(mc.prob_dd_worse_20_pct, 1, false)}</dd></dl>` : '<p class="muted">Not enough history.</p>'}</div>
        <div class="card"><h2>Costs & slippage</h2><p class="small muted" style="margin:4px 0 8px">Same rules with trading costs doubled and tripled.</p><div class="tablewrap"><table><thead><tr><th>Scenario</th><th class="r">CAGR</th><th class="r">Worst fall</th><th class="r">Sharpe</th></tr></thead><tbody>${st.costs.map((c) => `<tr><td>${esc(c.label)}</td><td class="r ${cls(c.cagr_pct)}">${pct(c.cagr_pct)}</td><td class="r">${pct(c.max_drawdown_pct)}</td><td class="r">${n2(c.sharpe)}</td></tr>`).join("")}</tbody></table></div></div></div>
      <div class="card"><h2>Parameter sensitivity</h2><p class="small muted" style="margin:4px 0 8px">Every lookback, stop and threshold nudged ±10% and ±20%. Robust strategies change little; fragile ones swing. ${spread <= Math.max(2, Math.abs(base) * 0.35) ? '<b class="pos">Looks robust.</b>' : '<b class="neg">Results depend heavily on the exact numbers — likely overfit.</b>'}</p>
        <div class="tablewrap"><table><thead><tr><th>Variant</th><th class="r">CAGR</th><th class="r">Worst fall</th><th class="r">Sharpe</th><th class="r">Trades</th><th>Rules</th></tr></thead><tbody>${st.sensitivity.map((x) => `<tr${x.factor === 1 ? ' style="font-weight:600"' : ""}><td>${esc(x.label)}</td><td class="r ${cls(x.cagr_pct)}">${pct(x.cagr_pct)}</td><td class="r">${pct(x.max_drawdown_pct)}</td><td class="r">${n2(x.sharpe)}</td><td class="r">${x.trades ?? "–"}</td><td class="wrap small mono">${esc(x.detail)}</td></tr>`).join("")}</tbody></table></div></div>`;
  }
  function tabTrades(v, res, body) {
    const T = res.trades.slice().reverse(), LIM = 400, shown = T.slice(0, LIM); let head, rows;
    if (v.spec.type === "rule") { head = "<th>Symbol</th><th>Entry</th><th class='r'>Entry ₹</th><th>Exit</th><th class='r'>Exit ₹</th><th class='r'>Qty</th><th class='r'>P&amp;L</th><th class='r'>Return</th><th>Why</th><th class='r'>Days</th>";
      rows = shown.map((t) => t.open ? `<tr><td>${esc(t.symbol)}</td><td>${fmtDate(t.entry_date)}</td><td class="r">${px(t.entry_price)}</td><td class="muted">open</td><td></td><td class="r">${t.qty}</td><td class="r ${cls(t.unrealized)}">${inr(t.unrealized)}</td><td></td><td class="muted">still held</td><td></td></tr>`
        : `<tr><td>${esc(t.symbol)}</td><td>${fmtDate(t.entry_date)}</td><td class="r">${px(t.entry_price)}</td><td>${fmtDate(t.exit_date)}</td><td class="r">${px(t.exit_price)}</td><td class="r">${t.qty}</td><td class="r ${cls(t.pnl)}">${inr(t.pnl)}</td><td class="r ${cls(t.return_pct)}">${pct(t.return_pct)}</td><td>${esc(t.reason)}</td><td class="r">${t.bars}</td></tr>`).join(""); }
    else if (v.spec.type === "rotation") { head = "<th>Date</th><th>Symbol</th><th>Side</th><th class='r'>Qty</th><th class='r'>Price</th><th class='r'>Value</th><th class='r'>Fees</th>";
      rows = shown.map((t) => `<tr><td>${fmtDate(t.date)}</td><td>${esc(t.symbol)}</td><td class="${t.qty > 0 ? "pos" : "neg"}">${t.qty > 0 ? "Buy" : "Sell"}</td><td class="r">${Math.abs(t.qty) % 1 ? Math.abs(t.qty).toFixed(2) : Math.abs(t.qty)}</td><td class="r">${px(t.price)}</td><td class="r">${inr(Math.abs(t.qty * t.price))}</td><td class="r">${inr(t.fees)}</td></tr>`).join(""); }
    else { head = "<th>Entry</th><th>Exit</th><th>Expiry</th><th class='r'>Credit</th><th class='r'>P&amp;L</th><th>Why</th>";
      rows = shown.map((t) => `<tr><td>${fmtDate(t.entry_date)}</td><td>${fmtDate(t.exit_date)}</td><td>${fmtDate(t.expiry)}</td><td class="r">${inr(t.credit)}</td><td class="r ${cls(t.pnl)}">${inr(t.pnl)}</td><td>${esc(t.reason)}</td></tr>`).join(""); }
    body.innerHTML = `<div class="card"><h2>${v.spec.type === "rotation" ? "Orders" : v.spec.type === "option_selling" ? "Option cycles" : "Trades"} <span class="small muted" style="font-family:var(--font-body);font-weight:400">${T.length.toLocaleString("en-IN")} total${T.length > LIM ? `, latest ${LIM}` : ""}</span></h2>
      <div class="tablewrap tall">${T.length ? `<table><thead><tr>${head}</tr></thead><tbody>${rows}</tbody></table>` : '<p class="muted">No trades in this window.</p>'}</div></div>`;
  }
  function tabRules(a, v, res, test, body) {
    const s = v.spec;
    const kv = s.type === "rule" ? [["Symbols", `${esc(s.symbols.join(", "))}`], ["Entry", `<code>${esc(s.entry)}</code>`], ["Exit", s.exit ? `<code>${esc(s.exit)}</code>` : "stop / target only"], ["Side", s.side], ["Stop loss", s.stop_loss_pct ? s.stop_loss_pct + "%" : "none"], ["Take profit", s.take_profit_pct ? s.take_profit_pct + "%" : "none"], ["Position size", s.position_size_pct + "% of each symbol's share"]]
      : s.type === "rotation" ? [["Universe", esc(Array.isArray(s.universe) ? s.universe.join(", ") : s.universe)], ["Ranking", esc(rankWords(s))], ["Score floor", s.min_score == null ? "none" : s.min_score], ["Trend filter", s.trend_filter ? `${s.trend_filter.symbol} above ${s.trend_filter.sma}-day average` : "none"]]
      : [["Underlying", `${s.underlying} (${s.expiry}, lot ${s.lot_size} × ${s.lots})`], ["Structure", s.structure], ["Strikes", s.strike_mode === "delta" ? s.delta + " delta" : s.otm_pct + "% OTM"], ["Wings", s.structure === "iron_condor" ? s.wing_width + " pts" : "—"], ["Stop", s.stop_loss_mult ? s.stop_loss_mult + "× credit" : "none"], ["Target", s.profit_target_pct ? s.profit_target_pct + "%" : "none"], ["VIX filter", `${s.min_vix ?? "–"} to ${s.max_vix ?? "–"}`]];
    kv.push(...extraKV(s));
    kv.push(["Capital", inr(s.capital)], ["Test window", `${fmtDate(test.start)} – ${test.end ? fmtDate(test.end) : "latest"}${test.split ? `, split ${fmtDate(test.split)}` : ", no split"}`]);
    const ids = S.room.versions.map((x) => x.by); names(ids);
    body.innerHTML = `<div class="card stack"><div class="row"><h2>Rules · v${v.n}</h2><span class="grow"></span><span class="small muted">by ${esc(nameOf(v.by))} · ${esc(fmtWhen(v.at))}</span></div>
        ${v.meta?.explanation ? `<p>${esc(v.meta.explanation)}</p>` : ""}<dl class="kv">${kv.map(([k, x]) => `<dt>${k}</dt><dd>${x}</dd>`).join("")}</dl>
        ${v.meta?.assumptions?.length ? `<ul class="small muted" style="margin:0;padding-left:18px">${v.meta.assumptions.map((x) => `<li>${esc(x)}</li>`).join("")}</ul>` : ""}
        <details><summary class="small" style="cursor:pointer">Edit the rules directly</summary><div class="stack" style="margin-top:10px">
          <div class="row"><div class="field"><label for="edStart">Test from</label><input class="input" type="date" id="edStart" value="${esc(test.start || "2012-01-01")}"></div><div class="field"><label for="edEnd">To</label><input class="input" type="date" id="edEnd" value="${esc(test.end || "")}"></div><div class="field"><label for="edSplit">Train until / test from</label><input class="input" type="date" id="edSplit" value="${esc(test.split || "")}"></div></div>
          <textarea class="input mono" id="edSpec" rows="12" spellcheck="false">${esc(JSON.stringify(s, null, 2))}</textarea>
          <div class="field"><label for="edNote">What changed</label><input class="input" id="edNote" placeholder="e.g. tightened stop to 5%"></div>
          <div class="row"><button class="btn" type="button" id="edSave" ${S.readOnly ? "disabled" : ""}>Save as v${(a.version || 1) + 1}</button><span class="status" id="edStatus"></span></div></div></details></div>
      <div class="card"><h2>Version history</h2><p class="small muted" style="margin:4px 0 6px">Every change is kept with its results. Open any version from the selector above.</p><div class="versions">${S.room.versions.slice().reverse().map((x) => `<div class="ver ${x.n === a.version ? "cur" : ""}"><span class="n">v${x.n}</span>
        <div><b>${esc(x.note || "")}</b><div class="small muted">${esc(nameOf(x.by))} · ${esc(fmtWhen(x.at))}${a.paper?.version === x.n ? ' · <span class="pill paper">paper</span>' : ""}</div></div>
        <div class="small r num">CAGR ${pct(x.headline?.cagr)} · worst ${pct(x.headline?.mdd)}${x.headline?.test_cagr != null ? ` · test ${pct(x.headline.test_cagr)}` : ""}<br><button class="btn ghost small" type="button" data-view-ver="${x.n}" style="margin-top:4px">View</button></div></div>`).join("")}</div></div>`;
    body.querySelectorAll("[data-view-ver]").forEach((b) => b.addEventListener("click", () => { S.room.ver = +b.dataset.viewVer; S.room.tab = "overview"; renderRoomHead(); renderRoomBody(); }));
    $("edSave").addEventListener("click", async () => {
      const st = $("edStatus"); st.classList.remove("err"); st.textContent = "Testing…";
      try { const spec = E.normalize(JSON.parse($("edSpec").value), S.man.universes);
        const t2 = { start: $("edStart").value || "2012-01-01", end: $("edEnd").value && $("edEnd").value < S.lastDay ? $("edEnd").value : null, split: $("edSplit").value || null };
        const n = await saveVersion(a, { spec, meta: v.meta || {}, test: t2, note: $("edNote").value.trim() || "Edited rules" }); S.room.ver = n; st.textContent = `Saved as v${n}.`; }
      catch (e) { st.classList.add("err"); st.textContent = e instanceof SyntaxError ? "That isn't valid JSON: " + e.message : (e.message || String(e)); }
    });
  }

  // ---------------------------------------------------------------- agent chat
  function renderRoomLog() {
    const log = $("roomLog"), msgs = S.room.messages; names(msgs.map((m) => m.by));
    log.innerHTML = msgs.length ? msgs.map((m) => {
      if (m.role === "system") return `<div class="msg system"><div class="body">${esc(m.text)} <span class="muted">· ${esc(fmtWhen(m.at))}</span></div></div>`;
      const who = m.role === "user" ? nameOf(m.by) : curAgent()?.name || "Agent";
      let prop = "";
      if (m.proposal) { const pr = m.proposal; prop = `<div class="proposal" style="margin-top:6px;padding:10px"><b>Proposed change</b><p class="small">${esc(pr.note || "")}</p><div data-chatres="${esc(m.id)}" class="small muted">${pr.status === "saved" ? `Saved as v${pr.saved_version}.` : pr.status === "discarded" ? "Discarded." : "Testing…"}</div>
        ${pr.status ? "" : `<div class="row"><button class="btn small" type="button" data-save-prop="${esc(m.id)}" ${S.readOnly ? "disabled" : ""}>Save as new version</button><button class="btn ghost small" type="button" data-drop-prop="${esc(m.id)}">Discard</button></div>`}</div>`; }
      return `<div class="msg ${m.role === "user" ? "user" : ""}"><div class="meta">${esc(who)} · ${esc(fmtWhen(m.at))}</div><div class="body">${md(m.text)}${m.attachments?.length ? `<div class="attach-row" style="margin-top:6px">${m.attachments.map((x) => `<span class="att"><span>📎 ${esc(x)}</span></span>`).join("")}</div>` : ""}${prop}</div></div>`;
    }).join("") : `<p class="small muted">Ask this agent anything — how it behaved in 2020, why a stock is in the list, what to change. It can propose edits and you decide whether to keep them.</p>`;
    log.scrollTop = log.scrollHeight;
    for (const m of msgs) if (m.proposal && !m.proposal.status) fillChatProposal(m);
    log.querySelectorAll("[data-save-prop]").forEach((b) => b.addEventListener("click", async () => {
      const m = S.room.messages.find((x) => x.id === b.dataset.saveProp), a = curAgent(); if (!m || !a) return; b.disabled = true;
      try { const cur = S.room.versions.find((x) => x.n === a.version) || {}; const spec = E.normalize(m.proposal.spec, S.man.universes);
        const n = await saveVersion(a, { spec, meta: { ...(cur.meta || {}), explanation: m.proposal.explanation || cur.meta?.explanation || "" }, test: m.proposal.test || cur.test || { start: "2012-01-01" }, note: m.proposal.note });
        await S.db.doc(`agents/${a.id}/messages/${m.id}`).update({ proposal: { ...m.proposal, status: "saved", saved_version: n } }); S.room.ver = n; renderRoomHead(); renderRoomBody(); }
      catch (e) { b.disabled = false; toast(e.message || String(e)); } }));
    log.querySelectorAll("[data-drop-prop]").forEach((b) => b.addEventListener("click", async () => { const m = S.room.messages.find((x) => x.id === b.dataset.dropProp); if (!m) return;
      try { await S.db.doc(`agents/${S.room.id}/messages/${m.id}`).update({ proposal: { ...m.proposal, status: "discarded" } }); } catch (e) { toast(e.message || String(e)); } }));
  }
  async function fillChatProposal(m) {
    const box = document.querySelector(`[data-chatres="${CSS.escape(m.id)}"]`), a = curAgent(); if (!box || !a) return;
    try { const cur = S.room.versions.find((x) => x.n === a.version) || {}, spec = E.normalize(m.proposal.spec, S.man.universes), test = m.proposal.test || cur.test || { start: "2012-01-01" };
      const res = await runSpec(spec, test), h = headline(res, test), o = cur.headline || {};
      box.innerHTML = `<table><thead><tr><th></th><th class="r">v${a.version}</th><th class="r">Proposed</th></tr></thead><tbody><tr><td>CAGR</td><td class="r">${pct(o.cagr)}</td><td class="r">${pct(h.cagr)}</td></tr><tr><td>Worst fall</td><td class="r">${pct(o.mdd)}</td><td class="r">${pct(h.mdd)}</td></tr><tr><td>Sharpe</td><td class="r">${n2(o.sharpe)}</td><td class="r">${n2(h.sharpe)}</td></tr>${h.test_cagr != null ? `<tr><td>Test CAGR</td><td class="r">${pct(o.test_cagr)}</td><td class="r">${pct(h.test_cagr)}</td></tr>` : ""}</tbody></table>${specDiff(cur.spec || {}, spec)}`; }
    catch (e) { box.innerHTML = `<span class="neg">${esc(e.message || e)}</span>`; }
  }
  function agentPrompt(a, v, res, stats, text, atts) {
    const hist = S.room.messages.filter((m) => m.role !== "system").slice(-12).map((m) => `${m.role === "user" ? "USER" : "YOU"}: ${m.text}${m.proposal ? ` [proposed: ${m.proposal.note}; ${m.proposal.status || "pending"}]` : ""}`).join("\n\n");
    const trades = (res.trades || []).slice(-12).map((t) => t.symbol ? `${t.symbol} ${t.entry_date || t.date}→${t.exit_date || ""} ${t.return_pct != null ? t.return_pct.toFixed(1) + "%" : ""} ${t.reason || t.note || ""}` : `${t.entry_date}→${t.exit_date} pnl ${Math.round(t.pnl)} ${t.reason}`);
    return `You are "${a.name}", one agent inside TradeOS (an AI investment desk for Indian markets). You are the portfolio manager and quant responsible for this single strategy. Speak in the first person about your rules and results. Be candid about weaknesses, explain with numbers, and think like an experienced trader and risk manager. Research only, not investment advice.

When the user wants a change (stocks, numbers, rules, test window), return a "proposal" containing the FULL new spec (not a patch), a one-line note, an updated explanation, and the test window. Check it first with the backtest tool when available, and say honestly whether it helps. For questions, proposal = null. Never invent data you weren't given.

${SCHEMAS}

MY CURRENT VERSION: v${v.n} (${a.status}${a.paper ? `; paper trading v${a.paper.version} since ${a.paper.since}` : ""})
SPEC: ${JSON.stringify(v.spec)}
TEST WINDOW: ${JSON.stringify(v.test || {})}
EXPLANATION: ${v.meta?.explanation || ""}
RESULTS: ${JSON.stringify(compactRes(res, v.test))}
RISK & STRESS: ${JSON.stringify(stats)}
YEARLY RETURNS (strategy vs ${benchLabel(res)}): ${JSON.stringify([...yearly(res.days, res.eq).entries()].map(([y, r]) => [y, +r.toFixed(1), res.bench ? +(yearly(res.days, res.bench).get(y) ?? 0).toFixed(1) : null]))}
RECENT TRADES: ${trades.join(" | ")}
TODAY'S SIGNALS: ${JSON.stringify(res.signals.slice(0, 15))}
VERSION HISTORY: ${JSON.stringify(S.room.versions.map((x) => ({ n: x.n, note: x.note, cagr: x.headline?.cagr, mdd: x.headline?.mdd })))}

${dataBrief()}

REPLY with ONE JSON object: {"reply":"markdown","proposal":null or {"note":"...","spec":{...},"explanation":"...","test":{"start":"...","end":null,"split":"..."}}}

CONVERSATION:
${hist || "(new)"}

USER NOW: ${text}${attachmentText(atts)}`;
  }
  async function sendRoom() {
    const a = curAgent(), v = curVersion(), text = $("roomInput").value.trim();
    if (!a || !v || S.busyRoom || (!text && !S.roomAttach.length)) return;
    const atts = S.roomAttach.splice(0); renderAttach(S.roomAttach, $("roomAttach")); $("roomInput").value = "";
    S.busyRoom = true; $("roomSend").disabled = true; const st = $("roomStatusLine"); st.classList.remove("err"); st.innerHTML = '<span class="thinking">Thinking<span class="dots"></span></span>';
    try {
      await addAgentMsg(a.id, { role: "user", text: text || "(see attachment)", attachments: atts.map((x) => x.name) });
      const test = v.test || { start: "2012-01-01" }, res = await runSpec(v.spec, test);
      const risk = E.riskStats(res), cr = E.crises(res).map((c) => ({ name: c.name, s: c.strategy_pct, n: c.nifty_pct }));
      const out = await callClaude(agentPrompt(a, v, res, { risk, crises: cr }, text || "Please look at the attachment.", atts), imagesOf(atts), (msg) => { st.innerHTML = `<span class="thinking">${esc(msg)}<span class="dots"></span></span>`; }, new AbortController().signal);
      const msg = { role: "agent", text: typeof out?.reply === "string" ? out.reply : "…" };
      if (out?.proposal && out.proposal.spec) { try { E.normalize(out.proposal.spec, S.man.universes); msg.proposal = { note: String(out.proposal.note || "Change"), spec: out.proposal.spec, explanation: String(out.proposal.explanation || ""), test: out.proposal.test || v.test || null, status: null }; }
        catch (e) { msg.text += `\n\n_(My proposed rules didn't validate: ${e.message})_`; } }
      await addAgentMsg(a.id, msg); st.textContent = "";
    } catch (e) { st.classList.add("err"); st.textContent = claudeError(e); }
    finally { S.busyRoom = false; $("roomSend").disabled = false; }
  }

  // ================================================================ charts
  function niceTicks(lo, hi, count) { const span = hi - lo || Math.abs(hi) || 1, s0 = span / count, mag = Math.pow(10, Math.floor(Math.log10(s0))), e = s0 / mag, step = (e >= 7.5 ? 10 : e >= 3.5 ? 5 : e >= 1.5 ? 2 : 1) * mag, out = [];
    for (let v = Math.ceil(lo / step) * step; v <= hi + step * 1e-9; v += step) out.push(+v.toFixed(10)); return out; }
  function logTicks(lo, hi) { const out = []; for (let e = Math.floor(Math.log10(lo)); e <= Math.ceil(Math.log10(hi)); e++) for (const c of [1, 2, 5]) { const v = c * 10 ** e; if (v >= lo && v <= hi) out.push(v); } return out.length > 7 ? out.filter((v) => /^1/.test(String(v))) : out; }
  function chart(el, days, series, opt) {
    const W = Math.max(300, el.clientWidth || 600), H = opt.height, padL = 64, padR = opt.endLabels ? (W < 520 ? 76 : 110) : 16, padT = 10, padB = 24, x0 = days[0], x1 = days[days.length - 1], iw = W - padL - padR, ih = H - padT - padB;
    let lo = Infinity, hi = -Infinity; for (const s of series) for (const v of s.values) if (isFinite(v)) { lo = Math.min(lo, v); hi = Math.max(hi, v); }
    if (!isFinite(lo)) { el.innerHTML = ""; return; }
    if (opt.zeroTop) hi = 0;
    const useLog = opt.log && lo > 0;
    if (!useLog) { const p = (hi - lo) * 0.05 || 1; lo -= p; hi = opt.zeroTop ? 0 : hi + p; }
    const fy = useLog ? (v) => padT + ih - (Math.log(v) - Math.log(lo)) / (Math.log(hi) - Math.log(lo)) * ih : (v) => padT + ih - (v - lo) / (hi - lo) * ih, fx = (d) => padL + (d - x0) / (x1 - x0 || 1) * iw;
    const yt = useLog ? logTicks(lo, hi) : niceTicks(lo, hi, 4);
    const y0 = new Date(x0 * 864e5).getUTCFullYear(), y1 = new Date(x1 * 864e5).getUTCFullYear(), span = x1 - x0;
    let xt = [];
    if (span < 400) { const d0 = new Date(x0 * 864e5); for (let k = 1; k <= 14; k++) { const t = Date.UTC(d0.getUTCFullYear(), d0.getUTCMonth() + k, 1) / 864e5; if (t > x1) break; xt.push([new Date(t * 864e5).toLocaleDateString("en-IN", { month: "short", timeZone: "UTC" }), t]); } const ev = Math.ceil(xt.length / Math.max(2, Math.floor(iw / 60))); xt = xt.filter((_, i) => i % ev === 0); }
    else { const every = Math.max(1, Math.ceil((y1 - y0 + 1) / Math.max(2, Math.floor(iw / 70)))); for (let y = y0 + 1; y <= y1; y++) if ((y - y0 - 1) % every === 0) xt.push([y, Date.UTC(y, 0, 1) / 864e5]); }
    const step = Math.max(1, Math.floor(days.length / (iw * 1.5)));
    const path = (vals) => { let d = "", pen = false; for (let i = 0; i < days.length; i += (i + step < days.length ? step : 1)) { const v = vals[i]; if (!isFinite(v) || (useLog && v <= 0)) { pen = false; continue; } d += (pen ? "L" : "M") + fx(days[i]).toFixed(1) + " " + fy(v).toFixed(1); pen = true; } return d; };
    let svg = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(opt.aria)}"><g class="grid">${yt.map((v) => `<line x1="${padL}" x2="${W - padR}" y1="${fy(v).toFixed(1)}" y2="${fy(v).toFixed(1)}"/>`).join("")}</g>`;
    svg += `<g class="axis">${yt.map((v) => `<text x="${padL - 8}" y="${(fy(v) + 4).toFixed(1)}" text-anchor="end">${opt.fmt(v)}</text>`).join("")}${xt.map(([y, d]) => `<text x="${fx(d).toFixed(1)}" y="${H - 6}" text-anchor="middle">${y}</text>`).join("")}</g>`;
    if (opt.mark && opt.mark > x0 && opt.mark < x1) svg += `<line x1="${fx(opt.mark).toFixed(1)}" x2="${fx(opt.mark).toFixed(1)}" y1="${padT}" y2="${padT + ih}" stroke="var(--muted)" stroke-dasharray="4 4" stroke-width="1"/>`;
    for (const s of series) { if (s.area) svg += `<path d="${path(s.values)} L${fx(x1).toFixed(1)} ${fy(0).toFixed(1)} L${fx(x0).toFixed(1)} ${fy(0).toFixed(1)} Z" fill="var(--dd-fill)" stroke="none"/>`;
      svg += `<path d="${path(s.values)}" fill="none" stroke="${s.color}" stroke-width="${s.width || 2}" stroke-linejoin="round" stroke-linecap="round"/>`; }
    if (opt.endLabels) { const ends = series.map((s) => ({ s, v: s.values[s.values.length - 1] })).filter((e) => isFinite(e.v)).map((e) => ({ ...e, y: fy(e.v) })).sort((a, b) => a.y - b.y);
      for (let i = 1; i < ends.length; i++) if (ends[i].y - ends[i - 1].y < 26) ends[i].y = ends[i - 1].y + 26;
      for (const e of ends) svg += `<circle cx="${fx(x1).toFixed(1)}" cy="${fy(e.v).toFixed(1)}" r="4" fill="${e.s.color}" stroke="var(--surface)" stroke-width="2"/><text class="endlabel" x="${(fx(x1) + 10).toFixed(1)}" y="${(e.y - 1).toFixed(1)}">${esc(e.s.short)}</text><text class="endlabel" x="${(fx(x1) + 10).toFixed(1)}" y="${(e.y + 12).toFixed(1)}" style="font-weight:500;fill:var(--muted)">${opt.fmtEnd(e.v)}</text>`; }
    svg += `<line class="xh" x1="0" x2="0" y1="${padT}" y2="${padT + ih}" stroke="var(--muted)" stroke-dasharray="3 3" visibility="hidden"/>` + series.map((s, i) => `<circle class="dot${i}" r="4.5" fill="${s.color}" stroke="var(--surface)" stroke-width="2" visibility="hidden"/>`).join("");
    svg += `<rect x="${padL}" y="${padT}" width="${Math.max(0, iw)}" height="${ih}" fill="transparent" style="cursor:crosshair"/></svg><div class="tip" hidden></div>`;
    el.innerHTML = svg;
    const svgEl = el.querySelector("svg"), tip = el.querySelector(".tip"), xh = el.querySelector(".xh");
    const hide = () => { tip.hidden = true; xh.setAttribute("visibility", "hidden"); series.forEach((_, i) => el.querySelector(".dot" + i).setAttribute("visibility", "hidden")); };
    svgEl.addEventListener("pointerleave", hide);
    svgEl.addEventListener("pointermove", (ev) => {
      const r = svgEl.getBoundingClientRect(), sx = (ev.clientX - r.left) * W / r.width; if (sx < padL || sx > W - padR) { hide(); return; }
      const d = x0 + (sx - padL) / iw * (x1 - x0); let a = 0, b = days.length - 1; while (b - a > 1) { const mid = (a + b) >> 1; if (days[mid] < d) a = mid; else b = mid; }
      const i = Math.abs(days[a] - d) < Math.abs(days[b] - d) ? a : b, X = fx(days[i]);
      xh.setAttribute("x1", X); xh.setAttribute("x2", X); xh.setAttribute("visibility", "visible");
      series.forEach((s, k) => { const c = el.querySelector(".dot" + k), v = s.values[i]; if (isFinite(v) && (!useLog || v > 0)) { c.setAttribute("cx", X); c.setAttribute("cy", fy(v)); c.setAttribute("visibility", "visible"); } else c.setAttribute("visibility", "hidden"); });
      tip.innerHTML = `<b>${fmtDate(E.isoOf(days[i]))}</b>` + series.map((s) => `<div class="rowx"><i style="background:${s.color}"></i>${esc(s.short)}: <b>${opt.fmtTip(s.values[i])}</b></div>`).join("");
      tip.hidden = false; const pxl = X / W * r.width, tw = tip.offsetWidth; tip.style.left = Math.min(Math.max(0, pxl + 12), r.width - tw) + "px"; tip.style.top = "6px";
    });
  }

  // ================================================================ router
  function wireGo(root) { root.querySelectorAll("[data-go]").forEach((b) => b.addEventListener("click", () => go(b.dataset.go === "main" ? "" : b.dataset.go))); }
  function go(hash) { if (location.hash.slice(1) === hash) route(); else location.hash = hash; }
  function route() {
    const h = location.hash.slice(1);
    const view = h.startsWith("agent-") ? "room" : h === "agents" ? "agents" : h === "signals" ? "signals" : "main";
    for (const v of ["main", "agents", "signals", "room"]) $("view-" + v).hidden = v !== view;
    document.querySelectorAll(".nav button").forEach((b) => b.setAttribute("aria-current", b.dataset.view === (view === "room" ? "agents" : view) ? "page" : "false"));
    S.view = view;
    if (view === "room") { const id = h.slice(6); if (S.room.id !== id) openRoom(id); else { renderRoomHead(); renderRoomBody(); } }
    else { S.room.unsubs.forEach((u) => u()); S.room.unsubs = []; S.room.id = null; }
    if (view === "agents") renderFleet(); if (view === "signals") renderSignals(); if (view === "main") { S.suppressScroll = false; renderMain(); }
    window.scrollTo({ top: view === "main" ? document.body.scrollHeight : 0 });
  }

  // ================================================================ boot
  document.querySelectorAll(".nav button").forEach((b) => b.addEventListener("click", () => go(b.dataset.view === "main" ? "" : b.dataset.view)));
  wireGo(document);
  $("sendBtn").addEventListener("click", () => sendMain($("mainInput").value));
  $("stopBtn").addEventListener("click", () => mainCtl && mainCtl.abort());
  $("mainInput").addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendMain($("mainInput").value); } });
  $("mainInput").addEventListener("input", (e) => autoGrow(e.target));
  $("mainInput").addEventListener("paste", (e) => { const files = [...(e.clipboardData?.files || [])]; if (files.length) { e.preventDefault(); readFiles(files, S.mainAttach, $("attachList")); } });
  $("fileIn").addEventListener("change", (e) => { readFiles([...e.target.files], S.mainAttach, $("attachList")); e.target.value = ""; });
  $("roomFile").addEventListener("change", (e) => { readFiles([...e.target.files], S.roomAttach, $("roomAttach")); e.target.value = ""; });
  $("roomSend").addEventListener("click", sendRoom);
  $("roomInput").addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendRoom(); } });
  $("roomVersion").addEventListener("change", (e) => { S.room.ver = +e.target.value; renderRoomBody(); });
  $("roomTabs").addEventListener("click", (e) => { const b = e.target.closest("button[data-tab]"); if (!b) return; S.room.tab = b.dataset.tab; renderRoomBody(); });
  $("fleetFilter").addEventListener("click", (e) => { const b = e.target.closest("button[data-f]"); if (!b) return; fleetFilter = b.dataset.f; $("fleetFilter").querySelectorAll("button").forEach((x) => x.setAttribute("aria-pressed", String(x === b))); renderFleet(); });
  let rsT; window.addEventListener("resize", () => { clearTimeout(rsT); rsT = setTimeout(() => { if (S.view === "room" && S.room.tab === "performance") renderRoomBody(); }, 200); });

  (async () => {
    try { await loadBase(); } catch (e) { $("mainStatus").textContent = e.message; $("mainStatus").classList.add("err"); return; }
    const use = async (n) => { try { return window.claude && window.claude.use ? await window.claude.use(n) : null; } catch (e) { return null; } };
    const [db, user, sample] = await Promise.all([use("db"), use("user"), use("sample")]);
    S.db = db || MemDB(); S.memMain = MemDB().collection("main");
    S.user = user; S.sample = sample;
    if (sample) { try { const lim = await sample.limits(); S.tools = !!lim.tools; S.images = lim.images || null; } catch (e) { /* no limits */ } }
    if (user) { S.me = await user.me(); S.uid = S.me.id; const w = await user.can("data.write"); S.readOnly = w === false;
      $("whoami").innerHTML = `<img alt="" src="${esc(S.me.avatarUrl)}"><span>${esc(S.me.name || "you")}</span>`; }
    if (!db) toast("Shared storage isn't available in this view — changes won't be saved.");
    if (!sample) $("mainHint").textContent = "Talking to agents needs Claude, which isn't available in this view.";
    if (S.readOnly) $("mainHint").textContent = "You have view-only access: you can explore agents but not change them.";
    S.db.collection("agents").onSnapshot((snap) => {
      S.agents = new Map(snap.docs.map((d) => [d.id, { id: d.id, ...d.data() }])); renderRail();
      $("agentCount").textContent = [...S.agents.values()].filter((a) => a.status !== "retired").length;
      if (S.view === "agents") renderFleet(); if (S.view === "room") renderRoomHead();
      if (S.view === "signals") renderSignals(); else refreshSigCount();
    }, () => toast("Couldn't load agents."));
    mainCol().orderBy("at").limit(300).onSnapshot((snap) => { S.mainMsgs = snap.docs.map((d) => ({ id: d.id, ...d.data() })).filter((m) => m.kind === "main"); if (S.view === "main") renderMain(); });
    route();
    window.addEventListener("hashchange", route);
  })();
  let sigT;
  function refreshSigCount() { clearTimeout(sigT); sigT = setTimeout(async () => { let n = 0; for (const a of [...S.agents.values()].filter((x) => x.status === "paper")) { try { const p = await paperResult(a); n += (p?.signals || []).filter((s) => isAction(s)).length; } catch (e) { /* ignore */ } } $("sigCount").textContent = String(n); $("sigCount").classList.toggle("hot", n > 0); }, 400); }
