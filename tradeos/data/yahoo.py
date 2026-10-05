"""Free end-of-day data from Yahoo Finance (NSE via .NS suffix), cached to CSV."""
from __future__ import annotations

import logging
import re
import time
from datetime import datetime, timezone
from datetime import time as dtime
from pathlib import Path
from zoneinfo import ZoneInfo

import pandas as pd

from .base import COLUMNS, DataProvider, slice_df
from .universe import to_yahoo

log = logging.getLogger("tradeos.data")

GRACE_S = 15 * 60  # after the official close, wait for the closing auction / final prints to settle
INDIA_DONE = dtime(15, 50)  # NSE closes 15:30 IST; used when Yahoo sends no trading-period metadata


def drop_unfinished(df: pd.DataFrame, meta: dict | None = None, now: datetime | None = None) -> pd.DataFrame:
    """Remove the last bar when its trading session has not finished yet.

    Yahoo returns today's bar while the market is still open (a fetch at 12:30 IST gives a half-day high/low/close
    and volume), and storing it as a daily close corrupts every signal computed from it. `meta` is yfinance's
    `Ticker.history_metadata` (exchange time zone + current trading period); without it, Indian hours are assumed.
    """
    if df is None or df.empty:
        return df
    now = now or datetime.now(timezone.utc)
    meta = meta or {}
    tz = ZoneInfo(meta.get("exchangeTimezoneName") or "Asia/Kolkata")
    today = now.astimezone(tz).date()
    if df.index[-1].date() < today:
        return df  # last bar is an earlier, finished session
    reg = (meta.get("currentTradingPeriod") or {}).get("regular") or {}
    end = reg.get("end")
    if end:
        end_day = datetime.fromtimestamp(end, tz).date()
        if end_day > today:
            return df  # Yahoo already rolled to the next session, so today's is over
        if end_day == today:
            return df if now.timestamp() >= end + GRACE_S else df.iloc[:-1]
    # no usable period: Indian close for Indian time zones, otherwise assume the session runs until evening
    done = INDIA_DONE if tz.key in ("Asia/Kolkata", "Asia/Calcutta") else dtime(18, 0)
    return df if now.astimezone(tz).time() >= done else df.iloc[:-1]


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
        t = yf.Ticker(ticker)
        df = t.history(start=self.start, auto_adjust=True, actions=False)
        if df is None or df.empty:
            raise ValueError(f"Yahoo returned no data for {ticker}")
        df = df.rename(columns=str.lower)[COLUMNS]
        idx = df.index
        if getattr(idx, "tz", None) is not None:
            idx = idx.tz_localize(None)
        df.index = pd.DatetimeIndex(idx).normalize()
        df.index.name = "date"
        df = df[~df.index.duplicated(keep="last")].dropna(subset=["close"])
        try:
            meta = t.history_metadata
        except Exception:
            meta = None
        return drop_unfinished(df, meta)

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
