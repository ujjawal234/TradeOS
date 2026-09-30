"""Share counts for every stock (for market-cap weighting in the app's rotation engine).

Writes data/shares.json:
  {"generated": "YYYY-MM-DD", "source": "...",
   "stocks": {SYM: {"float": free-float ratio or null, "shares": [["YYYY-MM-DD", shares], ...]}}}

Historical share counts come from Yahoo (yfinance get_shares_full); the free-float ratio is today's
floatShares / sharesOutstanding, applied to the whole history (an approximation of NSE's free-float factor).
Only runs when the file is missing or older than --max-age days (share counts change rarely).

Usage:  python scripts/fetch_shares.py [--max-age 7] [--only SYM ...]
"""
from __future__ import annotations

import argparse
import datetime as dt
import json
import sys
import time
from pathlib import Path

import pandas as pd
import yfinance as yf

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "data" / "shares.json"


def clean_series(s: pd.Series) -> list[list]:
    """Daily last value, drop obvious glitches (>40% off the rolling median), keep only changes of >0.5%."""
    if s is None or len(s) == 0:
        return []
    s = s.dropna()
    s = s[s > 0]
    idx = s.index.tz_localize(None) if getattr(s.index, "tz", None) is not None else s.index
    s = pd.Series(s.values, index=pd.DatetimeIndex(idx).normalize()).groupby(level=0).last().sort_index()
    if len(s) >= 5:
        med = s.rolling(5, center=True, min_periods=1).median()
        s = s[(s / med - 1).abs() <= 0.4]
    out, last = [], None
    for d, v in s.items():
        if last is None or abs(v / last - 1) > 0.005:
            out.append([str(d.date()), float(v)])
            last = v
    return out


def fetch(ticker: str) -> dict:
    t = yf.Ticker(ticker)
    pts = []
    try:
        pts = clean_series(t.get_shares_full(start="2011-01-01"))
    except Exception as e:  # noqa: BLE001
        print(f"  {ticker}: history unavailable ({e})")
    flt = None
    try:
        info = t.info or {}
        so, fs = info.get("sharesOutstanding"), info.get("floatShares")
        if so and fs and 0 < fs <= so * 1.02:
            flt = round(min(1.0, fs / so), 4)
        if not pts and so:
            pts = [[str(dt.date.today()), float(so)]]
    except Exception as e:  # noqa: BLE001
        print(f"  {ticker}: info unavailable ({e})")
    return {"float": flt, "shares": pts}


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--max-age", type=int, default=7)
    ap.add_argument("--only", nargs="*")
    a = ap.parse_args()
    old = json.loads(OUT.read_text()) if OUT.exists() else {"stocks": {}}
    if not a.only and old.get("generated"):
        age = (dt.date.today() - dt.date.fromisoformat(old["generated"])).days
        if age < a.max_age:
            print(f"shares.json is {age} days old (< {a.max_age}); nothing to do")
            return
    man = json.loads((ROOT / "data" / "manifest.json").read_text())["symbols"]
    uni = json.loads((ROOT / "data" / "universe.json").read_text()).get("stocks", {})
    stocks = sorted(s for s in man if s in uni)
    if a.only:
        stocks = [s for s in stocks if s in set(a.only)]
    out = dict(old.get("stocks", {}))
    ok = 0
    for i, s in enumerate(stocks):
        ticker = man[s].get("yahoo") or f"{s}.NS"
        for attempt in range(3):
            try:
                r = fetch(ticker)
                break
            except Exception as e:  # noqa: BLE001
                print(f"  {s}: {e}")
                time.sleep(3 * (attempt + 1))
        else:
            continue
        if r["shares"]:
            out[s] = r
            ok += 1
        time.sleep(0.4)
        if (i + 1) % 25 == 0:
            print(f"  {i + 1}/{len(stocks)}")
    if ok == 0:
        print("no share data fetched; keeping the old file")
        sys.exit(0)
    OUT.write_text(json.dumps({"generated": str(dt.date.today()),
                               "source": "Yahoo Finance share counts (history) and floatShares/sharesOutstanding (free-float, today's ratio)",
                               "stocks": out}, indent=0, separators=(",", ":")))
    print(f"shares: {ok}/{len(stocks)} stocks updated -> {OUT}")


if __name__ == "__main__":
    main()
