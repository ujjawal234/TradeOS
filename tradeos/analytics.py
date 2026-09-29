"""Market analytics used by the Main Agent and sub-agents."""
from __future__ import annotations

import pandas as pd

from . import indicators as ind
from .data.universe import resolve_universe


def rank_universe(provider, universe="sectors", asof=None) -> pd.DataFrame:
    """Relative-strength table: 1m/3m/6m returns, trend flags and a composite score (0-1)."""
    closes = provider.closes(resolve_universe(universe), end=asof).ffill()
    rows = []
    for s in closes.columns:
        c = closes[s].dropna()
        if len(c) < 130:
            continue
        row = {"symbol": s, "last": round(float(c.iloc[-1]), 2)}
        for lbl, n in (("1m", 21), ("3m", 63), ("6m", 126)):
            row[f"ret_{lbl}_pct"] = round((c.iloc[-1] / c.iloc[-1 - n] - 1) * 100, 2)
        row["above_50dma"] = bool(c.iloc[-1] > c.iloc[-50:].mean())
        row["above_200dma"] = bool(len(c) >= 200 and c.iloc[-1] > c.iloc[-200:].mean())
        rows.append(row)
    df = pd.DataFrame(rows)
    if df.empty:
        return df
    df["score"] = (0.2 * df["ret_1m_pct"].rank(pct=True) + 0.4 * df["ret_3m_pct"].rank(pct=True)
                   + 0.4 * df["ret_6m_pct"].rank(pct=True)).round(3)
    return df.sort_values("score", ascending=False).reset_index(drop=True)


def price_summary(provider, symbol: str, asof=None, last_n: int = 10) -> dict:
    df = provider.history(symbol, end=asof)
    if df.empty:
        raise ValueError(f"No data for {symbol}")
    c = df["close"]

    def ret(n):
        return round((c.iloc[-1] / c.iloc[-1 - n] - 1) * 100, 2) if len(c) > n else None

    yr = c.iloc[-252:]
    return {
        "symbol": symbol.upper(), "date": str(c.index[-1].date()), "close": round(float(c.iloc[-1]), 2),
        "ret_1w_pct": ret(5), "ret_1m_pct": ret(21), "ret_3m_pct": ret(63), "ret_6m_pct": ret(126),
        "ret_1y_pct": ret(252), "high_52w": round(float(yr.max()), 2), "low_52w": round(float(yr.min()), 2),
        "sma50": round(float(ind.sma(c, 50).iloc[-1]), 2) if len(c) >= 50 else None,
        "sma200": round(float(ind.sma(c, 200).iloc[-1]), 2) if len(c) >= 200 else None,
        "rsi14": round(float(ind.rsi(c, 14).iloc[-1]), 1) if len(c) > 15 else None,
        "atr14_pct": round(float((ind.atr(df, 14) / c).iloc[-1] * 100), 2) if len(c) > 15 else None,
        "last_closes": {str(k.date()): round(float(v), 2) for k, v in c.iloc[-last_n:].items()},
    }
