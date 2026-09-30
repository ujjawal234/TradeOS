  // ================================================================ select any part of the page and ask about it
  // Two ways in: (1) highlight text anywhere → a small "Ask …" bar; (2) "Select" mode → drag a box (or tap a card,
  // table row or chart). The selection becomes a "snippet" attachment: the readable text in that area (table rows with
  // their header, label: value pairs, KPI tiles), the numbers behind any chart in it (for the dates covered by the box),
  // and — where this view can send images — a snapshot picture of the area.
  const selHit = (r, R) => r.width + r.height > 0 && r.right > R.left && r.left < R.right && r.bottom > R.top && r.top < R.bottom;
  const selTidy = (t) => String(t || "").replace(/[ \t ]+/g, " ").replace(/\s*\n\s*/g, "\n").trim();
  const selLine = (t) => selTidy(t).replace(/\n+/g, " · ");
  const SKIP = "svg, script, style, textarea, input, select, .tip, .composer, .chatrail .foot, .tabs, .seg, .menu, .order-add, button:not(.opt), label.btn, #selPop, #capOverlay";
  function whereNow() {
    if (S.view === "room") {
      const a = curAgent(), tab = document.querySelector('#roomTabs button[aria-selected="true"]')?.textContent?.trim() || "";
      return `agent "${a?.name || "?"}" v${S.room.ver ?? ""}${tab ? `, ${tab} tab` : ""}`;
    }
    return { main: "Main Agent conversation", agents: "Agents list", signals: "Today's signals" }[S.view] || String(S.view);
  }
  function headingFor(el) {
    const box = el.closest(".card, .proposal, .qcard, .msg, .chatrail, .agent-card, .panel");
    const h = box && box.querySelector("h1, h2, h3");
    return h ? selLine(h.innerText) : "";
  }
  const rowText = (tr) => [...tr.cells].map((c) => selLine(c.innerText)).join(" | ");

  // readable text inside a viewport rectangle, in page order, grouped into sensible units
  function regionText(R) {
    const root = document.querySelector("main.page"), found = [], seen = new Set(), range = document.createRange();
    const tw = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, { acceptNode: (n) => n.nodeValue.trim() && n.parentElement && !n.parentElement.closest(SKIP) && n.parentElement.offsetParent !== null ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT });
    for (let n; (n = tw.nextNode()) && found.length < 600;) {
      range.selectNodeContents(n);
      if (![...range.getClientRects()].some((r) => selHit(r, R))) continue;
      const p = n.parentElement;
      const u = p.closest("tr, .sig") || p.closest(".kpi, .mini, .nums > div, .ver, .rail-item, .order, .flag, .banner, .verdict, .note") || p.closest("li, dt, dd, p, h1, h2, h3, h4, .opt, .pill, .act, summary, label") || p;
      if (!seen.has(u)) { seen.add(u); found.push(u); }
    }
    const units = found.filter((u) => !found.some((o) => o !== u && o.contains(u)));
    const lines = [], tables = new Set(), usedDd = new Set();
    let lastBox = null;
    for (const u of units) {
      const box = u.closest(".card, .proposal, .qcard, .msg");
      if (box && box !== lastBox) { lastBox = box; const h = headingFor(u); if (h && !units.some((x) => /^H[1-3]$/.test(x.tagName) && x.closest(".card, .proposal, .qcard, .msg") === box)) lines.push(`## ${h}`); }
      if (u.tagName === "TR") {
        const tb = u.closest("table"), head = tb && tb.tHead && tb.tHead.rows[0];
        if (tb && !tables.has(tb)) { tables.add(tb); if (head && head !== u) lines.push(`[table columns] ${rowText(head)}`); }
        lines.push(rowText(u));
      } else if (u.tagName === "DT") {
        const dd = u.nextElementSibling; if (dd && dd.tagName === "DD") usedDd.add(dd);
        lines.push(`${selLine(u.innerText)}: ${dd && dd.tagName === "DD" ? selLine(dd.innerText) : ""}`);
      } else if (u.tagName === "DD") {
        if (usedDd.has(u)) continue;
        const dt = u.previousElementSibling; lines.push(`${dt && dt.tagName === "DT" ? selLine(dt.innerText) + ": " : ""}${selLine(u.innerText)}`);
      } else if (u.classList.contains("opt")) lines.push(`${selLine(u.innerText)}${u.getAttribute("aria-pressed") === "true" ? " (selected)" : ""}`);
      else lines.push(selLine(u.innerText));
    }
    return lines.filter((l, i) => l && l !== lines[i - 1]);
  }

  // numbers behind charts in the rectangle, limited to the dates the rectangle covers
  function regionCharts(R) {
    const out = [];
    document.querySelectorAll("main.page .chart").forEach((el) => {
      const c = el.__chart, svg = el.querySelector("svg"); if (!c || !svg || !c.days?.length) return;
      const r = svg.getBoundingClientRect(); if (!selHit(r, R)) return;
      const k = r.width / c.W, px0 = r.left + c.padL * k, px1 = r.right - c.padR * k, d0 = c.days[0], d1 = c.days[c.days.length - 1];
      const toDay = (x) => d0 + (Math.min(Math.max(x, px0), px1) - px0) / (px1 - px0 || 1) * (d1 - d0);
      const a = toDay(R.left), b = toDay(R.right);
      let i0 = 0; while (i0 < c.days.length - 1 && c.days[i0] < a) i0++;
      let i1 = c.days.length - 1; while (i1 > i0 && c.days[i1] > b) i1--;
      const f = (x) => x == null || !isFinite(x) ? "–" : Math.abs(x) >= 1000 ? Math.round(x).toLocaleString("en-IN") : (+x.toFixed(2)).toString();
      const iso = (i) => E.isoOf(c.days[i]);
      const title = headingFor(el) || c.title || "chart";
      const lines = [`[chart: ${title}${c.title && c.title !== title ? ` — ${c.title}` : ""}; selected ${iso(i0)} to ${iso(i1)}]`];
      for (const s of c.series) {
        const v = s.values; let lo = -1, hi = -1, first = -1, last = -1;
        for (let i = i0; i <= i1; i++) if (isFinite(v[i])) { if (first < 0) first = i; last = i; if (lo < 0 || v[i] < v[lo]) lo = i; if (hi < 0 || v[i] > v[hi]) hi = i; }
        if (first < 0) continue;
        const chg = v[first] > 0 && v[last] > 0 ? ` (${v[last] >= v[first] ? "+" : ""}${((v[last] / v[first] - 1) * 100).toFixed(1)}%)` : "";
        lines.push(`${s.name}: ${f(v[first])} on ${iso(first)} → ${f(v[last])} on ${iso(last)}${chg}; low ${f(v[lo])} on ${iso(lo)}, high ${f(v[hi])} on ${iso(hi)}`);
      }
      const n = Math.min(24, i1 - i0 + 1), pts = [];
      for (let j = 0; j < n; j++) { const i = Math.round(i0 + (i1 - i0) * j / Math.max(1, n - 1)); pts.push(`${iso(i)} ${c.series.map((s) => `${s.name} ${f(s.values[i])}`).join(", ")}`); }
      lines.push(`points: ${pts.join("; ")}`);
      out.push({ title, text: lines.join("\n") });
    });
    return out;
  }

  // a picture of the area (best effort; needs image support in this view)
  let h2cReady = null;
  async function pageSnapshot(R, where) {
    if (!S.images) return null;
    if (!h2cReady) h2cReady = loadScript("https://cdnjs.cloudflare.com/ajax/libs/html2canvas/1.4.1/html2canvas.min.js").catch((e) => { h2cReady = null; throw e; });
    await h2cReady;
    if (!window.html2canvas) return null;
    const root = document.querySelector("main.page"), rr = root.getBoundingClientRect();
    const x = Math.max(0, R.left - rr.left), y = Math.max(0, R.top - rr.top), w = Math.min(R.right, rr.right) - Math.max(R.left, rr.left), h = Math.min(R.bottom, rr.bottom) - Math.max(R.top, rr.top);
    if (w < 8 || h < 8) return null;
    const fix = (doc) => {
      const st = doc.createElement("style"); st.textContent = "blockquote.snip{background:transparent!important}*{transition:none!important;animation:none!important}"; doc.head.appendChild(st);
      const win = doc.defaultView;
      doc.querySelectorAll("main.page svg *").forEach((el) => { // SVG is drawn as a standalone image: inline the colours the page's CSS gives it
        const cs = win.getComputedStyle(el);
        for (const a of ["fill", "stroke", "stroke-width", "opacity", "font-size", "font-family", "font-weight"]) { const v = cs.getPropertyValue(a); if (v) el.setAttribute(a, v); }
      });
    };
    const cv = await Promise.race([
      window.html2canvas(root, { x, y, width: w, height: h, scale: Math.min(2, window.devicePixelRatio || 1), backgroundColor: getComputedStyle(document.body).backgroundColor, logging: false, onclone: fix }),
      new Promise((_, bad) => setTimeout(() => bad(new Error("snapshot timed out")), 12000))]);
    const blob = await canvasBlob(cv, "image/png");
    return { kind: "image", name: "Page snapshot", blob, thumb: await thumbOf(cv), snapshot: true, where };
  }

  // ---- the small floating bar
  let popKind = null;
  function hidePop() { $("selPop").hidden = true; popKind = null; }
  function showPop(r, label, acts, kind) {
    const p = $("selPop"); popKind = kind;
    p.innerHTML = (label ? `<span class="lbl" title="${esc(label)}">${esc(label)}</span>` : "") + acts.map(([t], i) => `<button type="button" data-i="${i}">${esc(t)}</button>`).join("") + (kind === "cap" ? '<button type="button" data-x aria-label="Cancel">✕</button>' : "");
    p.hidden = false;
    const w = p.offsetWidth, h = p.offsetHeight, vw = document.documentElement.clientWidth;
    let top = r.bottom + 10; if (top + h > window.innerHeight - 8) top = r.top - h - 10; if (top < 8) top = Math.min(window.innerHeight - h - 8, r.top + 8);
    const left = Math.min(Math.max(8, r.left + r.width / 2 - w / 2), vw - w - 8);
    p.style.top = `${top + window.scrollY}px`; p.style.left = `${left + window.scrollX}px`;
    p.querySelectorAll("[data-i]").forEach((b) => b.addEventListener("click", () => { hidePop(); acts[+b.dataset.i][1](); }));
    p.querySelector("[data-x]")?.addEventListener("click", hidePop);
    p.querySelector("button")?.focus({ preventScroll: true });
  }
  $("selPop").addEventListener("pointerdown", (e) => e.preventDefault()); // keep the highlighted text while pressing a button
  document.addEventListener("pointerdown", (e) => { if (popKind === "cap" && !e.target.closest("#selPop")) hidePop(); });
  window.addEventListener("scroll", () => { if (popKind === "sel") hidePop(); }, { passive: true });

  // put the pieces into the Main Agent's or this agent's composer
  function deliver(items, target) {
    items = items.filter(Boolean);
    if (!items.length) return;
    const room = target === "room" && S.view === "room";
    const list = room ? S.roomAttach : S.mainAttach, box = $(room ? "roomAttach" : "attachList");
    let skipped = 0;
    for (const it of items) { if (it.kind === "image" && imageCount(list) >= (S.images?.maxCount || 4)) { skipped++; continue; } list.push(it); }
    if (!room && S.view !== "main") go("");
    if (room) document.body.classList.add("chat-open");
    renderAttach(list, box);
    const input = $(room ? "roomInput" : "mainInput");
    setTimeout(() => { input.focus({ preventScroll: true }); if (!room) window.scrollTo({ top: document.body.scrollHeight }); }, 80);
    toast(`${room ? "Added to your message to this agent" : "Added to your message to the Main Agent"} — ask your question and send.${skipped ? " (Snapshot skipped: image limit reached.)" : ""}`);
  }
  function chooseTarget(r, label, items) {
    if (S.view !== "room") return deliver(items, "main");
    showPop(r, label, [["Ask this agent", () => deliver(items, "room")], ["Ask Main Agent", () => deliver(items, "main")]], "cap");
  }

  // ---- (1) highlighted text
  let selT = null;
  document.addEventListener("selectionchange", () => { clearTimeout(selT); selT = setTimeout(checkSelection, 300); });
  function checkSelection() {
    if (!$("capOverlay").hidden) return;
    const sel = window.getSelection(), txt = sel && !sel.isCollapsed ? sel.toString().trim() : "";
    const node = sel && sel.anchorNode, el = node && (node.nodeType === 1 ? node : node.parentElement);
    if (!txt || txt.length < 2 || !el || !el.closest("main.page") || el.closest("textarea, input, #selPop")) { if (popKind === "sel") hidePop(); return; }
    const where = whereNow(), ctx = headingFor(el), tb = el.closest("table"), head = tb && tb.tHead && tb.tHead.rows[0];
    const text = `${txt.slice(0, 12000)}${ctx ? `\n(in the section "${ctx}")` : ""}${head && !tb.tHead.contains(el) ? `\n(table columns: ${rowText(head)})` : ""}`;
    const snip = { kind: "snippet", name: txt.length > 42 ? `"${selLine(txt).slice(0, 40)}…"` : `"${selLine(txt)}"`, where, text };
    const r = sel.getRangeAt(0).getBoundingClientRect(), done = () => sel.removeAllRanges();
    const acts = S.view === "room" ? [["Ask this agent", () => { done(); deliver([snip], "room"); }], ["Ask Main Agent", () => { done(); deliver([snip], "main"); }]] : [["Ask Main Agent about this", () => { done(); deliver([snip], "main"); }]];
    showPop(r, null, acts, "sel");
  }

  // ---- (2) select mode: drag a box, or tap a card / row / chart
  const CAP = { target: null, start: null };
  function startCapture(target) {
    hidePop(); closeMenus(); document.body.classList.remove("chat-open"); window.getSelection()?.removeAllRanges();
    CAP.target = target; CAP.start = null;
    $("capOverlay").hidden = false; $("capRect").hidden = true; $("capHover").hidden = true;
    $("capHint").textContent = `Drag a box around anything — or tap a card, table row or chart${target === "room" ? " — for this agent" : ""}. Scroll first if needed.`;
  }
  function stopCapture() { $("capOverlay").hidden = true; CAP.start = null; }
  function pickAt(x, y) {
    const ov = $("capOverlay"); ov.style.pointerEvents = "none";
    const el = document.elementFromPoint(x, y); ov.style.pointerEvents = "";
    const main = document.querySelector("main.page");
    const t = el && main.contains(el) ? el.closest(".chart, tr, .sig, .kpi, .mini, .ver, .rail-item, .agent-card, .proposal, .qcard, .msg, dl.kv, .card, .panel") : null;
    return t && main.contains(t) ? t : null;
  }
  const boxOf = (a, b) => { const left = Math.min(a.x, b.x), top = Math.min(a.y, b.y), right = Math.max(a.x, b.x), bottom = Math.max(a.y, b.y); return { left, top, right, bottom, width: right - left, height: bottom - top }; };
  const place = (el, r) => Object.assign(el.style, { left: r.left + "px", top: r.top + "px", width: r.width + "px", height: r.height + "px" });
  const capOv = $("capOverlay");
  capOv.addEventListener("pointerdown", (e) => {
    if (e.target.closest(".hint")) return;
    e.preventDefault(); CAP.start = { x: e.clientX, y: e.clientY }; capOv.setPointerCapture(e.pointerId); $("capHover").hidden = true;
  });
  capOv.addEventListener("pointermove", (e) => {
    if (CAP.start) { const r = boxOf(CAP.start, { x: e.clientX, y: e.clientY }); $("capRect").hidden = false; place($("capRect"), r); return; }
    if (e.pointerType !== "mouse") return;
    const t = pickAt(e.clientX, e.clientY); $("capHover").hidden = !t; if (t) place($("capHover"), t.getBoundingClientRect());
  });
  capOv.addEventListener("pointerup", async (e) => {
    if (!CAP.start) return;
    const r = boxOf(CAP.start, { x: e.clientX, y: e.clientY }); CAP.start = null;
    let R = r;
    if (r.width < 12 || r.height < 12) { const t = pickAt(e.clientX, e.clientY); if (!t) { $("capRect").hidden = true; toast("Tap a card, table row or chart — or drag a box."); return; } R = t.getBoundingClientRect(); }
    const target = CAP.target; stopCapture();
    await captureRegion(R, target);
  });
  capOv.addEventListener("pointercancel", () => { CAP.start = null; $("capRect").hidden = true; });
  $("capCancel").addEventListener("click", stopCapture);
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") { if (!$("capOverlay").hidden) stopCapture(); if (popKind) hidePop(); } });
  $("capBtn").addEventListener("click", () => startCapture(null));
  document.querySelectorAll("[data-cap]").forEach((b) => b.addEventListener("click", () => startCapture(b.dataset.cap)));

  async function captureRegion(R, target) {
    R = { left: R.left, top: R.top, right: R.right, bottom: R.bottom, width: R.width, height: R.height }; // freeze before anything moves
    const where = whereNow(), lines = regionText(R), charts = regionCharts(R);
    if (!lines.length && !charts.length) { toast("Nothing readable there — try a bigger box."); return; }
    const rows = lines.filter((l) => l.includes(" | ") && !l.startsWith("[table")).length;
    const label = [charts.length ? `Chart: ${charts[0].title}${charts.length > 1 ? ` +${charts.length - 1}` : ""}` : "", rows ? `${rows} table row${rows > 1 ? "s" : ""}` : "",
      !charts.length && !rows ? `"${(lines.find((l) => !l.startsWith("## ")) || lines[0]).replace(/^## /, "").slice(0, 36)}${lines.join(" ").length > 36 ? "…" : ""}"` : ""].filter(Boolean).join(" + ");
    const text = [...charts.map((c) => c.text), lines.join("\n")].filter(Boolean).join("\n\n").slice(0, 16000);
    const snip = { kind: "snippet", name: label || "Page selection", where, text };
    let shot = null;
    if (S.images) { toast("Reading the selection…"); try { shot = await pageSnapshot(R, where); } catch (e) { shot = null; } }
    const anchor = { left: R.left, top: Math.max(R.top, 60), bottom: Math.min(R.bottom, window.innerHeight - 60), right: R.right, width: R.width, height: 0 };
    if (target) deliver([snip, shot], target); else chooseTarget(anchor, snip.name, [snip, shot]);
  }
