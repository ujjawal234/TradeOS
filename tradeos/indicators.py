"""Technical indicators on pandas Series (vectorised, no look-ahead)."""
from __future__ import annotations

import numpy as np
import pandas as pd


def sma(x: pd.Series, n: int) -> pd.Series:
    n = int(n)
    return x.rolling(n, min_periods=n).mean()


def ema(x: pd.Series, n: int) -> pd.Series:
    n = int(n)
    return x.ewm(span=n, adjust=False, min_periods=n).mean()


def wma(x: pd.Series, n: int) -> pd.Series:
    n = int(n)
    w = np.arange(1, n + 1, dtype=float)
    return x.rolling(n, min_periods=n).apply(lambda a: float(np.dot(a, w) / w.sum()), raw=True)


def rsi(x: pd.Series, n: int = 14) -> pd.Series:
    n = int(n)
    d = x.diff()
    up = d.clip(lower=0).ewm(alpha=1 / n, adjust=False, min_periods=n).mean()
    dn = (-d.clip(upper=0)).ewm(alpha=1 / n, adjust=False, min_periods=n).mean()
    out = 100 - 100 / (1 + up / dn.replace(0, np.nan))
    out = out.where(dn != 0, 100.0)
    return out.where(up.notna())


def atr(df: pd.DataFrame, n: int = 14) -> pd.Series:
    n = int(n)
    pc = df["close"].shift(1)
    tr = pd.concat([df["high"] - df["low"], (df["high"] - pc).abs(), (df["low"] - pc).abs()], axis=1).max(axis=1)
    return tr.ewm(alpha=1 / n, adjust=False, min_periods=n).mean()


def macd(x: pd.Series, fast: int = 12, slow: int = 26) -> pd.Series:
    return x.ewm(span=int(fast), adjust=False).mean() - x.ewm(span=int(slow), adjust=False).mean()


def macd_signal(x: pd.Series, fast: int = 12, slow: int = 26, signal: int = 9) -> pd.Series:
    return macd(x, fast, slow).ewm(span=int(signal), adjust=False).mean()


def bb_upper(x: pd.Series, n: int = 20, k: float = 2.0) -> pd.Series:
    return sma(x, n) + k * x.rolling(int(n), min_periods=int(n)).std()


def bb_lower(x: pd.Series, n: int = 20, k: float = 2.0) -> pd.Series:
    return sma(x, n) - k * x.rolling(int(n), min_periods=int(n)).std()


def zscore(x: pd.Series, n: int) -> pd.Series:
    n = int(n)
    return (x - sma(x, n)) / x.rolling(n, min_periods=n).std()


def volatility(x: pd.Series, n: int = 20) -> pd.Series:
    """Annualised volatility (%) of log returns."""
    n = int(n)
    return np.log(x).diff().rolling(n, min_periods=n).std() * np.sqrt(252) * 100


def cross_above(a: pd.Series, b: pd.Series) -> pd.Series:
    return ((a > b) & (a.shift(1) <= b.shift(1))).fillna(False).astype(bool)


def cross_below(a: pd.Series, b: pd.Series) -> pd.Series:
    return ((a < b) & (a.shift(1) >= b.shift(1))).fillna(False).astype(bool)
