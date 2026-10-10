  // ================================================================ DAILY-LIST SYSTEMS (strategy type "watchlist")
  // The team sends names; the system calls BUY / SELL / HOLD on the latest close with its named conditions, the desk turns
  // the calls into paper orders for the next open, and the record of every list sent teaches it better settings.
  const todayIST = () => new Date(Date.now() + 5.5 * 3600e3).toISOString().slice(0, 10);
  const sessionDays = () => Array.from(S.light.NIFTY?.d || []).filter((d) => d <= E.dayOf(S.lastDay));
  const learnedOver = (a) => a.auto_learn && a.learned?.params ? a.learned.params : null;
  const liveNames = (a, spec) => E.watchLive(a.inbox_log || [], sessionDays(), spec.list_days, true);
  function heldOf(a) {
    const sl = S.bookState?.sleeves?.[a.id], out = {};
    for (const [s, p] of Object.entries(sl?.positions || {})) if (p.qty) out[s] = { qty: p.qty, avg: p.avg, since: p.since || S.lastDay };
    return out;
  }
  async function watchCalls(a, spec, onProgress) {
    const list = liveNames(a, spec), held = heldOf(a);
    const frames = await framesFor(spec, onProgress, [...list, ...(spec.symbols || []), ...Object.keys(held)]);
    const rows = E.watchSignals(spec, frames, { list, held, over: learnedOver(a) });
    return { rows, list, held, frames };
  }
  // tickers out of anything pasted: "RELIANCE, TRENT\nbse" or "NSE:TATAMOTORS"; company names resolve when unambiguous
  function parseNames(text) {
    const toks = String(text || "").toUpperCase().replace(/\b(NSE|BSE)\s*:/g, "").split(/[\s,;|/]+/).map((t) => t.replace(/^[^A-Z0-9&]+|[^A-Z0-9&-]+$/g, "")).filter((t) => t.length >= 2 && t.length <= 24);
    const known = [], unknown = [];
    for (const t of toks) {
      const k = E.symKey(t);
      if (S.man.symbols[k] && S.man.symbols[k].kind === "stock") { if (!known.includes(k)) known.push(k); continue; }
      const hits = Object.entries(S.man.symbols).filter(([, m]) => m.kind === "stock" && String(m.name || "").toUpperCase().startsWith(t));
      if (hits.length === 1) { if (!known.includes(hits[0][0])) known.push(hits[0][0]); } else unknown.push(t);
    }
    return { known, unknown };
  }
  // Save a list for today (replace or add). Returns the saved entry.
  async function saveList(a, syms, mode = "replace") {
    const d = todayIST(), log = (a.inbox_log || []).map((x) => ({ ...x })), i = log.findIndex((x) => x.date === d);
    const prev = i >= 0 ? log[i].syms : [], next = mode === "add" ? [...new Set([...prev, ...syms])] : [...new Set(syms)];
    const ent = { date: d, syms: next, by: S.uid, at: nowIso() };
    if (i >= 0) log[i] = ent; else log.push(ent);
    log.sort((x, y) => x.date.localeCompare(y.date));
    a.inbox_log = log.slice(-400);
    await patchAgent(a.id, { inbox_log: a.inbox_log, inbox: { date: d, syms: next } });
    return ent;
  }
  // When names arrive after the close (or on a holiday), the calls on the latest close become orders for the next open at once,
  // instead of waiting for the evening run. Orders made earlier the same way for names no longer called are cancelled.
  async function ordersNow(a, spec, rows) {
    const sl = S.bookState?.sleeves?.[a.id], desk = a.desk_id && S.desks.get(a.desk_id), ns = nextSessionIso();
    if (a.status !== "paper" || !sl || !desk || (desk.status || "active") !== "active" || S.bookCfg?.kill_switch) return { made: 0, why: !sl ? "after tonight's run (the desk opens this system's capital then)" : "after tonight's run" };
    if (ns <= todayIST()) return { made: 0, why: "after tonight's run, from today's close" };
    const plan = O.agentTargets(a, spec, { watch: rows }, O.sleeveEquity(sl, pxFn), pxFn, S.man.symbols, ns);
    const built = O.buildOrders({ state: JSON.parse(JSON.stringify(S.bookState)), book: S.bookCfg || {}, desks: [...S.desks.values()], agents: [...S.agents.values()], plans: { [a.id]: plan }, px: pxFn, meta: S.man.symbols, date: S.lastDay, nextSession: ns });
    const mine = built.orders.filter((o) => o.agent === a.id), have = new Map(S.ordersList.filter((o) => o.agent === a.id && o.session === ns).map((o) => [o.id, o]));
    let made = 0, cancelled = 0;
    for (const o of mine) if (!have.has(o.id)) { await S.db.doc(`orders/${o.id}`).set({ ...o, created_at: nowIso(), by_app: true, by: S.uid }); made++; }
    const keep = new Set(mine.map((o) => o.id));
    for (const [id, o] of have) if (o.by_app && !keep.has(id) && ["pending", "approved"].includes(o.status)) { await S.db.doc(`orders/${id}`).update({ status: "cancelled", note: "no longer called on the latest list" }); cancelled++; }
    return { made, cancelled, session: ns };
  }

  // ---------------------------------------------------------------- room: Today · Record · Settings
  const WATCH_TABS = [["today", "Today"], ["record", "Record"], ["rules", "Settings"]];
  const condChip = (c) => `<span class="cond ${c.on ? "on" : ""}" title="${esc(c.label)}">${c.on ? "✓" : "·"} ${esc(c.label)}${c.value != null ? ` <b>${esc(n2c(c.value))}${esc(c.unit || "")}</b>` : ""}</span>`;
  const n2c = (x) => x == null ? "–" : Math.abs(x) >= 100 ? Math.round(x).toLocaleString("en-IN") : (+x.toFixed(2)).toString();
  async function renderWatchRoom(a, v, body, seq, tab) {
    let spec; try { spec = E.normalize(v.spec, S.man.universes); } catch (e) { body.innerHTML = `<p class="flag">${esc(e.message || e)}</p>`; return; }
    if (tab === "record") return watchRecord(a, v, spec, body, seq);
    if (tab === "rules") return watchSettings(a, v, spec, body);
    return watchToday(a, v, spec, body, seq);
  }
  async function watchToday(a, v, spec, body, seq) {
    const ro = S.readOnly, today = todayIST(), todays = (a.inbox_log || []).find((x) => x.date === today);
    const sl = S.bookState?.sleeves?.[a.id], desk = a.desk_id && S.desks.get(a.desk_id), ns = nextSessionIso();
    const head = `<div class="card wl-in"><div class="row"><h2>Today's names</h2><span class="grow"></span><span class="xs muted">${todays ? `${todays.syms.length} sent today` : "none sent today yet"} · calls use the ${esc(fmtDate(S.lastDay))} close</span></div>
      ${ro ? "" : `<form id="wlForm" class="wl-form"><textarea class="input" id="wlNames" rows="2" placeholder="Paste or type names — RELIANCE, TRENT, BSE…" aria-label="Today's names"></textarea>
        <div class="row"><button class="btn" type="submit" data-mode="replace">Run on these</button><button class="btn ghost" type="button" id="wlAdd">Add to today's list</button><span class="status" id="wlStatus"></span></div></form>`}
      <div class="namechips" id="wlChips"></div></div>`;
    const notOn = a.status !== "paper" || !desk || !a.alloc_pct;
    const deskOpts = [...S.desks.values()].filter((d) => (d.status || "active") !== "halted").map((d) => `<option value="${esc(d.id)}" ${d.id === a.desk_id ? "selected" : ""}>${esc(d.name)}</option>`).join("");
    const start = notOn && !ro ? `<div class="banner wl-start"><span>${a.status !== "paper" ? "Calls only — no orders yet." : "Paper trading, but not on a desk with capital — no orders yet."} Put it on a desk to send orders:</span>
      ${S.desks.size ? `<select class="input" id="wlDesk" aria-label="Desk">${deskOpts}</select><input class="input alloc" id="wlAlloc" type="number" min="1" max="100" value="${a.alloc_pct || 100}" aria-label="Share of the desk (%)"><span class="xs">% of desk</span><button class="btn small" type="button" id="wlGo">Start paper orders</button>` : '<button class="btn small" type="button" data-go="desks">Create a desk</button>'}</div>` : "";
    body.innerHTML = head + start + `<div id="wlCalls"><p class="thinking">Reading the latest close<span class="dots"></span></p></div>`;
    wireGo(body);
    let w; try { w = await watchCalls(a, spec, (d, n) => { const el = $("wlCalls"); if (el && seq === roomRenderSeq) el.innerHTML = `<p class="muted">Loading prices ${d} of ${n}…</p>`; }); }
    catch (e) { $("wlCalls").innerHTML = `<p class="flag">${esc(e.message || e)}</p>`; return; }
    if (seq !== roomRenderSeq) return;
    const plan = sl && a.status === "paper" ? O.agentTargets(a, spec, { watch: w.rows }, O.sleeveEquity(sl, pxFn), pxFn, S.man.symbols, ns) : null;
    const todays2 = new Set(todays?.syms || []);
    $("wlChips").innerHTML = w.list.length ? w.list.map((s) => `<span class="namechip">${esc(s)}${todays2.has(s) && !ro ? `<button type="button" data-rmname="${esc(s)}" aria-label="Remove ${esc(s)}">✕</button>` : ""}</span>`).join("") : '<span class="xs muted">No names are live. Send today\'s list above — names count for ' + spec.list_days + ' session' + (spec.list_days > 1 ? "s" : "") + '.</span>';
    const orderCell = (r) => { if (!plan) return ""; const t = plan.targets[r.symbol], cur = r.qty || 0; if (t == null || t === cur) return '<span class="xs muted">–</span>'; const q = t - cur, p = r.price || 0; return `<span class="side-tag ${q > 0 ? "BUY" : "SELL"}">${q > 0 ? "BUY" : "SELL"} ${Math.abs(q).toLocaleString("en-IN")}</span><span class="sub">${inrShort(Math.abs(q) * p)}</span>`; };
    const rows = w.rows.filter((r) => r.listed || r.held || r.action === "NO DATA");
    const ord = S.ordersList.filter((o) => o.agent === a.id && o.session === ns && o.status !== "cancelled");
    $("wlCalls").innerHTML = `<div class="card" style="padding:6px 8px"><div class="row" style="padding:8px 8px 4px"><h2>Calls</h2><span class="grow"></span><span class="xs muted">${w.rows.filter((r) => r.action === "BUY").length} buy · ${w.rows.filter((r) => r.action === "SELL").length} sell · ${w.rows.filter((r) => r.action === "HOLD").length} holding${learnedOver(a) ? " · learned settings" : ""}</span></div>
      ${rows.length ? `<div class="tablewrap"><table class="wl-table"><thead><tr><th>Call</th><th>Name</th><th class="r">Last</th><th class="r">Day</th><th>Triggers</th>${plan ? `<th>Order for ${esc(fmtDate(ns))}</th>` : ""}</tr></thead><tbody>
        ${rows.map((r) => `<tr><td><span class="act ${esc(r.action.replace(/ /g, "-"))}">${esc(r.action)}</span></td><td><button class="linkbtn" style="color:var(--ink);padding:0" type="button" data-go="sym-${esc(r.symbol)}"><span class="sym">${esc(r.symbol)}</span></button><span class="sub">${esc(r.held ? `${r.qty} @ ${px(r.avg)} · ${pct(r.pnl_pct)} · day ${r.days_held}` : nameOfSym(r.symbol))}</span></td>
          <td class="r">${px(r.price)}</td><td class="r ${cls(r.day_pct)}">${pct(r.day_pct, 2)}</td><td class="wrap">${(r.conditions || []).map(condChip).join("")}${r.action === "SELL" || r.action === "NO DATA" || r.slotOk === false ? `<span class="sub">${esc(r.note)}</span>` : ""}</td>${plan ? `<td>${orderCell(r)}</td>` : ""}</tr>`).join("")}</tbody></table></div>`
      : '<p class="muted" style="padding:8px">Nothing to call yet.</p>'}
      ${ord.length ? `<p class="note" style="padding:6px 8px">${ord.length} order(s) are set for the ${esc(fmtDate(ns))} open — <button class="linkbtn" type="button" data-go="orders">see Orders</button>.</p>` : ""}</div>`;
    wireGo($("wlCalls"));
    if (ro) return;
    const submit = async (mode) => {
      const st = $("wlStatus"), { known, unknown } = parseNames($("wlNames").value);
      if (!known.length) { st.classList.add("err"); st.textContent = unknown.length ? `No data for ${unknown.slice(0, 6).join(", ")}` : "Type some names first"; return; }
      st.classList.remove("err"); st.textContent = "Saving…";
      try {
        await saveList(a, known, mode); $("wlNames").value = "";
        const w2 = await watchCalls(a, spec), r = await ordersNow(a, spec, w2.rows).catch((e) => ({ made: 0, why: e.message }));
        const buys = w2.rows.filter((x) => x.action === "BUY").map((x) => x.symbol);
        toast(`${known.length} name(s) live${buys.length ? ` · BUY ${buys.slice(0, 5).join(", ")}${buys.length > 5 ? "…" : ""}` : " · no triggers on the latest close"}${r.made ? ` · ${r.made} order(s) for ${fmtDate(r.session)}` : a.status === "paper" && buys.length ? ` · orders ${r.why}` : ""}${unknown.length ? ` · no data: ${unknown.slice(0, 4).join(", ")}` : ""}`);
        S.paperCache.clear(); renderRoomBody();
      } catch (e) { st.classList.add("err"); st.textContent = e.message || String(e); }
    };
    $("wlForm").addEventListener("submit", (e) => { e.preventDefault(); submit("replace"); });
    $("wlAdd").addEventListener("click", () => submit("add"));
    $("wlNames").addEventListener("keydown", (e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); submit("replace"); } });
    body.querySelectorAll("[data-rmname]").forEach((b) => b.addEventListener("click", async () => { const left = (todays?.syms || []).filter((s) => s !== b.dataset.rmname); try { await saveList(a, left, "replace"); const w2 = await watchCalls(a, spec); await ordersNow(a, spec, w2.rows).catch(() => null); renderRoomBody(); } catch (e) { toast(e.message || String(e)); } }));
    $("wlGo")?.addEventListener("click", async (e) => {
      e.target.disabled = true;
      try { await patchAgent(a.id, { desk_id: $("wlDesk").value, alloc_pct: Math.max(1, Math.min(100, Number($("wlAlloc").value) || 100)) }); if (a.status !== "paper") await setStatus(a, "paper"); toast("On the desk. Orders start with tonight's run."); }
      catch (err) { e.target.disabled = false; toast(err.message || String(err)); }
    });
  }

  async function watchRecord(a, v, spec, body, seq) {
    const log = a.inbox_log || [], over = learnedOver(a);
    body.innerHTML = '<p class="thinking">Going through every list you sent<span class="dots"></span></p>';
    const names = [...new Set(log.flatMap((x) => x.syms || []))];
    let frames; try { frames = await framesFor(spec, null, names); } catch (e) { body.innerHTML = `<p class="flag">${esc(e.message || e)}</p>`; return; }
    if (seq !== roomRenderSeq) return;
    const L = E.watchLearn(spec, frames, log, { over }), st = L.stats, keys = Object.keys(spec.params || {});
    const T = keys.length && st.n >= 3 ? E.watchTune(spec, frames, log, { over }) : null;
    const tile = (k, val, b) => `<div class="kpi"><span class="k">${k}</span><span class="v">${val}</span><span class="b">${esc(b)}</span></div>`;
    const sug = T?.suggestion, cur = T?.current;
    const learnCard = `<div class="card learn"><div class="row"><h2>Learning</h2><span class="grow"></span>${S.readOnly ? "" : `<label class="small row" style="gap:6px"><input type="checkbox" id="wlAuto" ${a.auto_learn ? "checked" : ""}> Learn automatically each evening</label>`}</div>
      ${a.auto_learn && a.learned ? `<p class="small">Using learned settings since ${esc(fmtDate(a.learned.at))}: ${Object.entries(a.learned.params).map(([k, x]) => `${esc(spec.params[k]?.label || k)} <b>${esc(n2c(x))}${esc(spec.params[k]?.unit || "")}</b>`).join(" · ")} <span class="muted">(avg ${pct(a.learned.before?.avg_pct, 2)} → ${pct(a.learned.stats?.avg_pct, 2)} a call)</span></p>` : ""}
      ${!keys.length ? '<p class="small muted">This system has no adjustable settings, so there is nothing to tune. Ask the agent to turn its numbers into settings.</p>'
        : !T ? `<p class="small muted">Needs a few more calls to learn from (${st.n} so far). Keep sending lists.</p>`
        : sug ? `<p>Your record says these settings would have done better: ${sug.changed.map((k) => `${esc(spec.params[k].label || k)} <b>${esc(n2c(cur.params[k]))} → ${esc(n2c(sug.params[k]))}${esc(spec.params[k].unit || "")}</b>`).join(", ")} — <b>${pct(sug.stats.avg_pct, 2)}</b> a call over ${sug.stats.n} calls (${pct(sug.stats.win_pct, 0, false)} won) instead of ${pct(cur.stats.avg_pct, 2)} over ${cur.stats.n}.</p>
          ${S.readOnly ? "" : `<div class="row"><button class="btn small" type="button" id="wlApply">Apply as v${(a.version || 1) + 1}</button><span class="xs muted">Judged on the lists you sent; small samples mislead, so it needs ${T.min_trades}+ calls.</span></div>`}`
        : `<p class="small">The current settings are the best of the nearby ones on your record (${cur.stats.n} calls).</p>`}
      ${T ? `<details class="fold"><summary>How each setting would have done</summary><div class="grid2" style="margin-top:8px">${Object.entries(T.grid).map(([k, rows]) => `<div><b class="small">${esc(spec.params[k]?.label || k)}</b><div class="tablewrap"><table><thead><tr><th class="r">Value</th><th class="r">Calls</th><th class="r">Won</th><th class="r">Avg</th></tr></thead><tbody>${rows.map((r) => `<tr${Math.abs(r.value - cur.params[k]) < 1e-9 ? ' style="font-weight:600"' : ""}><td class="r">${esc(n2c(r.value))}</td><td class="r">${r.n}</td><td class="r">${pct(r.win_pct, 0, false)}</td><td class="r ${cls(r.avg_pct)}">${pct(r.avg_pct, 2)}</td></tr>`).join("")}</tbody></table></div></div>`).join("")}</div></details>` : ""}</div>`;
    const recent = L.trades.slice().reverse().slice(0, 60);
    body.innerHTML = `${log.length ? "" : '<div class="banner">The record starts with the first list you send. Every call is checked against what the stock did next, and the system learns which triggers and thresholds work on your names.</div>'}
      <div class="stats five">${tile("Calls", String(st.signals), `${log.length} list(s) · ${names.length} names`)}${tile("Won", pct(st.win_pct, 0, false), `${st.closed} closed`)}${tile("Average a call", `<span class="${cls(st.avg_pct)}">${pct(st.avg_pct, 2)}</span>`, `median ${pct(st.median_pct, 2)} · after costs`)}${tile("Held", st.avg_days != null ? `${st.avg_days} d` : "–", "average")}${tile("No call", String(st.names_without_signal), st.quiet_avg_fwd_pct != null ? `next 5 days avg ${pct(st.quiet_avg_fwd_pct, 2)}` : "")}</div>
      ${learnCard}
      <div class="grid2"><div class="card"><h2>By trigger</h2><div class="tablewrap"><table><thead><tr><th>Trigger</th><th class="r">Calls</th><th class="r">Won</th><th class="r">Avg</th></tr></thead><tbody>${st.by_condition.map((c) => `<tr><td>${esc(c.label)}</td><td class="r">${c.n}</td><td class="r">${pct(c.win_pct, 0, false)}</td><td class="r ${cls(c.avg_pct)}">${pct(c.avg_pct, 2)}</td></tr>`).join("")}</tbody></table></div></div>
        <div class="card"><h2>Moves it missed</h2>${st.missed_movers.length ? `<div class="tablewrap"><table><thead><tr><th>Name</th><th>List</th><th class="r">Next 5 days</th></tr></thead><tbody>${st.missed_movers.map((m) => `<tr><td>${esc(m.symbol)}</td><td class="small">${esc(fmtDate(m.date))}</td><td class="r pos">${pct(m.fwd_pct)}</td></tr>`).join("")}</tbody></table></div>` : '<p class="small muted">None above +5% so far.</p>'}</div></div>
      <div class="card"><div class="row"><h2>Every call</h2><span class="grow"></span><span class="xs muted">bought at the next open, sold by the exit rules, after ${spec.cost_pct}% costs a side</span></div>${recent.length ? `<div class="tablewrap tall"><table><thead><tr><th>Name</th><th>Called</th><th>Triggers</th><th class="r">In</th><th class="r">Out</th><th class="r">Return</th><th>Why out</th></tr></thead><tbody>${recent.map((t) => `<tr><td><b>${esc(t.symbol)}</b></td><td class="small">${esc(fmtDate(t.signal_date))}</td><td class="small">${esc((t.fired || []).map((id) => spec.conditions.find((c) => c.id === id)?.label || id).join(" + "))}</td><td class="r">${t.pending ? '<span class="xs muted">next open</span>' : px(t.entry)}</td><td class="r">${t.pending ? "" : px(t.exit)}</td><td class="r ${cls(t.ret_pct)}">${t.pending ? "" : pct(t.ret_pct, 2)}</td><td class="small">${esc(t.pending ? "pending" : t.reason)}</td></tr>`).join("")}</tbody></table></div>` : '<p class="muted small">No calls yet.</p>'}</div>
      <div class="card"><div class="row"><h2>Check on past data</h2><span class="grow"></span><select class="input" id="wlBackN" style="width:auto;min-height:32px;padding:3px 8px" aria-label="Period"><option value="21">1 month</option><option value="63" selected>3 months</option><option value="126">6 months</option></select><button class="btn ghost small" type="button" id="wlBack">Run</button></div><p class="small muted">Optional. Treats today's names as if you had sent them every day of the period.</p><div id="wlBackOut"></div></div>`;
    $("wlAuto")?.addEventListener("change", async (e) => { try { await patchAgent(a.id, { auto_learn: e.target.checked }); toast(e.target.checked ? "It will adjust its settings from its record each evening" : "Learning paused: it uses its saved settings"); } catch (err) { toast(err.message || String(err)); } });
    $("wlApply")?.addEventListener("click", async (e) => {
      e.target.disabled = true;
      try { const s2 = JSON.parse(JSON.stringify(v.spec)); for (const k of sug.changed) s2.params[k] = { ...(s2.params[k] || {}), value: sug.params[k] };
        const n = await saveVersion(a, { spec: E.normalize(s2, S.man.universes), meta: v.meta || {}, test: v.test || {}, note: `Learned from the record: ${sug.changed.map((k) => `${k} ${cur.params[k]}→${sug.params[k]}`).join(", ")}` });
        if (a.status === "paper") await setStatus({ ...a, version: n }, "paper"); if (a.learned) await patchAgent(a.id, { learned: null }); S.room.ver = n; toast(`Applied as v${n}`); }
      catch (err) { e.target.disabled = false; toast(err.message || String(err)); }
    });
    $("wlBack").addEventListener("click", async () => {
      const out = $("wlBackOut"), n = +$("wlBackN").value, list = liveNames(a, spec).length ? liveNames(a, spec) : names.slice(-30);
      if (!list.length) { out.innerHTML = '<p class="small muted">Send some names first.</p>'; return; }
      out.innerHTML = '<p class="thinking">Replaying<span class="dots"></span></p>';
      try { const fr = await framesFor(spec, null, list), days = sessionDays().slice(-n - 1, -1), lg = days.map((d) => ({ date: E.isoOf(d), syms: list })), R = E.watchLearn(spec, fr, lg, { over }).stats;
        out.innerHTML = `<div class="mini-kpis"><div class="mini"><span class="k">Calls</span><span class="v">${R.signals}</span><span class="b">${list.length} names × ${days.length} days</span></div><div class="mini"><span class="k">Won</span><span class="v">${pct(R.win_pct, 0, false)}</span><span class="b">${R.closed} closed</span></div><div class="mini"><span class="k">Average a call</span><span class="v ${cls(R.avg_pct)}">${pct(R.avg_pct, 2)}</span><span class="b">median ${pct(R.median_pct, 2)}</span></div></div>`; }
      catch (e) { out.innerHTML = `<p class="flag">${esc(e.message || e)}</p>`; }
    });
  }

  function watchSettings(a, v, spec, body) {
    const ro = S.readOnly, P = spec.params || {}, num = (id, label, val, unit, attrs = "") => `<div class="field"><label for="${id}">${esc(label)}${unit ? ` <span class="muted">(${esc(unit)})</span>` : ""}</label><input class="input" id="${id}" type="number" step="any" value="${val ?? ""}" ${attrs} ${ro ? "disabled" : ""}></div>`;
    body.innerHTML = `<div class="card stack"><div class="row"><h2>Settings · v${v.n}</h2><span class="grow"></span><span class="small muted">by ${esc(nameOf(v.by))} · ${esc(fmtWhen(v.at))}</span></div>
      ${v.meta?.explanation ? `<p>${esc(v.meta.explanation)}</p>` : ""}
      <div><b class="small">Triggers</b> <span class="small muted">— buy when ${spec.need === "any" ? "any one" : spec.need === "all" ? "all" : `at least ${spec.need}`} of these fire on the close</span>
        <ul class="small" style="margin:6px 0 0;padding-left:18px">${spec.conditions.map((c) => `<li><b>${esc(c.label)}</b> <code>${esc(E.fillParams(c.expr, P, learnedOver(a)))}</code></li>`).join("")}</ul></div>
      <form id="wlSet" class="limits-form" style="padding:0">
        ${Object.entries(P).map(([k, p]) => num(`wp_${k}`, p.label || k, (learnedOver(a) || {})[k] ?? p.value, p.unit, `${p.min != null ? `min="${p.min}"` : ""} ${p.max != null ? `max="${p.max}"` : ""}`)).join("")}
        <div class="field"><label for="wNeed">Buy when</label><select class="input" id="wNeed" ${ro ? "disabled" : ""}><option value="any" ${spec.need === "any" ? "selected" : ""}>Any trigger fires</option><option value="all" ${spec.need === "all" ? "selected" : ""}>All triggers fire</option>${spec.conditions.length > 2 ? [...Array(spec.conditions.length - 2)].map((_, i) => `<option value="${i + 2}" ${spec.need === i + 2 ? "selected" : ""}>At least ${i + 2}</option>`).join("") : ""}</select></div>
        ${num("wHold", "Sell after", spec.hold_days, "sessions", 'min="1"')}${num("wTgt", "Take profit at", spec.target_pct, "%", 'min="0"')}${num("wStop", "Stop loss at", spec.stop_pct, "%", 'min="0"')}
        ${num("wPos", "Each buy", spec.position_pct, "% of capital", 'min="0.5" max="100"')}${num("wMax", "Most names held", spec.max_positions, "", 'min="1"')}${num("wDays", "Names stay live for", spec.list_days, "sessions", 'min="1" max="60"')}
        ${spec.exit ? `<div class="field" style="grid-column:1/-1"><span class="lbl">Exit rule</span><code>${esc(E.fillParams(spec.exit, P))}</code></div>` : ""}
        ${ro ? "" : `<div class="row" style="grid-column:1/-1"><button class="btn" type="submit">Save as v${(a.version || 1) + 1}</button><span class="status" id="wSetSt"></span><span class="grow"></span><span class="xs muted">Takes effect on the next calls${a.status === "paper" ? " and tonight's orders" : ""}. No backtest needed.</span></div>`}
      </form>
      <details><summary class="small" style="cursor:pointer">Edit everything (JSON)</summary><div class="stack" style="margin-top:10px"><textarea class="input mono" id="edSpec" rows="14" spellcheck="false">${esc(JSON.stringify(v.spec, null, 2))}</textarea>
        <div class="row"><button class="btn quiet small" type="button" id="edSave" ${ro ? "disabled" : ""}>Save as v${(a.version || 1) + 1}</button><span class="status" id="edStatus"></span></div></div></details></div>
      <div class="card"><h2>Versions</h2><div class="versions">${S.room.versions.slice().reverse().map((x) => `<div class="ver ${x.n === a.version ? "cur" : ""}"><span class="n">v${x.n}</span><div><b>${esc(x.note || "")}</b><div class="small muted">${esc(nameOf(x.by))} · ${esc(fmtWhen(x.at))}${a.paper?.version === x.n ? ' · <span class="pill paper">paper</span>' : ""}</div></div><div></div></div>`).join("")}</div></div>`;
    if (ro) return;
    const save = async (spec2, note, st) => { st.classList.remove("err"); st.textContent = "Saving…";
      try { const s = E.normalize(spec2, S.man.universes), n = await saveVersion(a, { spec: s, meta: v.meta || {}, test: v.test || {}, note }); if (a.status === "paper") await setStatus({ ...a, version: n }, "paper"); S.room.ver = n; st.textContent = `Saved as v${n}.`; }
      catch (e) { st.classList.add("err"); st.textContent = e instanceof SyntaxError ? "That isn't valid JSON: " + e.message : (e.message || String(e)); } };
    $("wlSet").addEventListener("submit", (e) => {
      e.preventDefault(); const s2 = JSON.parse(JSON.stringify(v.spec)), g = (id) => { const x = $(id).value; return x === "" ? null : Number(x); }, ch = [];
      for (const k of Object.keys(P)) { const x = g(`wp_${k}`); if (x != null && x !== P[k].value) { s2.params[k] = { ...s2.params[k], value: x }; ch.push(`${P[k].label || k} ${x}`); } }
      const nd = $("wNeed").value; s2.need = /^\d+$/.test(nd) ? +nd : nd;
      Object.assign(s2, { hold_days: g("wHold"), target_pct: g("wTgt"), stop_pct: g("wStop"), position_pct: g("wPos") ?? spec.position_pct, max_positions: g("wMax"), list_days: g("wDays") ?? spec.list_days });
      save(s2, ch.length ? ch.join(", ") : "Settings changed", $("wSetSt"));
    });
    $("edSave").addEventListener("click", () => { try { save(JSON.parse($("edSpec").value), "Edited", $("edStatus")); } catch (e) { $("edStatus").textContent = "That isn't valid JSON: " + e.message; } });
  }

  // ---------------------------------------------------------------- panels any system can ask for in its spec's "view"
  function namesOfSpec(spec) {
    if (spec.type === "watchlist") { const a = curAgent(); return [...new Set([...(spec.symbols || []), ...(a ? liveNames(a, spec) : []), ...(a ? Object.keys(heldOf(a)) : [])])]; }
    if (spec.type === "option_selling") return [spec.underlying];
    if (spec.type === "rotation") return (Array.isArray(spec.universe) ? spec.universe : (S.man.universes[spec.universe] || [])).slice(0, 80);
    return (spec.symbols || []).slice(0, 80);
  }
  async function panelFundamentals(spec, body, seq) {
    const syms = namesOfSpec(spec).filter((s) => S.man.symbols[s]?.kind === "stock");
    if (!syms.length) { body.innerHTML = '<div class="card empty"><h2>No stocks here</h2><p>Fundamentals show for the stocks this system trades.</p></div>'; return; }
    body.innerHTML = '<p class="thinking">Reading results<span class="dots"></span></p>';
    await Promise.all([ensureFund(syms).catch(() => null), ensureFull(syms).catch(() => null)]);
    if (seq !== roomRenderSeq) return;
    const r1 = (x) => x == null || !isFinite(x) ? null : Math.round(x * 10) / 10;
    const rows = syms.map((s) => { const f = priceFrame(s); return { s, pe: r1(evalLast("pe", f)), mcap: evalLast("mcap", f), sg: r1(evalLast("sales_growth_ttm", f)), pg: r1(evalLast("profit_growth_ttm", f)), opm: r1(evalLast("opm", f)), r1m: r1(evalLast("roc(close,21)", f)), prom: r1(evalLast("promoter", f)) }; }).sort((a, b) => (b.mcap ?? 0) - (a.mcap ?? 0));
    body.innerHTML = `<div class="card" style="padding:6px 8px"><div class="tablewrap tall"><table><thead><tr><th>Name</th><th class="r">Mcap (₹ cr)</th><th class="r">P/E</th><th class="r">Sales g. (TTM)</th><th class="r">Profit g. (TTM)</th><th class="r">EBITDA %</th><th class="r">Promoter %</th><th class="r">1m</th></tr></thead><tbody>
      ${rows.map((r) => `<tr class="click" data-go="sym-${esc(r.s)}"><td><span class="sym">${esc(r.s)}</span><span class="sub">${esc(nameOfSym(r.s))}</span></td><td class="r">${r.mcap != null ? Math.round(r.mcap).toLocaleString("en-IN") : "–"}</td><td class="r">${r.pe ?? "–"}</td><td class="r ${cls(r.sg)}">${pct(r.sg, 0)}</td><td class="r ${cls(r.pg)}">${pct(r.pg, 0)}</td><td class="r">${r.opm ?? "–"}</td><td class="r">${r.prom ?? "–"}</td><td class="r ${cls(r.r1m)}">${pct(r.r1m)}</td></tr>`).join("")}</tbody></table></div></div>`;
    wireGo(body);
  }
  async function panelOptions(spec, body, seq) {
    const sym = spec.type === "option_selling" ? spec.underlying : namesOfSpec(spec).find((s) => S.man.options?.underlyings?.[s]);
    if (!sym) { body.innerHTML = '<div class="card empty"><h2>No option data</h2><p>None of this system\'s names has options in the data.</p></div>'; return; }
    body.innerHTML = '<p class="thinking">Reading the chain<span class="dots"></span></p>';
    const o = await optionSnapshot(sym, null, 2, 6).catch((e) => ({ error: e.message }));
    if (seq !== roomRenderSeq) return;
    if (o.error) { body.innerHTML = `<p class="flag">${esc(o.error)}</p>`; return; }
    body.innerHTML = `<div class="stats">${[["Futures", px(o.futures), o.date], ["IV (30d ATM)", o.iv30_pct != null ? o.iv30_pct + "%" : "–", o.iv_1y_percentile != null ? `${o.iv_1y_percentile} pct of the year` : ""], ["Put/call OI", n2(o.put_call_oi_ratio), ""], ["Max pain", px(o.max_pain), ""]].map(([k, v, b]) => `<div class="kpi"><span class="k">${k}</span><span class="v">${v}</span><span class="b">${esc(b || "")}</span></div>`).join("")}</div>
      ${o.expiries.map((e) => `<div class="card" style="padding:6px 8px"><div class="row" style="padding:6px 8px"><h2>${esc(sym)} ${esc(fmtDate(e.expiry))}</h2><span class="xs muted">${e.days_left} days</span></div><div class="tablewrap tall"><table><thead><tr><th class="r">Call</th><th class="r">IV</th><th class="r">Strike</th><th class="r">Put</th><th class="r">IV</th></tr></thead><tbody>${e.strikes.map((k) => `<tr${Math.abs(k.strike / o.futures - 1) < 0.006 ? ' style="font-weight:600"' : ""}><td class="r">${px(k.call)}</td><td class="r small muted">${k.call_iv ?? "–"}</td><td class="r">${px(k.strike)}</td><td class="r">${px(k.put)}</td><td class="r small muted">${k.put_iv ?? "–"}</td></tr>`).join("")}</tbody></table></div></div>`).join("")}`;
  }
  async function panelChart(spec, body) {
    const syms = namesOfSpec(spec).filter((s) => S.man.symbols[s]);
    if (!syms.length) { body.innerHTML = '<div class="card empty"><h2>Nothing to chart</h2></div>'; return; }
    const cur = S.room.chartSym && syms.includes(S.room.chartSym) ? S.room.chartSym : syms[0];
    body.innerHTML = `<div class="card"><div class="row"><select class="input" id="pcSym" style="width:auto">${syms.map((s) => `<option ${s === cur ? "selected" : ""}>${esc(s)}</option>`).join("")}</select><span class="grow"></span><span class="xs muted">daily · 50-day average</span></div><div class="chart" id="pcChart" style="margin-top:8px"></div></div>`;
    await ensureFull([cur]).catch(() => null);
    const f = priceFrame(cur); if (f) candleChart($("pcChart"), f, 130, [50]);
    $("pcSym").addEventListener("change", (e) => { S.room.chartSym = e.target.value; panelChart(spec, body); });
  }

  // the agent's own chat for a daily-list system: its settings, today's calls and its record — never a backtest unless asked
  async function watchAgentPrompt(a, v, text, atts) {
    const spec = E.normalize(v.spec, S.man.universes), log = a.inbox_log || [];
    let calls = [], st = null;
    try { calls = (await watchCalls(a, spec)).rows.filter((r) => r.listed || r.held).slice(0, 80).map((r) => ({ symbol: r.symbol, call: r.action, price: r.price, day_pct: r.day_pct, triggers: (r.conditions || []).map((c) => `${c.label}:${c.on ? "yes" : "no"}${c.value != null ? ` (${c.value}${c.unit || ""})` : ""}`).join(", "), held: r.held ? { qty: r.qty, avg: r.avg, pnl_pct: r.pnl_pct, days: r.days_held } : null })); } catch (e) { calls = [{ error: e.message }]; }
    try { const names = [...new Set(log.flatMap((x) => x.syms || []))], fr = await framesFor(spec, null, names); const L = E.watchLearn(spec, fr, log, { over: learnedOver(a) }); st = { ...L.stats, best: L.stats.best && { s: L.stats.best.symbol, r: L.stats.best.ret_pct }, worst: L.stats.worst && { s: L.stats.worst.symbol, r: L.stats.worst.ret_pct }, recent: L.trades.slice(-25).map((t) => `${t.symbol} ${t.signal_date} ${t.pending ? "pending" : `${t.ret_pct}% (${t.reason})`} [${t.fired.join("+")}]`) }; } catch (e) { st = { error: e.message }; }
    const hist = S.room.messages.filter((m) => m.role !== "system").slice(-30).map((m) => `${m.role === "user" ? "USER" : "YOU"}: ${m.text}${m.proposal ? ` [proposed: ${m.proposal.note}; ${m.proposal.status || "pending"}]` : ""}`).join("\n\n");
    return `You are "${a.name}", a daily-list trading system inside TradeOS (Indian markets, paper trading). The team sends you names (stocks) — usually a list a day. On the latest close you call BUY when your triggers fire, the desk buys at the next open, and you SELL by your exit rules. You learn from the record of every list sent. You think like the best short-term equity trader and analyst in the world, but you carry out the user's instructions exactly, add nothing they didn't ask for, and judge by money made.

${ordersBlock(a)}

HOW YOU WORK
- When the user sends names ("today: RELIANCE, TRENT", a pasted list, "add BSE"), put them in "list" ({"mode":"replace"|"add","syms":[tickers]}); the app saves them and the calls/orders follow at once. Don't ask before taking a list.
- To change triggers, thresholds or exits, return a "proposal" whose "changes" hold ONLY what changes (for a setting: {"params":{...whole params object with the new value...}}; for triggers: the whole "conditions" list). Set "apply_now": true when the user told you to change it. No backtest is needed; the app compares the change on the team's own lists.
- Never suggest a backtest or stress test unless the user asks; your evidence is the record below and today's data. If the record is small, say so in one line.
- Explain calls plainly: which trigger fired, the numbers, what the order is.
- Market numbers come from the data below or the tools (compute, company_research, news, option_data, market_snapshot). Use your own knowledge for context, labelled "from my knowledge, may be dated" when it can change.

SPEC (v${v.n}, ${a.status}${a.desk_id ? `, desk ${deskName(a.desk_id)} at ${a.alloc_pct || 0}%` : ", not on a desk"}): ${JSON.stringify(v.spec)}
LEARNED SETTINGS IN USE: ${JSON.stringify(learnedOver(a))}${a.auto_learn ? " (auto-learning on)" : " (auto-learning off)"}
LIVE NAMES: ${JSON.stringify(liveNames(a, spec))} · latest close ${S.lastDay} · next session ${nextSessionIso()}
TODAY'S CALLS: ${JSON.stringify(calls)}
RECORD ON THE LISTS SENT (${log.length} lists): ${JSON.stringify(st)}

DAILY-LIST SPEC FORMAT: ${WATCH_SCHEMA}
RULE LANGUAGE: the same as every TradeOS rule (roc, sma, prev, volume, fut_oi, iv, pcr, pe, ref("SYM", expr)…); {name} placeholders take the numbers in "params".

${dataBrief()}

REPLY with ONE JSON object only (no text around it, no code fences; escape quotes and newlines in strings): {"reply":"markdown","list":null or {"mode":"replace"|"add","syms":["..."]},"proposal":null or {"note":"what changed","changes":{...},"apply_now":true|false,"explanation":"one paragraph on the rules"},"remember":[],"forget":[],"new_chat":false,"attachment_notes":""}

CONVERSATION:
${hist || "(new)"}

USER NOW: ${text}${attachmentText(atts)}`;
  }
