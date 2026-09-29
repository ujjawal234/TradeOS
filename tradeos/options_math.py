"""Black-Scholes pricing and NSE expiry helpers for model-priced option backtests."""
from __future__ import annotations

import math

import pandas as pd


def _ncdf(x: float) -> float:
    return 0.5 * (1 + math.erf(x / math.sqrt(2)))


def intrinsic(S: float, K: float, kind: str) -> float:
    return max(0.0, S - K) if kind == "CE" else max(0.0, K - S)


def bs_price(S: float, K: float, T: float, r: float, sigma: float, kind: str) -> float:
    if T <= 0 or sigma <= 0:
        return intrinsic(S, K, kind)
    st = sigma * math.sqrt(T)
    d1 = (math.log(S / K) + (r + 0.5 * sigma ** 2) * T) / st
    d2 = d1 - st
    if kind == "CE":
        return S * _ncdf(d1) - K * math.exp(-r * T) * _ncdf(d2)
    return K * math.exp(-r * T) * _ncdf(-d2) - S * _ncdf(-d1)


def bs_delta(S: float, K: float, T: float, r: float, sigma: float, kind: str) -> float:
    if T <= 0 or sigma <= 0:
        itm = S > K if kind == "CE" else S < K
        return (1.0 if kind == "CE" else -1.0) if itm else 0.0
    d1 = (math.log(S / K) + (r + 0.5 * sigma ** 2) * T) / (sigma * math.sqrt(T))
    return _ncdf(d1) if kind == "CE" else _ncdf(d1) - 1


def last_weekday_of_month(year: int, month: int, weekday: int) -> pd.Timestamp:
    last = pd.Timestamp(year, month, 1) + pd.offsets.MonthEnd(0)
    return last - pd.Timedelta(days=(last.weekday() - weekday) % 7)


def next_expiry(d: pd.Timestamp, weekday: int, monthly: bool) -> pd.Timestamp:
    """First expiry date on or after d. (Exchange holiday shifts are not modelled.)"""
    d = pd.Timestamp(d).normalize()
    if not monthly:
        return d + pd.Timedelta(days=(weekday - d.weekday()) % 7)
    e = last_weekday_of_month(d.year, d.month, weekday)
    if e < d:
        nm = d + pd.offsets.MonthBegin(1)
        e = last_weekday_of_month(nm.year, nm.month, weekday)
    return e
