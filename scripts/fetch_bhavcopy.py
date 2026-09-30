"""Survivorship-free, point-in-time stock universes from NSE's daily bhavcopy.

Runs on GitHub Actions (NSE is reachable there). Steps:
 1. Download the NSE cash-market bhavcopy for every weekday since --start into a cache folder (not committed):
    old format  /content/historical/EQUITIES/YYYY/MON/cmDDMONYYYYbhav.csv.zip   (until 5 Jul 2024)
    UDiFF       /content/cm/BhavCopy_NSE_CM_0_0_0_YYYYMMDD_F_0000.csv.zip        (from 8 Jul 2024)
    Each day is reduced to equity rows (series EQ/BE/BZ, no ETFs/MF units) and cached as csv.gz.
 2. Map old tickers to today's ticker with NSE's symbolchange.csv (date-aware, chains resolved).
 3. Adjust prices for splits, bonuses and rights: NSE's PREVCLOSE on an ex-date is already adjusted, so
    factor = PREVCLOSE(t) / CLOSE(t-1); history before t is multiplied by it (price-only; no dividends).
 4. Every March and September review (last trading day of the month), rank stocks by average daily traded
    value over the previous 6 months (EQ series, traded on >= 80% of days, still trading) and keep the top 100
    and top 200 — using only information available on that date. Stocks that later fell, were delisted,
    merged or dropped out are kept with their real prices.
Outputs (committed):
    data/pit/membership.json          {"asof", "method", "universes": {"top200pit": [[date, [SYM..]], ..], "top100pit": ..}}
    data/pit/prices/<SYM>.csv         date,open,high,low,close,volume,value  (every stock ever in the top 200)
    data/pit/_report.json             coverage and adjustment statistics

Usage: python scripts/fetch_bhavcopy.py [--start 2011-01-01] [--cache .bhav_cache] [--workers 8]
"""
from __future__ import annotations

import argparse
import gzip
import io
import json
import time
import zipfile
from concurrent.futures import ThreadPoolExecutor
from datetime import date, datetime, timedelta
from pathlib import Path

import numpy as np
import pandas as pd
import requests

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "data" / "pit"
HOSTS = ["https://nsearchives.nseindia.com", "https://archives.nseindia.com"]
UA = {"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36",
      "Accept": "*/*", "Referer": "https://www.nseindia.com/"}
UDIFF_FROM = date(2024, 7, 8)
SERIES = {"EQ", "BE", "BZ"}
SIZES = {"top200pit": 200, "top100pit": 100}
COLS = ["sym", "series", "isin", "open", "high", "low", "close", "prev", "vol", "val"]


# ------------------------------------------------------------------------------------------ download
def urls_for(d: date) -> list[str]:
    old = f"/content/historical/EQUITIES/{d:%Y}/{d.strftime('%b').upper()}/cm{d:%d}{d.strftime('%b').upper()}{d:%Y}bhav.csv.zip"
    new = f"/content/cm/BhavCopy_NSE_CM_0_0_0_{d:%Y%m%d}_F_0000.csv.zip"
    paths = [new, old] if d >= UDIFF_FROM - timedelta(days=10) else [old, new]
    return [h + p for p in paths for h in HOSTS]


def normalise(raw: pd.DataFrame) -> pd.DataFrame:
    raw.columns = [c.strip() for c in raw.columns]
    if "TckrSymb" in raw.columns:  # UDiFF
        if "FinInstrmTp" in raw.columns:
            raw = raw[raw["FinInstrmTp"].astype(str).str.strip().isin(["STK", ""])]
        m = {"TckrSymb": "sym", "SctySrs": "series", "ISIN": "isin", "OpnPric": "open", "HghPric": "high", "LwPric": "low",
             "ClsPric": "close", "PrvsClsgPric": "prev", "TtlTradgVol": "vol", "TtlTrfVal": "val"}
    else:
        m = {"SYMBOL": "sym", "SERIES": "series", "ISIN": "isin", "OPEN": "open", "HIGH": "high", "LOW": "low",
             "CLOSE": "close", "PREVCLOSE": "prev", "TOTTRDQTY": "vol", "TOTTRDVAL": "val"}
    df = raw.rename(columns=m)
    if "isin" not in df.columns:
        df["isin"] = ""
    df = df[[c for c in COLS]].copy()
    for c in ("sym", "series", "isin"):
        df[c] = df[c].astype(str).str.strip()
    df = df[df["series"].isin(SERIES) & ~df["isin"].str.startswith("INF")]
    for c in ("open", "high", "low", "close", "prev", "vol", "val"):
        df[c] = pd.to_numeric(df[c], errors="coerce")
    return df[(df["close"] > 0) & (df["prev"] > 0)]


