from __future__ import annotations

import logging

import pandas as pd

log = logging.getLogger("tradeos.data")

COLUMNS = ["open", "high", "low", "close", "volume"]


def slice_df(df: pd.DataFrame, start=None, end=None) -> pd.DataFrame:
    if start is not None:
        df = df[df.index >= pd.Timestamp(start)]
    if end is not None:
        df = df[df.index <= pd.Timestamp(end)]
    return df


class DataProvider:
    """Daily OHLCV provider. history() returns a DataFrame indexed by date with
    columns open, high, low, close, volume."""

    name = "base"

    def history(self, symbol: str, start=None, end=None) -> pd.DataFrame:
        raise NotImplementedError

    def closes(self, symbols: list[str], start=None, end=None) -> pd.DataFrame:
        data = {}
        for s in symbols:
            try:
                df = self.history(s, start, end)
                if not df.empty:
                    data[s] = df["close"]
            except Exception as e:  # one bad symbol shouldn't kill a universe
                log.warning("No data for %s: %s", s, e)
        return pd.DataFrame(data).sort_index()

    def last_close(self, symbol: str, end=None) -> float:
        df = self.history(symbol, end=end)
        if df.empty:
            raise ValueError(f"No data for {symbol}")
        return float(df["close"].iloc[-1])


def get_provider(name: str, settings) -> DataProvider:
    name = (name or "yahoo").lower()
    if name == "yahoo":
        from .yahoo import YahooProvider
        return YahooProvider(settings.cache_dir)
    if name == "synthetic":
        from .synthetic import SyntheticProvider
        return SyntheticProvider()
    if name == "csv":
        from .csv_provider import CSVProvider
        return CSVProvider(settings.csv_dir)
    raise ValueError(f"Unknown data provider '{name}' (yahoo | csv | synthetic)")
