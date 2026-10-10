"""Who holds what in NSE derivatives, and FII/DII cash flows (runs on GitHub Actions).

 1. Participant-wise open interest (contracts) and volume from NSE's daily NSCCL files
      /content/nsccl/fao_participant_oi_DDMMYYYY.csv  and  fao_participant_vol_DDMMYYYY.csv
    for every trading day (days come from the cash-market cache .eod_cache/nse). Rows: Client, DII, FII, Pro, TOTAL;
    columns: index/stock futures long & short, index/stock call & put long & short.
    -> data/flows/participant_oi.csv, data/flows/participant_vol.csv (one row per day, <PARTICIPANT>_<column>)
 2. FII/FPI and DII net buying in the cash market (₹ crore) from NSE's daily report. NSE only serves the latest day,
    so history builds up from the first run. -> data/flows/fii_dii_cash.csv
Usage: python scripts/fetch_participants.py [--start YYYY-MM-DD (default: 190 days ago)] [--cache .part_cache] [--eq-cache .eod_cache/nse]
"""
from __future__ import annotations

import argparse
import io
import json
import re
import time
from concurrent.futures import ThreadPoolExecutor
from datetime import date, datetime, timedelta
from pathlib import Path

import pandas as pd
import requests

KEEP_DAYS = 190  # ≈ 6 months, the history TradeOS keeps
ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "data" / "flows"
HOSTS = ["https://nsearchives.nseindia.com", "https://archives.nseindia.com"]
UA = {"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36",
      "Accept": "*/*", "Referer": "https://www.nseindia.com/"}
COLMAP = {  # NSE header -> short name
    "future index long": "fut_idx_long", "future index short": "fut_idx_short", "future stock long": "fut_stk_long", "future stock short": "fut_stk_short",
    "option index call long": "idx_call_long", "option index put long": "idx_put_long", "option index call short": "idx_call_short", "option index put short": "idx_put_short",
    "option stock call long": "stk_call_long", "option stock put long": "stk_put_long", "option stock call short": "stk_call_short", "option stock put short": "stk_put_short",
    "total long contracts": "total_long", "total short contracts": "total_short"}


def parse(text: str) -> dict | None:
    lines = [ln for ln in text.splitlines() if ln.strip()]
    hi = next((i for i, ln in enumerate(lines) if "client type" in ln.lower()), None)
    if hi is None:
        return None
    df = pd.read_csv(io.StringIO("\n".join(lines[hi:])), dtype=str)
    df.columns = [re.sub(r"\s+", " ", c.strip().lower()).replace("\t", "") for c in df.columns]
    out = {}
    for _, row in df.iterrows():
        who = str(row.iloc[0]).strip().upper()
        if who not in ("CLIENT", "DII", "FII", "PRO", "TOTAL"):
            continue
        for c in df.columns[1:]:
            key = COLMAP.get(c.strip())
            if key:
                try:
                    out[f"{who}_{key}"] = float(str(row[c]).replace(",", "").strip())
                except ValueError:
                    pass
    return out or None


def fetch(d: date, kind: str, session: requests.Session) -> tuple[date, dict | None, str]:
    last = "no file"
    for attempt in range(3):
        for h in HOSTS:
            try:
                r = session.get(f"{h}/content/nsccl/fao_participant_{kind}_{d:%d%m%Y}.csv", headers=UA, timeout=30)
            except requests.RequestException as e:
                last = f"error {e.__class__.__name__}"
                continue
            if r.status_code != 200 or len(r.content) < 100:
                last = f"http {r.status_code}"
                continue
            try:
                p = parse(r.text)
            except Exception as e:  # noqa: BLE001
                return d, None, f"unparsed {e.__class__.__name__}"
            return d, p, "ok" if p else "unparsed"
        if last.startswith("http 404"):
            break
        time.sleep(1.5 * (attempt + 1))
    return d, None, last


