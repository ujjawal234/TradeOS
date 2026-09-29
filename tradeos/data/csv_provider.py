"""Load daily bars from CSV files (e.g. exports from Zerodha/Upstox/Dhan or NSE bhavcopy).

Put one file per symbol at <TRADEOS_HOME>/csv/<SYMBOL>.csv with columns:
date, open, high, low, close, volume
"""
from __future__ import annotations

from pathlib import Path

import pandas as pd

from .base import COLUMNS, DataProvider, slice_df
from .universe import norm


class CSVProvider(DataProvider):
    name = "csv"

    def __init__(self, folder: Path):
        self.folder = Path(folder)
        self._mem: dict[str, pd.DataFrame] = {}

    def history(self, symbol: str, start=None, end=None) -> pd.DataFrame:
        s = norm(symbol)
        if s not in self._mem:
            path = self.folder / f"{s}.csv"
            if not path.exists():
                raise FileNotFoundError(f"No CSV for {s} at {path}")
            df = pd.read_csv(path)
            df.columns = [c.strip().lower() for c in df.columns]
            df["date"] = pd.to_datetime(df["date"]).dt.normalize()
            df = df.set_index("date").sort_index()
            if "volume" not in df:
                df["volume"] = 0
            self._mem[s] = df[COLUMNS].astype(float)
        return slice_df(self._mem[s], start, end).copy()
