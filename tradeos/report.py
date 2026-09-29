"""Daily paper-trading report (markdown) + a short text summary for Telegram."""
from __future__ import annotations


def _money(x) -> str:
    return "-" if x is None else f"₹{x:,.0f}"


def _pct(x) -> str:
    return "-" if x is None else f"{x:+.2f}%"


def build_daily_report(manager, asof: str, results: list[dict]) -> tuple[str, str]:
    lines = [f"# TradeOS daily report — {asof}", "", "Paper trading only. Not investment advice.", "",
             "| Agent | Type | Equity | Day P&L | Since start | Positions | New signals |",
             "|---|---|---|---|---|---|---|"]
    short = [f"TradeOS {asof}"]
    sections = []
    for r in results:
        a = r["agent"]
        rep = manager.agent_report(a["id"], signals_limit=0)
        acct = rep.get("account") or {}
        sigs = r.get("signals", [])
        lines.append(f"| {a['name']} (`{a['id']}`) | {a['type']} | {_money(acct.get('equity'))} | "
                     f"{_money(acct.get('day_pnl'))} | {_pct(acct.get('total_return_pct'))} | "
                     f"{len(rep.get('positions', []))} | {len(sigs)} |")
        short.append(f"• {a['name']}: {_pct(acct.get('total_return_pct'))} total, {len(sigs)} signal(s)"
                     + (f" — ERROR {r['error']}" if r.get("error") else ""))
        sec = [f"## {a['name']} · {a['type']} · `{a['id']}`", ""]
        if r.get("error"):
            sec.append(f"**Error:** {r['error']}")
        if r.get("note"):
            sec.append(f"_{r['note']}_")
        if sigs:
            sec.append("**Signals**")
            sec += [f"- {s['date']} **{s['action']}** {s['symbol']}"
                    + (f" @ {s['price']:,.2f}" if s.get("price") else "") + f" — {s['message']}" for s in sigs]
        if rep.get("positions"):
            sec += ["", "**Open positions**", "", "| Symbol | Qty | Avg | Since |", "|---|---|---|---|"]
            sec += [f"| {p['symbol']} | {p['qty']:g} | {p['avg_price']:,.2f} | {p['opened']} |"
                    for p in rep["positions"]]
        extra = rep.get("status") or {}
        if extra.get("ranking_pct"):
            sec.append("")
            sec.append("**Current ranking (momentum %)**: " +
                       ", ".join(f"{k} {v:+.1f}" for k, v in list(extra["ranking_pct"].items())[:8]))
        if extra.get("summary"):
            sec += ["", f"**Research summary:** {extra['summary']}"]
        if extra.get("last_cycles"):
            sec.append("")
            sec.append("**Recent option cycles:** " + "; ".join(
                f"{c['exit_date']} {c['reason']} {_money(c['pnl'])}" for c in extra["last_cycles"]))
        sections.append("\n".join(sec))
    return "\n".join(lines) + "\n\n" + "\n\n".join(sections) + "\n", "\n".join(short)
