"""Backtest engine, performance metrics, benchmark comparison and output files."""
from __future__ import annotations

import json
import math
from dataclasses import dataclass, field
from pathlib import Path

import numpy as np
import pandas as pd


@dataclass
class BTResult:
    equity: pd.Series
    trades: list[dict] = field(default_factory=list)
    metrics: dict = field(default_factory=dict)


def compute_metrics(equity: pd.Series, trades: list[dict] | None = None, rf: float = 0.0) -> dict:
    eq = equity.dropna()
    if len(eq) < 2 or eq.iloc[0] <= 0:
        return {"note": "not enough data"}
    rets = eq.pct_change().dropna()
    years = max((eq.index[-1] - eq.index[0]).days / 365.25, 1e-9)
    total = eq.iloc[-1] / eq.iloc[0] - 1
    cagr = (1 + total) ** (1 / years) - 1 if total > -1 else -1.0
    vol = rets.std() * math.sqrt(252)
    sharpe = (rets.mean() * 252 - rf) / vol if vol > 0 else float("nan")
    dvol = rets[rets < 0].std() * math.sqrt(252)
    sortino = (rets.mean() * 252 - rf) / dvol if dvol and dvol > 0 else float("nan")
    dd = eq / eq.cummax() - 1
    mdd = dd.min()
    m = {
        "start": str(eq.index[0].date()), "end": str(eq.index[-1].date()), "years": round(years, 2),
        "start_equity": round(float(eq.iloc[0]), 2), "end_equity": round(float(eq.iloc[-1]), 2),
        "total_return_pct": round(float(total) * 100, 2), "cagr_pct": round(float(cagr) * 100, 2),
        "volatility_pct": round(float(vol) * 100, 2), "sharpe": round(float(sharpe), 2),
        "sortino": round(float(sortino), 2), "max_drawdown_pct": round(float(mdd) * 100, 2),
        "calmar": round(float(cagr / abs(mdd)), 2) if mdd < 0 else None,
    }
    closed = [t for t in (trades or []) if "pnl" in t and not t.get("open")]
    if closed:
        pnl = np.array([t["pnl"] for t in closed], dtype=float)
        wins, losses = pnl[pnl > 0], pnl[pnl <= 0]
        m.update({
            "trades": int(len(pnl)),
            "win_rate_pct": round(len(wins) / len(pnl) * 100, 1),
            "avg_trade_pnl": round(float(pnl.mean()), 2),
            "avg_win": round(float(wins.mean()), 2) if len(wins) else 0.0,
            "avg_loss": round(float(losses.mean()), 2) if len(losses) else 0.0,
            "profit_factor": round(float(wins.sum() / abs(losses.sum())), 2) if losses.sum() < 0 else None,
        })
    elif trades is not None:
        m["trades"] = 0
    return m