def fetch_day(d: date, session: requests.Session) -> tuple[date, pd.DataFrame | None, str]:
    last = "no file"
    for attempt in range(3):
        for u in urls_for(d):
            try:
                r = session.get(u, headers=UA, timeout=30)
            except requests.RequestException as e:
                last = f"error {e.__class__.__name__}"
                continue
            if r.status_code != 200 or len(r.content) < 200:
                last = f"http {r.status_code}"
                continue
            try:
                with zipfile.ZipFile(io.BytesIO(r.content)) as z:
                    name = next(n for n in z.namelist() if n.lower().endswith(".csv"))
                    raw = pd.read_csv(z.open(name), dtype=str)
                return d, normalise(raw), "ok"
            except Exception as e:  # noqa: BLE001 — a bad file is treated like a missing one
                last = f"bad file {e.__class__.__name__}"
        if last.startswith("http 404"):
            break
        time.sleep(1.5 * (attempt + 1))
    return d, None, last


def download(start: date, cache: Path, workers: int) -> dict:
    cache.mkdir(parents=True, exist_ok=True)
    miss_file = cache / "_missing.json"
    missing = set(json.loads(miss_file.read_text())) if miss_file.exists() else set()
    today = date.today()
    days = [start + timedelta(days=i) for i in range((today - start).days + 1)]
    todo = [d for d in days if d.weekday() < 5 and not (cache / f"{d:%Y%m%d}.csv.gz").exists() and d.isoformat() not in missing]
    print(f"Bhavcopy: {len(todo)} weekdays to fetch ({len(days)} calendar days since {start})", flush=True)
    session, got, reasons = requests.Session(), 0, {}
    with ThreadPoolExecutor(max_workers=workers) as pool:
        for i, (d, df, why) in enumerate(pool.map(lambda x: fetch_day(x, session), todo)):
            if df is not None and len(df):
                with gzip.open(cache / f"{d:%Y%m%d}.csv.gz", "wt") as f:
                    df.to_csv(f, index=False)
                got += 1
            else:
                reasons[why] = reasons.get(why, 0) + 1
                if (today - d).days > 7:  # holidays: stop asking once the day is old
                    missing.add(d.isoformat())
            if i % 250 == 0:
                print(f"  {i}/{len(todo)} scanned, {got} files", flush=True)
    miss_file.write_text(json.dumps(sorted(missing)))
    print(f"Downloaded {got} new files; not available: {reasons}", flush=True)
    return {"new_files": got, "not_available": reasons}


# ------------------------------------------------------------------------------------------ symbol changes
def symbol_changes() -> list[tuple[str, str, date]]:
    for h in HOSTS:
        try:
            r = requests.get(h + "/content/equities/symbolchange.csv", headers=UA, timeout=30)
            if r.status_code == 200 and len(r.text) > 100:
                raw = pd.read_csv(io.StringIO(r.text), dtype=str, header=None)
                out = []
                for _, row in raw.iterrows():
                    vals = [str(v).strip() for v in row.tolist()]
                    if len(vals) < 4 or vals[1].upper() in ("SM_KEY_SYMBOL", "OLD SYMBOL"):
                        continue
                    try:
                        d = datetime.strptime(vals[3], "%d-%b-%Y").date()
                    except ValueError:
                        continue
                    if vals[1] and vals[2] and vals[1] != vals[2]:
                        out.append((vals[1], vals[2], d))
                print(f"Symbol changes: {len(out)}", flush=True)
                return sorted(out, key=lambda x: x[2])
        except Exception as e:  # noqa: BLE001
            print(f"  symbolchange.csv from {h}: {e}", flush=True)
    print("Symbol changes: not available (old tickers stay separate)", flush=True)
    return []


