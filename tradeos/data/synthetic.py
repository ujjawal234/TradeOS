"""Deterministic synthetic market data for offline demos and tests. NOT real prices."""
from __future__ import annotations

import zlib

import numpy as np
import pandas as pd

from .base import DataProvider, slice_df
from .universe import is_index, norm

_BASES = {"NIFTY": 11000.0, "NIFTY50": 11000.0, "BANKNIFTY": 27000.0, "SENSEX": 38000.0}


class SyntheticProvider(DataProvider):
    name = "synthetic"

    def __init__(self, start: str = "2016-01-01", end=None):
        self.start = pd.Timestamp(start)
        self.end = pd.Timestamp(end) if end else pd.Timestamp.today().normalize()
        self._mem: dict[str, pd.DataFrame] = {}

    def _gen(self, sym: str) -> pd.DataFrame:
        rng = np.random.default_rng(zlib.crc32(sym.encode()))
        idx = pd.bdate_range(self.start, self.end)
        n = len(idx)
        if sym == "INDIAVIX":
            v = np.empty(n)
            v[0] = 14.0
            shocks = rng.normal(0, 0.8, n)
            for i in range(1, n):
                v[i] = min(max(v[i - 1] + 0.06 * (14.0 - v[i - 1]) + shocks[i], 9.0), 40.0)
            close = v
            vol_d = 0.02
        else:
            base = _BASES.get(sym, float(rng.uniform(150, 3000)))
            vol = 0.15 if is_index(sym) else float(rng.uniform(0.2, 0.38))
            drift = float(rng.uniform(0.05, 0.16))
            # slow-moving regime drift adds trends that momentum rules can find
            regime = np.repeat(rng.normal(0, 0.25, n // 60 + 1), 60)[:n]
            mu = (drift + regime) / 252 - 0.5 * vol ** 2 / 252
            rets = rng.normal(mu, vol / np.sqrt(252), n)
            close = base * np.exp(np.cumsum(rets))
            vol_d = vol / np.sqrt(252)
        opens = np.r_[close[0], close[:-1] * (1 + rng.normal(0, vol_d * 0.3, n - 1))]
        hi = np.maximum(opens, close) * (1 + np.abs(rng.normal(0, vol_d * 0.5, n)))
        lo = np.minimum(opens, close) * (1 - np.abs(rng.normal(0, vol_d * 0.5, n)))
        volume = rng.integers(100_000, 5_000_000, n).astype(float)
        df = pd.DataFrame({"open": opens, "high": hi, "low": lo, "close": close, "volume": volume}, index=idx)
        df.index.name = "date"
        return df

    def history(self, symbol: str, start=None, end=None) -> pd.DataFrame:
        s = norm(symbol).replace("^", "")
        if s not in self._mem:
            self._mem[s] = self._gen(s)
        return slice_df(self._mem[s], start, end).copy()
