/* TradeOS alerts: rules the team sets on markets, the book, desks, agents and news, evaluated on the latest data.
   Used by the app (to show what is firing now) and by the daily job (to record and push). Pure; no storage.
   Rule shapes:
     {kind:"price",    sym, expr, mode:"cross"|"while"}        rule-language condition on a symbol, e.g. "close > 2500", "rsi(close,14) < 30"
     {kind:"drawdown", scope:"book"|"desk"|"agent", id_ref, pct}   fall from the peak deeper than pct
     {kind:"move",     scope:"book"|"desk"|"agent", id_ref, pct}   one-day change beyond ±pct
     {kind:"signal",   agent_id}                               the agent has buy/sell orders for the next session
     {kind:"news",     sym, query}                             new NSE filing or headline for a symbol / matching words
     {kind:"results",  sym, days}                              board meeting for results within N days */
(function (root) {
  "use strict";
  function evalAlerts({ alerts, E, frame, date, book, news, events, signals, since }) {
    const out = [];
    for (const al of alerts || []) {
      if (al.active === false) continue;
      try {
        const hit = check(al); if (hit) out.push({ alert_id: al.id, date, severity: al.severity || hit.severity || "info", title: hit.title, detail: hit.detail || "", sym: al.sym || null });
      } catch (e) { out.push({ alert_id: al.id, date, severity: "warning", title: `${al.name || "Alert"} can't run`, detail: String(e.message || e), error: true }); }
    }
    return out;

    function check(al) {
      const nm = al.name || "";
      if (al.kind === "price") {
        const f = frame(al.sym); if (!f) throw new Error(`no data for ${al.sym}`);
        const v = E.evaluate(E.parse(al.expr), f, {}); const n = f.c.length, now = typeof v === "number" ? v : v[n - 1], prev = typeof v === "number" ? v : v[n - 2];
        const on = now === now && now !== 0, was = prev === prev && prev !== 0;
        if (on && (al.mode === "while" || !was)) return { title: nm || `${al.sym}: ${al.expr}`, detail: `${al.sym} closed at ${f.c[n - 1].toFixed(2)} on ${E.isoOf(f.d[n - 1])}` };
        return null;
      }
      if (al.kind === "drawdown" || al.kind === "move") {
        const s = book && book.series && book.series(al.scope, al.id_ref); if (!s || s.length < 2) return null;
        const last = s[s.length - 1], prev = s[s.length - 2];
        if (al.kind === "drawdown") { const pk = Math.max(...s); const dd = (last / pk - 1) * 100; return dd <= -Math.abs(al.pct) ? { title: nm || `${book.label(al.scope, al.id_ref)} is ${dd.toFixed(1)}% below its peak`, detail: `Limit ${al.pct}%`, severity: "critical" } : null; }
        const ch = (last / prev - 1) * 100; return Math.abs(ch) >= Math.abs(al.pct) ? { title: nm || `${book.label(al.scope, al.id_ref)} moved ${ch > 0 ? "+" : ""}${ch.toFixed(2)}% today`, detail: `Threshold ±${al.pct}%`, severity: Math.abs(ch) >= 2 * Math.abs(al.pct) ? "critical" : "warning" } : null;
      }
      if (al.kind === "signal") {
        const sg = (signals && signals[al.agent_id]) || []; const act = sg.filter((x) => /BUY|SELL|SHORT|COVER|NEW/.test(x.action) && x.due !== false);
        return act.length ? { title: nm || `${act.length} order(s) for the next open`, detail: act.slice(0, 8).map((x) => `${x.action} ${x.symbol}`).join(", ") } : null;
      }
      if (al.kind === "news") {
        const rx = al.query ? new RegExp(String(al.query).replace(/[^\w\s|&-]/g, ""), "i") : null, from = al.last_checked || since || "";
        const hits = (news || []).filter((x) => x.t > from && (!al.sym || x.sym === al.sym || (x.syms || []).includes(al.sym)) && (!rx || rx.test(x.text)));
        return hits.length ? { title: nm || `${hits.length} new item(s)${al.sym ? " on " + al.sym : ""}`, detail: hits.slice(0, 3).map((x) => x.text).join(" · ") } : null;
      }
      if (al.kind === "results") {
        const lim = E.isoOf(E.dayOf(date) + (al.days || 7)); const ev = (events || []).find((e) => e.sym === al.sym && /result/i.test(e.purpose) && e.date >= date && e.date <= lim);
        return ev ? { title: nm || `${al.sym} results on ${ev.date}`, detail: ev.purpose } : null;
      }
      return null;
    }
  }
  const api = { evalAlerts };
  if (typeof module !== "undefined" && module.exports) module.exports = api; else root.TradeAlerts = api;
})(typeof window !== "undefined" ? window : globalThis);