# ------------------------------------------------------------------------------------------ build
def load_cache(cache: Path, start: date) -> pd.DataFrame:
    parts = []
    for f in sorted(cache.glob("*.csv.gz")):
        d = datetime.strptime(f.name[:8], "%Y%m%d").date()
        if d < start:
            continue
        df = pd.read_csv(f, dtype={"sym": str, "series": str, "isin": str})
        df["date"] = np.datetime64(d)
        parts.append(df)
    df = pd.concat(parts, ignore_index=True)
    for c in ("open", "high", "low", "close", "prev"):
        df[c] = df[c].astype("float64")
    print(f"Loaded {len(parts)} trading days, {len(df):,} rows, {df['sym'].nunique():,} tickers", flush=True)
    return df


def apply_symbol_changes(df: pd.DataFrame, changes: list) -> tuple[pd.DataFrame, int]:
    sym = df["sym"].to_numpy(dtype=object).copy()
    dates = df["date"].to_numpy()
    rows = {k: np.asarray(v) for k, v in df.groupby("sym").indices.items()}
    moved = 0
    for old, new, d in changes:
        idx = rows.get(old)
        if idx is None or not len(idx):
            continue
        sel = idx[dates[idx] < np.datetime64(d)]
        if not len(sel):
            continue
        rows[new] = np.concatenate([rows.get(new, np.array([], dtype=idx.dtype)), sel])
        rows[old] = idx[dates[idx] >= np.datetime64(d)]
        moved += len(sel)
    for k, idx in rows.items():
        sym[idx] = k
    df = df.assign(sym=sym)
    # one row per ticker and day: EQ first, then the most traded
    df["_eq"] = (df["series"] != "EQ").astype(int)
    df = df.sort_values(["sym", "date", "_eq", "val"], ascending=[True, True, True, False]).drop_duplicates(["sym", "date"]).drop(columns="_eq")
    return df.reset_index(drop=True), moved


def adjust(g: pd.DataFrame) -> tuple[pd.DataFrame, list]:
    """Back-adjust one ticker for corporate actions using NSE's adjusted previous close."""
    close, prev = g["close"].to_numpy(), g["prev"].to_numpy()
    f = np.ones(len(g))
    f[1:] = prev[1:] / close[:-1]
    f[~np.isfinite(f) | (f <= 0)] = 1.0
    f[np.abs(f - 1) < 0.0005] = 1.0
    f[(f < 0.001) | (f > 1000)] = 1.0
    events = [(str(g["date"].iloc[i])[:10], round(float(f[i]), 5)) for i in np.nonzero(f != 1.0)[0]]
    cum = np.ones(len(g))
    cum[:-1] = np.cumprod(f[::-1])[::-1][1:]  # product of factors strictly after each day
    out = g[["date"]].copy()
    for c in ("open", "high", "low", "close"):
        out[c] = g[c].to_numpy() * cum
    out["volume"] = np.round(g["vol"].to_numpy() / cum)
    out["value"] = g["val"].to_numpy()
    return out, events


def review_dates(trading: pd.DatetimeIndex) -> list[pd.Timestamp]:
    out = []
    for y in range(trading[0].year, trading[-1].year + 1):
        for m in (3, 9):
            cand = trading[(trading.year == y) & (trading.month == m)]
            if len(cand) and cand[-1] - trading[0] >= pd.Timedelta(days=175):
                out.append(cand[-1])
    return out