def backtest_signals(df: pd.DataFrame, entry: pd.Series, exit_: pd.Series | None, capital: float,
                     side: str = "long", sl_pct: float | None = None, tp_pct: float | None = None,
                     cost_pct: float = 0.12, size_pct: float = 100.0, symbol: str = "") -> BTResult:
    """Signal on bar t's close -> fill at bar t+1's open (no look-ahead).
    Stop-loss / take-profit are checked intrabar with gap-aware fills (stop wins ties)."""
    o, h, l, c = (df[k].to_numpy(float) for k in ("open", "high", "low", "close"))
    en = entry.reindex(df.index).fillna(False).to_numpy(bool)
    ex = (exit_.reindex(df.index).fillna(False).to_numpy(bool) if exit_ is not None
          else np.zeros(len(df), dtype=bool))
    n, cost, sgn = len(df), cost_pct / 100, (1 if side == "long" else -1)
    cash, qty, entry_px, entry_fee, entry_i = float(capital), 0.0, 0.0, 0.0, 0
    trades: list[dict] = []
    eq = np.full(n, float(capital))
    dates = df.index

    def close_pos(i: int, px: float, reason: str) -> None:
        nonlocal cash, qty
        fee = abs(qty) * px * cost
        cash += qty * px - fee
        pnl = qty * (px - entry_px) - fee - entry_fee
        trades.append({"symbol": symbol, "side": side, "entry_date": str(dates[entry_i].date()),
                       "entry_price": round(entry_px, 2), "exit_date": str(dates[i].date()),
                       "exit_price": round(px, 2), "qty": abs(qty), "pnl": round(pnl, 2),
                       "return_pct": round(sgn * (px / entry_px - 1) * 100, 2), "reason": reason,
                       "bars": i - entry_i})
        qty = 0.0

    for i in range(1, n):
        if qty and ex[i - 1]:
            close_pos(i, o[i], "exit signal")
        elif not qty and en[i - 1] and not ex[i - 1]:
            px = o[i]
            q = math.floor(cash * size_pct / 100 / (px * (1 + cost)))
            if q > 0:
                qty, entry_px, entry_i = sgn * q, px, i
                entry_fee = q * px * cost
                cash -= qty * px + entry_fee
        if qty:
            if side == "long":
                stop = entry_px * (1 - sl_pct / 100) if sl_pct else None
                tgt = entry_px * (1 + tp_pct / 100) if tp_pct else None
                if stop is not None and l[i] <= stop:
                    close_pos(i, min(o[i], stop), "stop loss")
                elif tgt is not None and h[i] >= tgt:
                    close_pos(i, max(o[i], tgt), "take profit")
            else:
                stop = entry_px * (1 + sl_pct / 100) if sl_pct else None
                tgt = entry_px * (1 - tp_pct / 100) if tp_pct else None
                if stop is not None and h[i] >= stop:
                    close_pos(i, max(o[i], stop), "stop loss")
                elif tgt is not None and l[i] <= tgt:
                    close_pos(i, min(o[i], tgt), "take profit")
        eq[i] = cash + qty * c[i]
    if qty:
        trades.append({"symbol": symbol, "side": side, "entry_date": str(dates[entry_i].date()),
                       "entry_price": round(entry_px, 2), "qty": abs(qty), "open": True,
                       "unrealized": round(qty * (c[-1] - entry_px), 2)})
    equity = pd.Series(eq, index=df.index, name=symbol or "equity")
    return BTResult(equity, trades, compute_metrics(equity, trades))


def combine_equity(curves: list[pd.Series], capitals: list[float]) -> pd.Series:
    if not curves:
        return pd.Series(dtype=float)
    idx = curves[0].index
    for cv in curves[1:]:
        idx = idx.union(cv.index)
    total = pd.Series(0.0, index=idx)
    for cv, cap in zip(curves, capitals):
        total += cv.reindex(idx).ffill().fillna(cap)
    return total


def benchmark(provider, equity: pd.Series, symbol: str = "NIFTY", rf: float = 0.0) -> tuple[pd.Series | None, dict]:
    """Buy-and-hold `symbol` on the strategy's dates, scaled to its starting equity.
    Uses the last close on or before each date, and the same risk-free rate as the strategy."""
    try:
        b = provider.history(symbol, end=equity.index[-1])["close"]
    except Exception:
        return None, {}
    b = b.reindex(b.index.union(equity.index)).ffill().reindex(equity.index).dropna()
    if len(b) < 2:
        return None, {}
    curve = b / b.iloc[0] * equity.iloc[0]
    m = compute_metrics(curve, None, rf)
    return curve, {k: m.get(k) for k in ("total_return_pct", "cagr_pct", "sharpe", "max_drawdown_pct")}


def save_backtest(folder: Path, title: str, equity: pd.Series, trades: list[dict], metrics: dict,
                  bench: pd.Series | None = None) -> Path:
    folder.mkdir(parents=True, exist_ok=True)
    equity.rename("equity").to_csv(folder / "equity.csv")
    pd.DataFrame(trades).to_csv(folder / "trades.csv", index=False)
    (folder / "metrics.json").write_text(json.dumps(metrics, indent=2, default=str))
    try:
        import matplotlib
        matplotlib.use("Agg")
        import matplotlib.pyplot as plt
        fig, (a1, a2) = plt.subplots(2, 1, figsize=(10, 6), sharex=True, gridspec_kw={"height_ratios": [3, 1]})
        a1.plot(equity.index, equity.values, label="Strategy", color="#1f6feb", lw=1.4)
        if bench is not None:
            a1.plot(bench.index, bench.values, label="NIFTY (buy & hold)", color="#8b949e", lw=1.1)
        a1.set_title(title)
        a1.legend(loc="upper left")
        a1.grid(alpha=0.25)
        dd = (equity / equity.cummax() - 1) * 100
        a2.fill_between(dd.index, dd.values, 0, color="#d1242f", alpha=0.35)
        a2.set_ylabel("Drawdown %")
        a2.grid(alpha=0.25)
        fig.tight_layout()
        fig.savefig(folder / "chart.png", dpi=110)
        plt.close(fig)
    except Exception:
        pass
    return folder
