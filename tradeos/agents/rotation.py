"""Rotation agent: momentum / relative-strength rotation across stocks or sectors."""
from __future__ import annotations

import math

import numpy as np
import pandas as pd

from ..backtest import compute_metrics
from ..data.universe import is_index, resolve_universe
from ..paper import PaperBroker
from ..storage import Store, dstr
from .base import BaseAgent, register


@register
class RotationAgent(BaseAgent):
    type_name = "rotation"
    description = ("Momentum / relative-strength rotation. Ranks a universe (nifty50 stocks, sector indices, or your "
                   "own list) by past return (skipping the most recent weeks), holds the top N equally weighted and "
                   "rebalances weekly or monthly. Optional trend filter goes to cash when Nifty is below its 200 DMA. "
                   "Its daily ranking also answers 'which sectors / stocks are leading right now'.")
    defaults = {"universe": "nifty50", "lookback": 126, "skip": 21, "top_n": 5, "rebalance": "monthly",
                "score": "momentum", "min_score": None, "trend_filter": None,  # no hidden filters
                "rebalance_band_pct": 1.0, "capital": 1_000_000, "cost_pct": 0.12}
    example = {"universe": "sectors", "lookback": 63, "skip": 5, "top_n": 3, "rebalance": "weekly",
               "trend_filter": None}

    @classmethod
    def _check(cls, s: dict) -> None:
        s["universe"] = s["universe"] if isinstance(s["universe"], str) else resolve_universe(s["universe"])
        resolve_universe(s["universe"])
        if s["rebalance"] not in ("weekly", "monthly"):
            raise ValueError("rebalance must be weekly or monthly")
        if s["score"] not in ("momentum", "risk_adj"):
            raise ValueError("score must be momentum or risk_adj")
        for k in ("lookback", "skip", "top_n"):
            s[k] = int(s[k])
        if s["top_n"] < 1 or s["lookback"] < 5:
            raise ValueError("top_n >= 1 and lookback >= 5 required")

    def universe(self) -> list[str]:
        return resolve_universe(self.spec["universe"])

    def symbols(self) -> list[str]:
        tf = self.spec.get("trend_filter")
        return self.universe() + ([tf["symbol"]] if tf else [])

    def _period(self, d: pd.Timestamp) -> list:
        return [d.year, d.month] if self.spec["rebalance"] == "monthly" else list(d.isocalendar()[:2])

    def _closes(self, end=None) -> pd.DataFrame:
        return self.ctx.provider.closes(self.symbols(), end=end).ffill()

    def ranking(self, closes: pd.DataFrame) -> pd.Series:
        lb, skip = self.spec["lookback"], self.spec["skip"]
        c = closes[[s for s in self.universe() if s in closes.columns]]
        if len(c) < lb + skip + 1:
            return pd.Series(dtype=float)
        mom = (c.iloc[-1 - skip] / c.iloc[-1 - skip - lb] - 1).dropna()
        if self.spec["score"] == "risk_adj":
            vol = c.pct_change(fill_method=None).iloc[-lb:].std() * np.sqrt(252)
            mom = (mom / vol.reindex(mom.index)).replace([np.inf, -np.inf], np.nan).dropna()
        return mom.sort_values(ascending=False)

    def target_weights(self, closes: pd.DataFrame) -> dict[str, float]:
        tf = self.spec.get("trend_filter")
        if tf and tf["symbol"] in closes:
            s = closes[tf["symbol"]].dropna()
            n = int(tf.get("sma", 200))
            if len(s) >= n and s.iloc[-1] < s.iloc[-n:].mean():
                return {}
        r = self.ranking(closes)
        if self.spec.get("min_score") is not None:
            r = r[r > float(self.spec["min_score"])]
        top = r.head(self.spec["top_n"])
        return {s: 1.0 / self.spec["top_n"] for s in top.index}  # unfilled slots stay in cash

    def _rebalance(self, b: PaperBroker, d, prices: pd.Series, weights: dict, emit: bool) -> None:
        marks = {k: float(v) for k, v in prices.dropna().items()}
        equity = b.equity(marks)
        band = equity * self.spec["rebalance_band_pct"] / 100
        cur = b.positions()
        orders = []
        for s in set(cur) | set(weights):
            p = marks.get(s)
            if not p or p <= 0:
                continue
            tq = equity * weights.get(s, 0.0) * 0.995 / p
            if not is_index(s):
                tq = math.floor(tq)
            cq = float(cur[s]["qty"]) if s in cur else 0.0
            dq = tq - cq
            if abs(dq) < 1e-9 or (tq != 0 and abs(dq * p) < band):
                continue
            orders.append((s, dq, p))
        for s, dq, p in sorted(orders, key=lambda o: o[1]):  # sells before buys
            b.execute(d, s, dq, p, note="rebalance")
            if emit:
                act = "BUY" if dq > 0 else "SELL"
                self.signal(d, s, act, p, f"Rebalance {act.lower()} {abs(dq):.2f} @ {p:.2f}")

    def backtest(self, start=None, end=None) -> dict:
        closes = self._closes(end)
        lb, skip = self.spec["lookback"], self.spec["skip"]
        b = PaperBroker(Store(), "bt", self.spec["capital"], self.spec["cost_pct"])
        first_ok = lb + skip + 2
        dates = closes.index[first_ok:]
        if start:
            dates = dates[dates >= pd.Timestamp(start)]
        last_period, eq, rebals = None, {}, 0
        for d in dates:
            i = closes.index.get_loc(d)
            per = self._period(d)
            if per != last_period:
                self._rebalance(b, d, closes.iloc[i], self.target_weights(closes.iloc[:i]), emit=False)
                last_period, rebals = per, rebals + 1
            eq[d] = b.mark(d, {k: float(v) for k, v in closes.iloc[i].dropna().items()})
        equity = pd.Series(eq)
        trades = b.store.list_trades("bt")
        m = compute_metrics(equity, None, self.ctx.settings.risk_free)
        m.update({"rebalances": rebals, "executions": len(trades),
                  "total_fees": round(sum(t["fees"] for t in trades), 2)})
        return {"equity": equity, "trades": trades[::-1], "metrics": m,
                "current_ranking": {k: round(float(v) * 100, 2) for k, v in self.ranking(closes).head(10).items()}}

    def run_daily(self, asof) -> dict:
        closes = self._closes(asof)
        if closes.empty:
            return {"signals": [], "note": "no data"}
        d = closes.index[-1]
        if self.state.get("last_processed") == dstr(d):
            return {"signals": [], "note": "no new bar"}
        b = self.broker()
        per = self._period(d)
        if self.state.get("last_period") != per:
            w = self.target_weights(closes.iloc[:-1])
            self._rebalance(b, d, closes.iloc[-1], w, emit=True)
            self.state["last_period"] = per
            self.state["holdings_target"] = w
            if not w:
                self.signal(d, "-", "CASH", None, "Rebalance: no qualifying names / trend filter off -> cash",
                            notify=False)
        rank = self.ranking(closes)
        self.state["ranking_pct"] = {k: round(float(v) * 100, 2) for k, v in rank.head(10).items()}
        b.mark(d, {k: float(v) for k, v in closes.iloc[-1].dropna().items()})
        self.state["last_processed"] = dstr(d)
        self.save_state()
        return {"signals": self._emitted, "top": list(self.state["ranking_pct"])[:5]}

    def status(self) -> dict:
        return {"ranking_pct": self.state.get("ranking_pct", {}),
                "target_weights": self.state.get("holdings_target", {})}
