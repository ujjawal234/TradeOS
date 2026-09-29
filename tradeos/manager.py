"""The Manager is the Main Agent's body: it owns data, storage and every sub-agent.

It can create, update, pause, resume and destroy agents, backtest them, run the daily
paper cycle and build reports. The LLM brain (brain.py) drives it through tools, and the
CLI drives it directly — both go through exactly the same methods.
"""
from __future__ import annotations

import logging
from datetime import datetime

import pandas as pd

from .agents import AGENT_TYPES, AgentContext, BaseAgent
from .agents.alert import normalize_alert
from .analytics import price_summary, rank_universe
from .backtest import benchmark, save_backtest
from .config import Settings, get_settings
from .data import get_provider, norm
from .llm import LLM
from .notify import Notifier
from .report import build_daily_report
from .storage import Store, dstr

log = logging.getLogger("tradeos")


def today_ist() -> pd.Timestamp:
    return pd.Timestamp.now(tz="Asia/Kolkata").normalize().tz_localize(None)


class Manager:
    def __init__(self, settings: Settings | None = None, provider=None, store: Store | None = None,
                 notifier: Notifier | None = None, llm=None, quiet: bool = False):
        self.settings = settings or get_settings()
        self.provider = provider or get_provider(self.settings.provider, self.settings)
        self.store = store or Store(self.settings.db_path)
        self.notifier = notifier or Notifier(self.settings, quiet=quiet)
        self._llm = llm
        self.ctx = AgentContext(self.provider, self.store, self.notifier, self.settings, self.get_llm)

    def get_llm(self) -> LLM:
        if self._llm is None:
            self._llm = LLM(self.settings)
        return self._llm

    # ------------------------------------------------------------------ registry
    @staticmethod
    def agent_types() -> list[dict]:
        return [cls.info() for cls in AGENT_TYPES.values()]

    def _row(self, aid: str) -> dict:
        row = self.store.get_agent(aid)
        if not row:
            raise KeyError(f"No agent with id '{aid}'")
        return row

    def agent(self, aid: str) -> BaseAgent:
        row = self._row(aid)
        return AGENT_TYPES[row["type"]](row, self.ctx)

    def create_agent(self, type_: str, name: str, spec: dict) -> dict:
        if type_ not in AGENT_TYPES:
            raise ValueError(f"Unknown agent type '{type_}'. Types: {', '.join(AGENT_TYPES)}")
        full = AGENT_TYPES[type_].validate(spec or {})
        aid = self.store.add_agent(name, type_, full)
        return {"id": aid, "name": name, "type": type_, "spec": full}

    def list_agents(self, include_destroyed: bool = False) -> list[dict]:
        out = []
        for r in self.store.list_agents(include_destroyed):
            eq = self.store.equity_series(r["id"])
            out.append({"id": r["id"], "name": r["name"], "type": r["type"], "status": r["status"],
                        "created_at": r["created_at"], "last_processed": r["state"].get("last_processed"),
                        "equity": round(eq[-1][1], 2) if eq else None})
        return out

    def update_agent(self, aid: str, patch: dict) -> dict:
        row = self._row(aid)
        spec = {**row["spec"], **(patch or {})}
        full = AGENT_TYPES[row["type"]].validate(spec)
        self.store.update_agent(aid, spec=full)
        return {"id": aid, "spec": full}

    def set_status(self, aid: str, status: str) -> dict:
        if status not in ("active", "paused"):
            raise ValueError("status must be active or paused")
        self._row(aid)
        self.store.update_agent(aid, status=status)
        return {"id": aid, "status": status}

    def destroy_agent(self, aid: str, liquidate: bool = True) -> dict:
        ag = self.agent(aid)
        closed = ag.liquidate(today_ist()) if liquidate else []
        self.store.update_agent(aid, status="destroyed")
        return {"id": aid, "status": "destroyed", "closed": closed}

    def add_symbols(self, aid: str, symbols: list[str]) -> dict:
        row = self._row(aid)
        spec = row["spec"]
        if row["type"] == "rule":
            spec["symbols"] = sorted(set(spec["symbols"]) | {norm(s) for s in symbols})
        elif row["type"] == "rotation" and isinstance(spec["universe"], list):
            spec["universe"] = sorted(set(spec["universe"]) | {norm(s) for s in symbols})
        else:
            raise ValueError(f"add_symbols works for rule agents and rotation agents with a custom list. "
                             f"For alert agents use add_alert.")
        return self.update_agent(aid, spec)

    def remove_symbols(self, aid: str, symbols: list[str]) -> dict:
        row = self._row(aid)
        spec, drop = row["spec"], {norm(s) for s in symbols}
        key = "symbols" if row["type"] == "rule" else "universe"
        if not isinstance(spec.get(key), list):
            raise ValueError("This agent has no editable symbol list")
        spec[key] = [s for s in spec[key] if s not in drop]
        return self.update_agent(aid, spec)

    def add_alert(self, aid: str, alert: dict) -> dict:
        row = self._row(aid)
        if row["type"] != "alert":
            raise ValueError("add_alert only works on alert agents")
        row["spec"]["alerts"].append(normalize_alert(alert))
        return self.update_agent(aid, row["spec"])

    def remove_alert(self, aid: str, alert_id: str) -> dict:
        row = self._row(aid)
        row["spec"]["alerts"] = [a for a in row["spec"]["alerts"] if a.get("id") != alert_id]
        return self.update_agent(aid, row["spec"])

    # ------------------------------------------------------------------ backtest
    def backtest(self, aid: str, start: str | None = None, end: str | None = None, save: bool = True) -> dict:
        ag = self.agent(aid)
        res = ag.backtest(start, end)
        equity = res.pop("equity", None)
        trades = res.get("trades", [])
        summary = {k: v for k, v in res.items() if k != "trades"}
        if equity is not None and len(equity) > 1:
            bench_curve, bench = benchmark(self.provider, equity, rf=self.settings.risk_free)
            summary["benchmark_nifty"] = bench
            if save:
                folder = self.settings.backtests_dir / f"{aid}_{datetime.now():%Y%m%d_%H%M%S}"
                save_backtest(folder, f"{ag.name} ({ag.type_name})", equity, trades, summary, bench_curve)
                summary["output_folder"] = str(folder)
            summary["recent_trades"] = [t for t in trades if not t.get("open")][-10:]
            summary["open_trades"] = [t for t in trades if t.get("open")]
        self.store.add_run(aid, "backtest", dstr(today_ist()), summary)
        return summary

    # ------------------------------------------------------------------ daily paper cycle
    def run_daily(self, asof=None, agent_ids: list[str] | None = None, notify_summary: bool = True) -> dict:
        asof = pd.Timestamp(asof) if asof else today_ist()
        results = []
        for row in self.store.list_agents():
            if row["status"] != "active" or (agent_ids and row["id"] not in agent_ids):
                continue
            entry = {"agent": row, "signals": []}
            try:
                out = AGENT_TYPES[row["type"]](row, self.ctx).run_daily(asof) or {}
                entry["signals"] = out.get("signals", [])
                entry["note"] = out.get("note")
            except Exception as e:
                log.exception("agent %s failed", row["id"])
                entry["error"] = f"{type(e).__name__}: {e}"
            results.append(entry)
        md, short = build_daily_report(self, dstr(asof), results)
        path = self.settings.reports_dir / f"{dstr(asof)}.md"
        path.write_text(md, encoding="utf-8")
        if notify_summary and results:
            self.notifier.send(short)
        return {"date": dstr(asof), "report": str(path), "agents": len(results),
                "signals": sum(len(r["signals"]) for r in results),
                "errors": {r["agent"]["id"]: r["error"] for r in results if r.get("error")}}

    # ------------------------------------------------------------------ reporting
    def agent_report(self, aid: str, signals_limit: int = 15) -> dict:
        row = self._row(aid)
        acct = self.store.get_account(aid)
        eq = self.store.equity_series(aid)
        account = None
        if acct:
            last = eq[-1][1] if eq else acct["cash"]
            prev = eq[-2][1] if len(eq) > 1 else acct["initial"]
            account = {"initial": acct["initial"], "cash": round(acct["cash"], 2), "equity": round(last, 2),
                       "day_pnl": round(last - prev, 2),
                       "total_return_pct": round((last / acct["initial"] - 1) * 100, 2),
                       "since": eq[0][0] if eq else None, "days": len(eq)}
            if len(eq) > 1:
                s = pd.Series([e for _, e in eq])
                account["max_drawdown_pct"] = round(float((s / s.cummax() - 1).min() * 100), 2)
        try:
            status = AGENT_TYPES[row["type"]](row, self.ctx).status()
        except Exception as e:
            status = {"error": str(e)}
        bts = self.store.list_runs(aid, "backtest", 1)
        return {
            "id": aid, "name": row["name"], "type": row["type"], "status": row["status"], "spec": row["spec"],
            "account": account,
            "positions": [{k: p[k] for k in ("symbol", "qty", "avg_price", "opened")}
                          for p in self.store.get_positions(aid).values()],
            "recent_trades": self.store.list_trades(aid, 10),
            "recent_signals": self.store.list_signals(aid, signals_limit) if signals_limit else [],
            "last_backtest": ({k: bts[0]["summary"].get(k) for k in ("metrics", "benchmark_nifty", "output_folder")}
                              | {"run_date": bts[0]["run_date"]}) if bts else None,
            "status": status,
        }

    # ------------------------------------------------------------------ market tools
    def rank(self, universe="sectors", asof=None, top: int | None = None) -> list[dict]:
        df = rank_universe(self.provider, universe, asof)
        return df.head(top).to_dict("records") if top else df.to_dict("records")

    def price_summary(self, symbol: str, asof=None) -> dict:
        return price_summary(self.provider, symbol, asof)