def build(df: pd.DataFrame) -> tuple[dict, list, dict]:
    trading = pd.DatetimeIndex(sorted(df["date"].unique()))
    eq = df[df["series"] == "EQ"]
    val = eq.pivot_table(index="date", columns="sym", values="val", aggfunc="sum").reindex(trading)
    reviews = review_dates(trading)
    uni = {k: [] for k in SIZES}
    for r in reviews:
        win = val.loc[(val.index > r - pd.DateOffset(months=6)) & (val.index <= r)]
        n = len(win)
        traded = win.notna().sum()
        recent = win.tail(5).notna().any()
        avg = win.fillna(0).sum() / max(n, 1)
        ok = (traded >= 0.8 * n) & recent
        ranked = avg[ok].sort_values(ascending=False)
        for k, size in SIZES.items():
            uni[k].append([r.date().isoformat(), sorted(ranked.index[:size].tolist())])
    members = sorted({s for k in uni for _, syms in uni[k] for s in syms})
    return uni, members, {"reviews": [r.date().isoformat() for r in reviews], "trading_days": len(trading),
                          "first": trading[0].date().isoformat(), "last": trading[-1].date().isoformat()}


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--start", default="2011-01-01")
    ap.add_argument("--cache", default=".bhav_cache")
    ap.add_argument("--workers", type=int, default=8)
    args = ap.parse_args()
    start = date.fromisoformat(args.start)
    cache = (ROOT / args.cache) if not Path(args.cache).is_absolute() else Path(args.cache)
    dl = download(start, cache, args.workers)
    df = load_cache(cache, start)
    df, moved = apply_symbol_changes(df, symbol_changes())
    uni, members, info = build(df)
    print(f"Reviews: {len(info['reviews'])} ({info['reviews'][0]} … {info['reviews'][-1]}); stocks ever in the top 200: {len(members)}", flush=True)
    prices = OUT / "prices"
    prices.mkdir(parents=True, exist_ok=True)
    keep = set(members)
    for f in prices.glob("*.csv"):
        if f.stem not in keep:
            f.unlink()
    adj_stats, examples, ends = {"tickers_adjusted": 0, "events": 0, "small_events": 0}, {}, {}
    for sym, g in df[df["sym"].isin(keep)].groupby("sym", sort=True):
        out, events = adjust(g.sort_values("date").reset_index(drop=True))
        if events:
            adj_stats["tickers_adjusted"] += 1
            adj_stats["events"] += len(events)
            adj_stats["small_events"] += sum(1 for _, x in events if abs(np.log(x)) < 0.05)
            if len(examples) < 40:
                examples[sym] = events[:6]
        out["date"] = out["date"].dt.strftime("%Y-%m-%d")
        out.round({"open": 4, "high": 4, "low": 4, "close": 4}).to_csv(prices / f"{sym}.csv", index=False)
        ends[sym] = out["date"].iloc[-1]
    stale = sorted(s for s, d in ends.items() if d < info["last"])
    OUT.mkdir(parents=True, exist_ok=True)
    (OUT / "membership.json").write_text(json.dumps({
        "asof": info["last"],
        "method": "At each March and September review (last trading day of the month), the NSE stocks (series EQ) with the highest "
                  "average daily traded value over the previous 6 months, traded on at least 80% of those days and still trading. "
                  "Uses only information available on the review date; members apply from the next trading day. Prices from NSE "
                  "bhavcopy, adjusted for splits, bonuses and rights (price only, no dividends).",
        "universes": uni}, indent=1))
    (OUT / "_report.json").write_text(json.dumps({**info, "download": dl, "symbol_change_rows_moved": moved, "members": len(members),
        "members_no_longer_trading": len(stale), "examples_no_longer_trading": stale[:60], "adjustments": adj_stats,
        "adjustment_examples": examples, "sizes": {k: [len(x[1]) for x in v][-3:] for k, v in uni.items()}}, indent=1))
    print(f"Wrote {len(members)} price files; {len(stale)} of them stopped trading (delisted, merged or suspended). Adjustments: {adj_stats}", flush=True)


if __name__ == "__main__":
    main()
