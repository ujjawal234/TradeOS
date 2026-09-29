"""Rule strategy agent: entry/exit conditions in the expression DSL on one or more symbols."""
from __future__ import annotations

import math

import pandas as pd

from ..backtest import backtest_signals, combine_equity, compute_metrics
from ..data.universe import norm
from ..rules import RuleEngine, validate
from ..storage import dstr
from .base import BaseAgent, register


@register
class RuleAgent(BaseAgent):
    type_name = "rule"
    description = ("Systematic long or short strategy on a list of symbols using the expression DSL. "
                   "Signal on today's close, fill at next day's open. Optional stop-loss / take-profit %. "
                   "Capital is split equally across symbols. Covers trend following, breakouts, mean reversion, "
                   "RSI/MACD/Bollinger systems, 'buy when it crosses X' etc. Symbols can be added any time.")
    defaults = {"symbols": [], "entry": "", "exit": "", "side": "long", "stop_loss_pct": None,
                "take_profit_pct": None, "capital": 1_000_000, "position_size_pct": 100, "cost_pct": 0.12}
    example = {"symbols": ["RELIANCE", "HDFCBANK", "INFY"],
               "entry": "cross_above(ema(close, 20), ema(close, 50)) and rsi(close, 14) > 50",
               "exit": "cross_below(ema(close, 20), ema(close, 50))", "stop_loss_pct": 7}

    @classmethod
    def _check(cls, s: dict) -> None:
        if isinstance(s["symbols"], str):
            s["symbols"] = [x for x in s["symbols"].replace(",", " ").split() if x]
        if not s["symbols"]:
            raise ValueError("rule agent needs at least one symbol")
        s["symbols"] = sorted({norm(x) for x in s["symbols"]})
        if s["side"] not in ("long", "short"):
            raise ValueError("side must be 'long' or 'short'")
        validate(s["entry"])
        if s.get("exit"):
            validate(s["exit"])
        elif not (s.get("stop_loss_pct") or s.get("take_profit_pct")):
            raise ValueError("Give an exit rule or a stop_loss_pct / take_profit_pct")

    def symbols(self) -> list[str]:
        return list(self.spec["symbols"])

    def _signals(self, df: pd.DataFrame) -> tuple[pd.Series, pd.Series | None]:
        eng = RuleEngine(df)
        entry = eng.condition(self.spec["entry"])
        exit_ = eng.condition(self.spec["exit"]) if self.spec.get("exit") else None
        return entry, exit_

    def _alloc(self) -> float:
        return float(self.spec["capital"]) / len(self.spec["symbols"])

    # ------------------------------------------------------------ backtest
    def backtest(self, start=None, end=None) -> dict:
        curves, caps, trades, per_symbol = [], [], [], {}
        for sym in self.spec["symbols"]:
            df = self.ctx.provider.history(sym, end=end)
            if len(df) < 60:
                per_symbol[sym] = {"note": "not enough data"}
                continue
            entry, exit_ = self._signals(df)  # indicators warm up on full history
            if start:
                keep = df.index >= pd.Timestamp(start)
                df, entry = df[keep], entry[keep]
                exit_ = exit_[keep] if exit_ is not None else None
            r = backtest_signals(df, entry, exit_, self._alloc(), self.spec["side"],
                                 self.spec.get("stop_loss_pct"), self.spec.get("take_profit_pct"),
                                 self.spec["cost_pct"], self.spec["position_size_pct"], sym)
            curves.append(r.equity)
            caps.append(self._alloc())
            trades += r.trades
            per_symbol[sym] = {k: r.metrics.get(k) for k in
                               ("total_return_pct", "cagr_pct", "max_drawdown_pct", "trades", "win_rate_pct")}
        equity = combine_equity(curves, caps)
        return {"equity": equity, "trades": trades,
                "metrics": compute_metrics(equity, trades, self.ctx.settings.risk_free),
                "per_symbol": per_symbol}

    # ------------------------------------------------------------ paper
    def run_daily(self, asof) -> dict:
        b = self.broker()
        pending = self.state.setdefault("pending", {})
        data, sigs = {}, {}
        for sym in self.spec["symbols"]:
            df = self.ctx.provider.history(sym, end=asof).iloc[-600:]
            if len(df) >= 2:
                data[sym] = df
                sigs[sym] = self._signals(df)
        if not data:
            return {"signals": [], "note": "no data"}
        all_idx = pd.DatetimeIndex(sorted(set().union(*[df.index for df in data.values()])))
        dates = self.new_dates(all_idx, asof)
        cost, sl, tp = self.spec["cost_pct"] / 100, self.spec.get("stop_loss_pct"), self.spec.get("take_profit_pct")
        long_ = self.spec["side"] == "long"
        for d in dates:
            marks = {}
            for sym, df in data.items():
                if d not in df.index:
                    continue
                bar = df.loc[d]
                marks[sym] = float(bar["close"])
                q = b.qty(sym)
                # 1) fill yesterday's orders at today's open
                p = pending.get(sym)
                if p and pd.Timestamp(p["created"]) < d:
                    px = float(bar["open"])
                    if p["action"] == "enter" and q == 0:
                        n = math.floor(min(self._alloc() * self.spec["position_size_pct"] / 100, b.cash)
                                       / (px * (1 + cost)))
                        if n > 0:
                            b.execute(d, sym, n if long_ else -n, px, note="entry fill")
                            self.signal(d, sym, "FILLED", px, f"{'Bought' if long_ else 'Shorted'} {n} @ {px:.2f}")
                    elif p["action"] == "exit" and q != 0:
                        b.execute(d, sym, -q, px, note="exit fill")
                        self.signal(d, sym, "FILLED", px, f"Closed {abs(q):.0f} @ {px:.2f}")
                    pending.pop(sym, None)
                    q = b.qty(sym)
                # 2) stop-loss / take-profit intrabar
                if q:
                    avg = b.positions()[sym]["avg_price"]
                    o, h, l = float(bar["open"]), float(bar["high"]), float(bar["low"])
                    hit = None
                    if long_:
                        if sl and l <= avg * (1 - sl / 100):
                            hit = ("stop loss", min(o, avg * (1 - sl / 100)))
                        elif tp and h >= avg * (1 + tp / 100):
                            hit = ("take profit", max(o, avg * (1 + tp / 100)))
                    else:
                        if sl and h >= avg * (1 + sl / 100):
                            hit = ("stop loss", max(o, avg * (1 + sl / 100)))
                        elif tp and l <= avg * (1 - tp / 100):
                            hit = ("take profit", min(o, avg * (1 - tp / 100)))
                    if hit:
                        b.execute(d, sym, -q, hit[1], note=hit[0])
                        self.signal(d, sym, hit[0].upper(), hit[1], f"{hit[0]} hit, closed @ {hit[1]:.2f}")
                        q = 0
                # 3) today's signals -> orders for tomorrow's open
                entry, exit_ = sigs[sym]
                if q and exit_ is not None and bool(exit_.get(d, False)):
                    pending[sym] = {"action": "exit", "created": dstr(d)}
                    self.signal(d, sym, "EXIT", marks[sym], "Exit signal: will close at next open")
                elif not q and sym not in pending and bool(entry.get(d, False)):
                    pending[sym] = {"action": "enter", "created": dstr(d)}
                    act = "BUY" if long_ else "SHORT"
                    self.signal(d, sym, act, marks[sym], f"Entry signal: {act.lower()} at next open")
            b.mark(d, {**{s: float(df["close"].loc[:d].iloc[-1]) for s, df in data.items()}, **marks})
            self.state["last_processed"] = dstr(d)
        self.save_state()
        return {"signals": self._emitted, "bars_processed": len(dates)}

    def status(self) -> dict:
        return {"pending_orders": self.state.get("pending", {})}
