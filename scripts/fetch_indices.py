"""Keep the last ~6 months (--days) of history for EVERY NSE index from NSE's daily "all indices" close files.

Source: https://nsearchives.nseindia.com/content/indices/ind_close_all_DDMMYYYY.csv
(one file per trading day: open/high/low/close, volume, turnover, P/E, P/B, dividend yield
for ~150 indices). Output: data/indices/<CODE>.csv  (date,open,high,low,close,volume,pe,pb,dy)
plus data/indices/_index_names.json (code -> official name). Incremental: only dates after
the newest stored file are downloaded; the first run backfills --days; older rows are trimmed.

Usage:  python scripts/fetch_indices.py [--days 190] [--full]
"""
from __future__ import annotations

import argparse
import csv
import io
import json
import re
import time
from concurrent.futures import ThreadPoolExecutor
from datetime import date, datetime, timedelta
from pathlib import Path

import pandas as pd
import requests

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "data" / "indices"
STATE = OUT / "_state.json"
UA = {"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36",
      "Accept": "text/csv,*/*", "Referer": "https://www.nseindia.com/"}
HOSTS = ["https://nsearchives.nseindia.com", "https://archives.nseindia.com"]


def code_of(name: str) -> str:
    """'Nifty Auto' -> NIFTY_AUTO, 'NIFTY 50' -> NIFTY_50."""
    return re.sub(r"_+", "_", re.sub(r"[^A-Z0-9]+", "_", name.upper())).strip("_")


def num(x: str):
    x = (x or "").strip().replace(",", "")
    try:
        return float(x)
    except ValueError:
        return None


def fetch_day(d: date, session: requests.Session) -> tuple[date, list[dict] | None]:
    fn = f"/content/indices/ind_close_all_{d:%d%m%Y}.csv"
    for attempt in range(3):
        for host in HOSTS:
            try:
                r = session.get(host + fn, headers=UA, timeout=25)
                if r.status_code == 404:
                    continue
                if r.status_code == 200 and "Index" in r.text[:200]:
                    rows = list(csv.DictReader(io.StringIO(r.text.lstrip("﻿"))))
                    return d, rows
            except requests.RequestException:
                pass
        time.sleep(1.5 * (attempt + 1))
    return d, None  # holiday / weekend / not published


def parse_rows(d: date, rows: list[dict]) -> list[dict]:
    out = []
    for raw in rows:
        r = {(k or "").strip().lower(): (v or "").strip() for k, v in raw.items()}
        name = r.get("index name")
        if not name:
            continue
        get = lambda *keys: next((num(r[k]) for k in r for key in keys if k.startswith(key)), None)  # noqa: E731
        close = get("closing index value", "close")
        if close is None or close <= 0:
            continue
        out.append({"name": name, "date": d.isoformat(), "open": get("open index value", "open") or close,
                    "high": get("high index value", "high") or close, "low": get("low index value", "low") or close,
                    "close": close, "volume": get("volume") or 0, "pe": get("p/e"), "pb": get("p/b"), "dy": get("div yield")})
    return out


def trim(cutoff: date) -> None:
    """keep only the window; an index with nothing left in it is removed"""
    for f in OUT.glob("*.csv"):
        if f.stem.startswith("_"):
            continue
        df = pd.read_csv(f, index_col=0)
        df = df[df.index.astype(str).str[:10] >= cutoff.isoformat()]
        if df.empty:
            f.unlink()
        else:
            df.to_csv(f)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--days", type=int, default=190, help="calendar days of history kept (190 ≈ 6 months)")
    ap.add_argument("--years", type=float, default=None, help="(old option, ignored)")
    ap.add_argument("--full", action="store_true")
    args = ap.parse_args()
    OUT.mkdir(parents=True, exist_ok=True)
    state = json.loads(STATE.read_text()) if STATE.exists() and not args.full else {}
    cutoff = date.today() - timedelta(days=args.days)
    start = cutoff
    if state.get("last") and state["last"] >= cutoff.isoformat():
        start = datetime.strptime(state["last"], "%Y-%m-%d").date() - timedelta(days=5)
    days = [start + timedelta(days=i) for i in range((date.today() - start).days + 1)]
    days = [d for d in days if d.weekday() < 5]
    # repair: trading days (per the Yahoo Nifty series) that are missing from NSE's Nifty 50 file
    ref, have = ROOT / "data" / "prices" / "NIFTY.csv", OUT / "NIFTY_50.csv"
    if ref.exists() and have.exists() and not args.full:
        trade = set(pd.read_csv(ref, index_col=0).index.astype(str).str[:10])
        got_days = set(pd.read_csv(have, index_col=0).index.astype(str).str[:10])
        first = min(got_days)
        gaps = sorted(d for d in trade - got_days if d >= max(first, cutoff.isoformat()))
        if gaps:
            print(f"Re-requesting {len(gaps)} trading days missing from NSE history")
            days = sorted(set(days) | {datetime.strptime(d, "%Y-%m-%d").date() for d in gaps})
    print(f"Fetching {len(days)} weekdays from {days[0]} to {days[-1]}")
    session = requests.Session()
    records: list[dict] = []
    got = 0
    with ThreadPoolExecutor(max_workers=6) as pool:
        for i, (d, rows) in enumerate(pool.map(lambda x: fetch_day(x, session), days)):
            if rows:
                got += 1
                records += parse_rows(d, rows)
            if i % 250 == 0:
                print(f"  {i}/{len(days)} days scanned, {got} files")
    trim(cutoff)
    if not records:
        print("No index files downloaded (NSE unreachable or no new trading days).")
        return
    new = pd.DataFrame(records)
    names = json.loads((OUT / "_index_names.json").read_text()) if (OUT / "_index_names.json").exists() else {}
    for name, g in new.groupby("name"):
        code = code_of(name)
        names[code] = name
        g = g.drop(columns=["name"]).set_index("date").sort_index()
        path = OUT / f"{code}.csv"
        if path.exists() and not args.full:
            old = pd.read_csv(path, index_col=0)
            g = pd.concat([old[~old.index.isin(g.index)], g]).sort_index()
        g = g[g.index.astype(str).str[:10] >= cutoff.isoformat()]
        g.to_csv(path)
    (OUT / "_index_names.json").write_text(json.dumps(dict(sorted(names.items())), indent=1))
    last = max([r["date"] for r in records] + ([state["last"]] if state.get("last") else []))
    STATE.write_text(json.dumps({"last": last, "updated": date.today().isoformat()}))
    print(f"Done: {got} daily files, {len(names)} indices, latest {last}")


if __name__ == "__main__":
    main()
