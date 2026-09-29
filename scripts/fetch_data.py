"""Download daily OHLCV history from Yahoo Finance into data/prices/<SYMBOL>.csv.

Runs on GitHub Actions (which has open internet). Prices are split- and dividend-adjusted
(auto_adjust=True). Usage:  python scripts/fetch_data.py [--years 15]
"""
from __future__ import annotations

import argparse
import json
import sys
import time
from datetime import date, timedelta
from pathlib import Path

import pandas as pd
import yfinance as yf

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from tradeos.data.universe import INDICES, NIFTY50, SECTORS, to_yahoo  # noqa: E402

OUT = ROOT / "data" / "prices"


def fetch(symbol: str, start: str) -> pd.DataFrame:
    last_err = None
    for attempt in range(4):
        try:
            df = yf.Ticker(to_yahoo(symbol)).history(start=start, auto_adjust=True, actions=False)
            if df is not None and not df.empty:
                df = df.rename(columns=str.lower)[["open", "high", "low", "close", "volume"]]
                idx = df.index.tz_localize(None) if df.index.tz is not None else df.index
                df.index = pd.DatetimeIndex(idx).normalize()
                df.index.name = "date"
                df = df[~df.index.duplicated(keep="last")].dropna(subset=["close"])
                df = df[df["close"] > 0]
                return df
            last_err = "empty"
        except Exception as e:  # rate limits etc.
            last_err = str(e)
        time.sleep(3 * (attempt + 1))
    raise RuntimeError(f"{symbol}: {last_err}")


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--years", type=int, default=15)
    args = ap.parse_args()
    start = (date.today() - timedelta(days=int(args.years * 365.25) + 5)).isoformat()
    OUT.mkdir(parents=True, exist_ok=True)
    symbols = list(dict.fromkeys(INDICES + ["INDIAVIX"] + SECTORS + NIFTY50))
    manifest, failed = {}, {}
    for s in symbols:
        try:
            df = fetch(s, start)
            df.round(2).to_csv(OUT / f"{s}.csv")
            manifest[s] = {"yahoo": to_yahoo(s), "rows": len(df), "first": str(df.index[0].date()),
                           "last": str(df.index[-1].date())}
            print(f"OK   {s:<14} {len(df):>5} rows {manifest[s]['first']} -> {manifest[s]['last']}")
        except Exception as e:
            failed[s] = str(e)[:200]
            print(f"FAIL {s:<14} {e}")
        time.sleep(0.5)
    (ROOT / "data" / "manifest.json").write_text(json.dumps(
        {"generated": date.today().isoformat(), "start": start, "adjusted": True, "source": "Yahoo Finance",
         "symbols": manifest, "failed": failed}, indent=1))
    print(f"\n{len(manifest)} ok, {len(failed)} failed")
    if len(manifest) < len(symbols) * 0.6:
        sys.exit("Too many failures")


if __name__ == "__main__":
    main()
