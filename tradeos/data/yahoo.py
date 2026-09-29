"""Free end-of-day data from Yahoo Finance (NSE via .NS suffix), cached to CSV."""
from __future__ import annotations

import logging
import re
import time
from pathlib import Path

import pandas as pd

from .base import COLUMNS, DataProvider, slice_df
from .universe import to_yahoo

log = logging.getLogger("tradeos.data")


class YahooProvider(DataProvider):
    name = "yahoo"

    def __init__(self, cache_dir: Path, max_age_hours: float = 6, start: str = "2010-01-01"):
        self.cache_dir = Path(cache_dir)
        self.max_age = max_age_hours * 3600
        self.start = start
        self._mem: dict[str, pd.DataFrame] = {}

    def _download(self, ticker: str) -> pd.DataFrame:
        try:
            import yfinance as yf
        except ImportError as e:
            raise RuntimeError("yfinance is not installed: pip install yfinance") from e
        df = yf.Ticker(ticker).history(start=self.start, auto_adjust=True, actions=False)
        if df is None or df.empty:
            raise ValueError(f"Yahoo returned no data for {ticker}")
        df = df.rename(columns=str.lower)[COLUMNS]
        idx = df.index
        if getattr(idx, "tz", None) is not None:
            idx = idx.tz_localize(None)
        df.index = pd.DatetimeIndex(idx).normalize()
        df.index.name = "date"
        return df[~df.index.duplicated(keep="last")].dropna(subset=["close"])

    def history(self, symbol: str, start=None, end=None) -> pd.DataFrame:
        ticker = to_yahoo(symbol)
        if ticker not in self._mem:
            path = self.cache_dir / (re.sub(r"[^A-Za-z0-9_.-]", "_", ticker) + ".csv")
            fresh = path.exists() and (time.time() - path.stat().st_mtime) < self.max_age
            if fresh:
                df = pd.read_csv(path, index_col=0, parse_dates=True)
            else:
                try:
                    df = self._download(ticker)
                    df.to_csv(path)
                except Exception as e:
                    if not path.exists():
                        raise
                    log.warning("Download failed for %s (%s); using stale cache", ticker, e)
                    df = pd.read_csv(path, index_col=0, parse_dates=True)
            self._mem[ticker] = df
        return slice_df(self._mem[ticker], start, end).copy()
