"""Alert agent: notify when a condition on a symbol becomes true. No trading."""
from __future__ import annotations

import uuid

import numpy as np
import pandas as pd

from ..data.universe import norm
from ..rules import RuleEngine, validate
from ..storage import dstr
from .base import BaseAgent, register


def normalize_alert(a: dict) -> dict:
    a = dict(a)
    if not a.get("symbol"):
        raise ValueError("Each alert needs a 'symbol'")
    a["symbol"] = norm(a["symbol"])
    if "expr" not in a:
        if "above" in a:
            a["expr"] = f"close > {float(a['above'])}"
        elif "below" in a:
            a["expr"] = f"close < {float(a['below'])}"
        elif "touch_above" in a:
            a["expr"] = f"high >= {float(a['touch_above'])}"
        elif "touch_below" in a:
            a["expr"] = f"low <= {float(a['touch_below'])}"
        elif "move_pct" in a:
            a["expr"] = f"abs(roc(close, 1)) >= {float(a['move_pct'])}"
        else:
            raise ValueError("Alert needs one of: expr, above, below, touch_above, touch_below, move_pct")
    validate(a["expr"])
    a.setdefault("message", f"{a['symbol']}: {a['expr']}")
    a.setdefault("id", uuid.uuid4().hex[:6])
    return a


@register
class AlertAgent(BaseAgent):
    type_name = "alert"
    description = ("Watches symbols and notifies when a condition becomes true: price crosses a level, "
                   "an indicator condition (e.g. RSI < 30, close below 200 DMA), or a big daily move. "
                   "trigger='cross' fires once when the condition turns true; 'level' fires every day it is true. "
                   "Backtest shows past trigger dates and what the price did 5/20 days later. No trading.")
    defaults = {"alerts": [], "trigger": "cross"}
    example = {"alerts": [{"symbol": "RELIANCE", "above": 3000, "message": "Reliance above 3000"},
                          {"symbol": "NIFTY", "expr": "cross_below(close, sma(close, 200))"},
                          {"symbol": "HDFCBANK", "expr": "rsi(close, 14) < 30"}],
               "trigger": "cross"}

    @classmethod
    def _check(cls, s: dict) -> None:
        if s["trigger"] not in ("cross", "level"):
            raise ValueError("trigger must be 'cross' or 'level'")
        s["alerts"] = [normalize_alert(a) for a in s["alerts"]]

    def symbols(self) -> list[str]:
        return sorted({a["symbol"] for a in self.spec["alerts"]})

    def _fires(self, cond: pd.Series) -> pd.Series:
        if self.spec["trigger"] == "cross":
            return cond & ~cond.shift(1, fill_value=False)
        return cond

    def run_daily(self, asof) -> dict:
        seen = self.state.setdefault("seen", {})
        checked = 0
        for a in self.spec["alerts"]:
            df = self.ctx.provider.history(a["symbol"], end=asof).iloc[-400:]
            if len(df) < 2:
                continue
            fires = self._fires(RuleEngine(df).condition(a["expr"]))
            last = seen.get(a["id"])
            todo = fires.index[fires.index > pd.Timestamp(last)][-10:] if last else fires.index[-1:]
            for d in todo:
                if bool(fires.loc[d]):
                    self.signal(d, a["symbol"], "ALERT", df.loc[d, "close"], a["message"])
            seen[a["id"]] = dstr(df.index[-1])
            checked += 1
        self.state["last_processed"] = dstr(pd.Timestamp(asof))
        self.save_state()
        return {"signals": self._emitted, "checked": checked}

    def backtest(self, start=None, end=None) -> dict:
        out = []
        for a in self.spec["alerts"]:
            df = self.ctx.provider.history(a["symbol"], end=end)
            fires = self._fires(RuleEngine(df).condition(a["expr"]))
            if start:
                fires = fires[fires.index >= pd.Timestamp(start)]
            c = df["close"]
            events = []
            for d in fires.index[fires.values]:
                i = c.index.get_loc(d)
                f5 = (c.iloc[i + 5] / c.iloc[i] - 1) * 100 if i + 5 < len(c) else np.nan
                f20 = (c.iloc[i + 20] / c.iloc[i] - 1) * 100 if i + 20 < len(c) else np.nan
                events.append({"date": dstr(d), "close": round(float(c.iloc[i]), 2),
                               "fwd_5d_pct": None if np.isnan(f5) else round(float(f5), 2),
                               "fwd_20d_pct": None if np.isnan(f20) else round(float(f20), 2)})
            f5s = [e["fwd_5d_pct"] for e in events if e["fwd_5d_pct"] is not None]
            f20s = [e["fwd_20d_pct"] for e in events if e["fwd_20d_pct"] is not None]
            out.append({
                "symbol": a["symbol"], "expr": a["expr"], "times_triggered": len(events),
                "avg_fwd_5d_pct": round(float(np.mean(f5s)), 2) if f5s else None,
                "avg_fwd_20d_pct": round(float(np.mean(f20s)), 2) if f20s else None,
                "pct_up_after_20d": round(100 * float(np.mean([x > 0 for x in f20s])), 1) if f20s else None,
                "last_triggers": events[-5:],
            })
        return {"alerts": out}