def participants(days: list[date], cache: Path, workers: int) -> dict:
    stats = {}
    for kind in ("oi", "vol"):
        cf = cache / f"{kind}.json"
        have = json.loads(cf.read_text()) if cf.exists() else {}
        miss_f = cache / f"{kind}_missing.json"
        missing = set(json.loads(miss_f.read_text())) if miss_f.exists() else set()
        todo = [d for d in days if d.isoformat() not in have and d.isoformat() not in missing]
        print(f"participant {kind}: {len(todo)} days to fetch", flush=True)
        s, reasons = requests.Session(), {}
        with ThreadPoolExecutor(max_workers=workers) as pool:
            for i, (d, p, why) in enumerate(pool.map(lambda x: fetch(x, kind, s), todo)):
                if p:
                    have[d.isoformat()] = p
                else:
                    reasons[why] = reasons.get(why, 0) + 1
                    if (date.today() - d).days > 7:
                        missing.add(d.isoformat())
                if i % 500 == 0:
                    print(f"  {i}/{len(todo)}", flush=True)
        cf.write_text(json.dumps(have)); miss_f.write_text(json.dumps(sorted(missing)))
        if have:
            df = pd.DataFrame.from_dict(have, orient="index").sort_index()
            if days:
                df = df[df.index >= days[0].isoformat()]  # only the window the app keeps
            df.index.name = "date"
            OUT.mkdir(parents=True, exist_ok=True)
            df.to_csv(OUT / f"participant_{kind}.csv", float_format="%.0f")
        stats[kind] = {"days": len(have), "first": min(have) if have else None, "last": max(have) if have else None, "not_available": reasons}
    return stats


def fii_dii_cash() -> dict:
    """today's FII/FPI and DII cash-market buy/sell/net (₹ crore), appended to data/flows/fii_dii_cash.csv"""
    f = OUT / "fii_dii_cash.csv"
    s = requests.Session()
    try:
        s.get("https://www.nseindia.com/", headers={**UA, "Accept": "text/html"}, timeout=30)
        r = s.get("https://www.nseindia.com/api/fiidiiTradeReact", headers={**UA, "Accept": "application/json"}, timeout=30)
        rows = r.json()
    except Exception as e:  # noqa: BLE001
        return {"error": str(e)[:200]}
    rec = {}
    for x in rows:
        cat = str(x.get("category", "")).upper()
        who = "FII" if "FII" in cat or "FPI" in cat else "DII" if "DII" in cat else None
        if not who:
            continue
        d = datetime.strptime(x["date"], "%d-%b-%Y").date().isoformat()
        rec.setdefault(d, {})
        for k in ("buyValue", "sellValue", "netValue"):
            try:
                rec[d][f"{who}_{k[:-5]}"] = float(str(x.get(k)).replace(",", ""))
            except (TypeError, ValueError):
                pass
    if not rec:
        return {"error": "no rows"}
    old = pd.read_csv(f, index_col=0) if f.exists() else pd.DataFrame()
    new = pd.DataFrame.from_dict(rec, orient="index")
    df = pd.concat([old[~old.index.isin(new.index)], new]).sort_index()
    df = df[df.index >= pd.Timestamp(date.today() - timedelta(days=KEEP_DAYS))]  # only the window the app keeps
    df.index.name = "date"
    OUT.mkdir(parents=True, exist_ok=True)
    df.to_csv(f)
    return {"days": len(df), "last": df.index[-1]}


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--start", default=None)
    ap.add_argument("--cache", default=".part_cache")
    ap.add_argument("--eq-cache", default=".eod_cache/nse")
    ap.add_argument("--workers", type=int, default=8)
    args = ap.parse_args()
    cache = ROOT / args.cache
    cache.mkdir(parents=True, exist_ok=True)
    start = date.fromisoformat(args.start) if args.start else date.today() - timedelta(days=KEEP_DAYS)
    for f in cache.glob("*"):  # drop cached days outside the window
        if f.name[:8].isdigit() and f.name[:8] < f"{start:%Y%m%d}":
            f.unlink()
    days = sorted(d for d in (datetime.strptime(f.name[:8], "%Y%m%d").date() for f in (ROOT / args.eq_cache).glob("*.csv.gz") if f.name[:8].isdigit()) if d >= start)
    OUT.mkdir(parents=True, exist_ok=True)
    try:
        st = participants(days, cache, args.workers)
    except Exception as e:  # noqa: BLE001
        import traceback
        st = {"error": traceback.format_exc()[-1500:]}
    try:
        st["fii_dii_cash"] = fii_dii_cash()
    except Exception as e:  # noqa: BLE001
        st["fii_dii_cash"] = {"error": str(e)[:300]}
    OUT.mkdir(parents=True, exist_ok=True)
    (OUT / "_report.json").write_text(json.dumps(st, indent=1))
    print(json.dumps(st), flush=True)


if __name__ == "__main__":
    main()
