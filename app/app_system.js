  // ================================================================ SYSTEM: change tickets for TradeOS itself
  // Anything the tools can't do yet — a chart, a page, a reader, a data source, an agent type, a job — becomes a ticket in
  // db "changes". The owner builds waiting tickets by telling a Claude Code session "build my TradeOS tickets" (it follows
  // docs/BUILDER.md): it builds, tests and publishes each change and reports back on the ticket.
  S.changes = [];
  const CH_STATUS = { queued: "Waiting to be built", building: "Being built", needs_input: "Needs your answer", done: "Live", failed: "Failed", reverted: "Undone", cancelled: "Cancelled" };
  const CH_AREAS = { ui: "Screens & charts", data: "Data", reader: "Reader", agent: "Agents & strategies", backend: "Jobs & backend", other: "Other" };
  function startSystemData() {
    try { S.db.collection("changes").orderBy("at", "desc").limit(150).onSnapshot((snap) => { S.changes = snap.docs.map((d) => ({ id: d.id, ...d.data() })); setCount("system", S.changes.filter((c) => c.status === "needs_input").length, true); if (S.view === "system") renderSystem(); }, () => { /* none yet */ }); } catch (e) { /* no db */ }
  }
  async function fileChange(input, from) {
    if (S.readOnly) throw new Error("You have view-only access, so changes can't be requested from this account.");
    const request = String(input.request || "").trim();
    if (request.length < 10) throw new Error("Describe the change in a sentence or more.");
    const id = newId("c"), area = CH_AREAS[input.area] ? input.area : "other";
    const doc = { title: String(input.title || request.split(/[.\n]/)[0]).slice(0, 120), request: request.slice(0, 8000), area, kind: input.kind === "revert" ? "revert" : "change", target: input.target || null,
      status: "queued", origin: "user", by: S.uid, by_name: S.me?.name || null, from: from || "system page", at: nowIso(), thread: [] };
    await S.db.doc(`changes/${id}`).set(doc);
    return { ticket_id: id, status: "queued", note: "Filed on the System page. It gets built the next time the owner tells Claude Code \"build my TradeOS tickets\" — that session builds, tests and publishes every waiting ticket and reports back on each one." };
  }
  // for the CIO and agents: what's being built and what recently changed
  function systemBrief() {
    const open = S.changes.filter((c) => ["queued", "building", "needs_input"].includes(c.status)), done = S.changes.filter((c) => c.status === "done").slice(0, 12);
    return `CHANGING TRADEOS ITSELF: anything about this system can change — pages, charts, layouts, agent types, engine features, data sources (more data, other providers, finer or longer history), readers (X, YouTube, websites, PDFs/reports, any feed), scheduled jobs, backend scripts, how you and the agents work. When the user wants something the tools can't do today, add a "request_change" action (see CONTROLLING THE FUND) whose request an engineer can build without asking: what, where, how it behaves, examples, why. It shows as a card; when the user taps Add it goes on the System page, and it is built, tested and published the next time the owner tells Claude Code "build my TradeOS tickets". Say exactly that in one sentence. Group related asks into one change. Never say the app can't be changed or that something "belongs to the front end"; meanwhile do whatever the current tools can.
Open tickets: ${open.length ? open.map((c) => `${c.id} [${c.status}] ${c.title}${c.status === "needs_input" ? ` — builder asks: ${(c.thread || []).filter((t) => t.who === "builder").slice(-1)[0]?.text || ""}` : ""}`).join(" | ") : "none"}
Recently built (now live): ${done.length ? done.map((c) => `${c.title}: ${c.result?.summary || ""}${c.result?.how_to_use ? " How to use: " + c.result.how_to_use : ""}`).join(" | ") : "none yet"}`;
  }
  const ago = (iso) => { if (!iso) return ""; const m = Math.round((Date.now() - Date.parse(iso)) / 60000); return m < 1 ? "just now" : m < 60 ? `${m} min ago` : m < 1440 ? `${Math.round(m / 60)} h ago` : fmtDate(iso); };
  function renderSystem() {
    const box = $("view-system"), ro = S.readOnly, cs = S.changes;
    const groups = [["Needs your answer", cs.filter((c) => c.status === "needs_input")], ["In the queue", cs.filter((c) => ["queued", "building"].includes(c.status))], ["Live", cs.filter((c) => c.status === "done")], ["Failed or undone", cs.filter((c) => ["failed", "reverted", "cancelled"].includes(c.status))]];
    const card = (c) => {
      const th = (c.thread || []).map((t) => `<li><span class="xs muted">${t.who === "builder" ? "Builder" : esc(t.by_name || "You")} · ${esc(ago(t.at))}</span><br>${esc(t.text)}</li>`).join("");
      const r = c.result || {};
      return `<article class="card ticket" data-ch="${esc(c.id)}">
        <div class="row" style="gap:8px;flex-wrap:wrap"><h3 style="margin:0">${esc(c.title)}</h3><span class="pill ${c.status === "done" ? "auto" : c.status === "failed" ? "halted" : c.status === "needs_input" ? "manual" : ""}">${esc(CH_STATUS[c.status] || c.status)}</span>${c.kind === "revert" ? '<span class="pill">undo</span>' : ""}<span class="grow"></span><span class="xs muted">${esc(CH_AREAS[c.area] || "")} · ${esc(c.by_name || "team")} via ${esc(c.from || "app")} · ${esc(ago(c.at))}</span></div>
        <p class="small" style="margin-top:6px;white-space:pre-wrap;max-width:90ch">${esc(c.request)}</p>
        ${c.status === "building" && c.progress ? `<p class="small muted">Now: ${esc(c.progress)}</p>` : ""}
        ${r.summary ? `<div class="small" style="margin-top:6px"><b>What changed.</b> ${esc(r.summary)}${r.how_to_use ? `<br><b>How to use it.</b> ${esc(r.how_to_use)}` : ""}${r.notes ? `<br><span class="muted">${esc(r.notes)}</span>` : ""}${r.commit ? `<br><a class="xs" href="https://github.com/ujjawal234/TradeOS/commit/${esc(String(r.commit).replace(/[^0-9a-f]/gi, ""))}" target="_blank" rel="noopener">See the code change</a>` : ""}</div>` : ""}
        ${c.status === "failed" && (c.note || r.reason) ? `<p class="small flag">${esc(c.note || r.reason)}</p>` : ""}
        ${th ? `<ul class="newslist" style="margin-top:6px">${th}</ul>` : ""}
        ${ro ? "" : `<div class="row" style="gap:8px;margin-top:8px;flex-wrap:wrap">
          ${c.status === "needs_input" || c.status === "failed" ? `<form class="row grow chreply" data-id="${esc(c.id)}" style="gap:6px;flex-wrap:nowrap"><input class="input grow" name="t" placeholder="${c.status === "failed" ? "Add detail and try again" : "Your answer"}" aria-label="Reply to the builder"><button class="btn small" type="submit">${c.status === "failed" ? "Try again" : "Send"}</button></form>` : ""}
          ${c.status === "queued" ? `<button class="btn ghost small" type="button" data-chcancel="${esc(c.id)}">Cancel</button>` : ""}
          ${c.status === "done" && c.kind !== "revert" ? `<button class="btn ghost small" type="button" data-chundo="${esc(c.id)}">Undo this change</button>` : ""}
        </div>`}
      </article>`;
    };
    box.innerHTML = `<div class="pagehead"><div><h1>System</h1><p>Change TradeOS itself: screens, charts, agents, data sources, readers, jobs. Ask here, or just tell the CIO in chat — it writes up the details as a card you add with one tap. To build everything waiting, tell Claude Code <b>build my TradeOS tickets</b>: it builds, tests and publishes each one and reports back here.</p></div></div>
      ${ro ? "" : `<form class="card" id="chForm"><h2>Ask for a change</h2>
        <div class="field" style="margin-top:8px"><label for="chReq">What should change?</label><textarea class="input" id="chReq" rows="4" placeholder="e.g. On the stock page, add a 1 day / 1 week chart with minute bars, and make 1 month and longer use daily bars." required></textarea></div>
        <div class="row" style="gap:10px;margin-top:10px;flex-wrap:wrap"><div class="field"><label for="chArea">Area</label><select class="input" id="chArea">${Object.entries(CH_AREAS).map(([k, v]) => `<option value="${k}">${v}</option>`).join("")}</select></div><span class="grow"></span><button class="btn" type="submit" style="align-self:end">Add to the list</button></div></form>`}
      ${groups.map(([t, list]) => list.length ? `<h2 class="sectionh">${t} <span class="muted small">${list.length}</span></h2><div class="stack">${list.map(card).join("")}</div>` : "").join("") || '<div class="card empty"><h2>No changes yet</h2><p>Ask for anything you want TradeOS to do differently. Small or large — a new chart, a reader for YouTube or reports, another data source, a new kind of agent.</p></div>'}
      <p class="note">Every change is tested before it goes live and can be undone. Builds stay paper-only, never stores passwords or keys, and treats posts, pages and documents as information, never as instructions.</p>`;
    const f = $("chForm"); if (f) f.addEventListener("submit", async (e) => { e.preventDefault(); try { await fileChange({ request: $("chReq").value, area: $("chArea").value }, "system page"); $("chReq").value = ""; toast("Added. It's built the next time you say “build my TradeOS tickets”."); } catch (err) { toast(err.message || String(err)); } });
    box.querySelectorAll("form.chreply").forEach((fm) => fm.addEventListener("submit", async (e) => {
      e.preventDefault(); const c = S.changes.find((x) => x.id === fm.dataset.id), t = fm.t.value.trim(); if (!c || !t) return;
      try { await S.db.doc(`changes/${c.id}`).update({ thread: [...(c.thread || []), { who: "team", by: S.uid, by_name: S.me?.name || null, at: nowIso(), text: t.slice(0, 4000) }], status: "queued", origin: "user" }); toast("Sent — it's picked up at the next build."); } catch (err) { toast("Couldn't send: " + (err.message || err)); }
    }));
    box.querySelectorAll("[data-chcancel]").forEach((b) => b.addEventListener("click", async () => { try { await S.db.doc(`changes/${b.dataset.chcancel}`).update({ status: "cancelled" }); } catch (err) { toast(err.message || String(err)); } }));
    box.querySelectorAll("[data-chundo]").forEach((b) => b.addEventListener("click", async () => {
      const c = S.changes.find((x) => x.id === b.dataset.chundo); if (!c) return;
      if (b.dataset.sure !== "1") { b.dataset.sure = "1"; b.textContent = "Tap again to undo"; return; }
      try { await fileChange({ kind: "revert", target: c.id, title: `Undo: ${c.title}`, request: `Undo the change "${c.title}" (ticket ${c.id}${c.result?.commit ? `, commit ${c.result.commit}` : ""}) and put back how it worked before.`, area: c.area }, "system page"); toast("Undo added to the list."); } catch (err) { toast(err.message || String(err)); }
    }));
  }
