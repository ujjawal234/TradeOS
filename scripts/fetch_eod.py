"""Daily prices for EVERY stock listed on NSE and BSE, last ~6 months (runs on GitHub Actions after the close).

Sources (official exchange files, one per trading day):
  NSE  /content/cm/BhavCopy_NSE_CM_0_0_0_YYYYMMDD_F_0000.csv.zip        (nsearchives.nseindia.com, UDiFF)
  BSE  /download/BhavCopy/Equity/BhavCopy_BSE_CM_0_0_0_YYYYMMDD_F_0000.CSV (www.bseindia.com, UDiFF)
Equity only (ISIN INE…): NSE series EQ, BE, BZ, SM, ST, SZ, IT (main board, trade-for-trade, SME) and BSE stocks.
A company listed on both exchanges is kept once, under its NSE symbol (NSE is the deeper market). BSE-only companies
use their BSE symbol (with _BSE added if an NSE stock already uses that symbol) and keep their BSE scrip code.

Corporate actions: NSE stocks are back-adjusted from NSE's own records (bonus, split, consolidation, rights, demerger,
dividends; scripts/fetch_bhavcopy.adjust). BSE-only stocks get the splits inferred from the price (no BSE records).

Only the last --days calendar days are kept (default 190 ≈ 6 months); older cache files are deleted, so the job stays
small. Output (in --out, uploaded by the workflow as the `eod-data` release; nothing large is committed):
  eod/prices.csv.gz   sym,date,open,high,low,close,volume,value
  eod/meta.json       {asof, first, symbols: {SYM: {name, isin, ex: NSE|BSE, series, code (BSE scrip code)}}}
  eod/breadth.csv     NSE main-board breadth per day: n, adv, dec, n20, a20, n50, a50, nhi, hi, lo (highs/lows over the window)
  data/eod/_report.json (committed)
Usage: python scripts/fetch_eod.py [--days 190] [--cache .eod_cache] [--out build_eod] [--wait-today 60]
"""
from __future__ import annotations

import argparse
import gzip
import io
import json
import re
import sys
import time
import zipfile
from concurrent.futures import ThreadPoolExecutor
from datetime import date, datetime, timedelta
from pathlib import Path

import numpy as np
import pandas as pd
import requests

sys.path.insert(0, str(Path(__file__).resolve().parent))
import fetch_bhavcopy as B  # noqa: E402

ROOT = Path(__file__).resolve().parents[1]
NSE_SERIES = {"EQ", "BE", "BZ", "SM", "ST", "SZ", "IT"}
BSE_UA = {"User-Agent": B.UA["User-Agent"], "Accept": "*/*", "Referer": "https://www.bseindia.com/"}
UD = {"TckrSymb": "sym", "SctySrs": "series", "ISIN": "isin", "OpnPric": "open", "HghPric": "high", "LwPric": "low", "ClsPric": "close",
      "PrvsClsgPric": "prev", "TtlTradgVol": "vol", "TtlTrfVal": "val", "FinInstrmNm": "name", "FinInstrmId": "code"}
KEEP = ["sym", "series", "isin", "open", "high", "low", "close", "prev", "vol", "val", "name", "code"]


def ist_today() -> date:
    return (datetime.utcnow() + timedelta(hours=5, minutes=30)).date()


def norm(raw: pd.DataFrame, exch: str) -> pd.DataFrame:
    raw.columns = [c.strip() for c in raw.columns]
    if "FinInstrmTp" in raw.columns:
        raw = raw[raw["FinInstrmTp"].astype(str).str.strip().isin(["STK", ""])]
    df = raw.rename(columns=UD)
    for c in KEEP:
        if c not in df.columns:
            df[c] = ""
    df = df[KEEP].copy()
    for c in ("sym", "series", "isin", "name", "code"):
        df[c] = df[c].astype(str).str.strip()
    df = df[df["isin"].str.startswith("INE")]
    if exch == "NSE":
        df = df[df["series"].isin(NSE_SERIES)]
    for c in ("open", "high", "low", "close", "prev", "vol", "val"):
        df[c] = pd.to_numeric(df[c], errors="coerce")
    return df[(df["close"] > 0)]


def get(url: str, headers: dict, session: requests.Session) -> bytes | None:
    for attempt in range(3):
        try:
            r = session.get(url, headers=headers, timeout=40)
        except requests.RequestException:
            time.sleep(1.5 * (attempt + 1))
            continue
        if r.status_code == 200 and len(r.content) > 500:
            return r.content
        if r.status_code == 404:
            return None
        time.sleep(1.5 * (attempt + 1))
    return None


def fetch_day(d: date, exch: str, session: requests.Session) -> tuple[date, pd.DataFrame | None]:
    if exch == "NSE":
        for h in B.HOSTS:
            body = get(f"{h}/content/cm/BhavCopy_NSE_CM_0_0_0_{d:%Y%m%d}_F_0000.csv.zip", B.UA, session)
            if body:
                try:
                    with zipfile.ZipFile(io.BytesIO(body)) as z:
                        name = next(n for n in z.namelist() if n.lower().endswith(".csv"))
                        return d, norm(pd.read_csv(z.open(name), dtype=str), "NSE")
                except Exception:  # noqa: BLE001
                    continue
        return d, None
    for path in (f"/download/BhavCopy/Equity/BhavCopy_BSE_CM_0_0_0_{d:%Y%m%d}_F_0000.CSV",):
        body = get("https://www.bseindia.com" + path, BSE_UA, session)
        if body:
            try:
                return d, norm(pd.read_csv(io.BytesIO(body), dtype=str), "BSE")
            except Exception:  # noqa: BLE001
                return d, None
    return d, None


def download(exch: str, start: date, cache: Path, workers: int) -> dict:
    cache.mkdir(parents=True, exist_ok=True)
    miss_file = cache / "_missing.json"
    missing = set(json.loads(miss_file.read_text())) if miss_file.exists() else set()
    today = ist_today()
    days = [start + timedelta(days=i) for i in range((today - start).days + 1)]
    todo = [d for d in days if not (cache / f"{d:%Y%m%d}.csv.gz").exists() and d.isoformat() not in missing]
    session, got = requests.Session(), 0
    with ThreadPoolExecutor(max_workers=workers) as pool:
        for d, df in pool.map(lambda x: fetch_day(x, exch, session), todo):
            if df is not None and len(df):
                with gzip.open(cache / f"{d:%Y%m%d}.csv.gz", "wt") as f:
                    df.to_csv(f, index=False)
                got += 1
            elif (today - d).days > 5:  # holiday or weekend: stop asking once the day is old
                missing.add(d.isoformat())
    miss_file.write_text(json.dumps(sorted(x for x in missing if x >= start.isoformat())))
    print(f"{exch}: {got} new day files ({len(todo)} days checked)", flush=True)
    return {"new_files": got, "checked": len(todo)}


def prune(cache: Path, start: date) -> int:
    n = 0
    for f in cache.rglob("*.csv*"):
        m = re.match(r"(\d{8})", f.name)
        if m and m.group(1) < f"{start:%Y%m%d}":
            f.unlink()
            n += 1
    return n


def load(cache: Path, start: date) -> pd.DataFrame:
    parts = []
    for f in sorted(cache.glob("*.csv.gz")):
        d = datetime.strptime(f.name[:8], "%Y%m%d").date()
        if d < start:
            continue
        df = pd.read_csv(f, dtype={"sym": str, "series": str, "isin": str, "name": str, "code": str}, keep_default_na=False, na_values={c: [""] for c in ("open", "high", "low", "close", "prev", "vol", "val")})
        df["date"] = np.datetime64(d)
        parts.append(df)
    if not parts:
        return pd.DataFrame(columns=KEEP + ["date"])
    df = pd.concat(parts, ignore_index=True)
    for c in ("open", "high", "low", "close", "prev", "vol", "val"):
        df[c] = pd.to_numeric(df[c], errors="coerce").astype("float64")
    df["open"] = df["open"].where(df["open"] > 0, df["close"])
    df["high"] = df["high"].where(df["high"] > 0, df[["open", "close"]].max(axis=1))
    df["low"] = df["low"].where(df["low"] > 0, df[["open", "close"]].min(axis=1))
    df["prev"] = df["prev"].where(df["prev"] > 0, df["close"])
    df["vol"] = df["vol"].fillna(0)
    df["val"] = df["val"].fillna(0)
    return df


def key_of(s: str) -> str:
    return re.sub(r"[^A-Z0-9&_-]", "", str(s).upper()) or "X"


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--days", type=int, default=190, help="calendar days of history to keep (190 ≈ 6 months)")
    ap.add_argument("--cache", default=".eod_cache")
    ap.add_argument("--out", default="build_eod")
    ap.add_argument("--workers", type=int, default=6)
    ap.add_argument("--wait-today", type=int, default=0, help="minutes to keep retrying for today's (IST) NSE file on a weekday")
    ap.add_argument("--no-bse", action="store_true")
    args = ap.parse_args()
    cache = ROOT / args.cache if not Path(args.cache).is_absolute() else Path(args.cache)
    out = ROOT / args.out if not Path(args.out).is_absolute() else Path(args.out)
    start = ist_today() - timedelta(days=args.days)
    removed = prune(cache, start)
    print(f"Window: {start} to {ist_today()} ({args.days} days); removed {removed} old cache files", flush=True)
    dl = {"NSE": download("NSE", start, cache / "nse", args.workers)}
    if not args.no_bse:
        dl["BSE"] = download("BSE", start, cache / "bse", args.workers)
    today = ist_today()
    waited = 0
    while args.wait_today and today.weekday() < 5 and not (cache / "nse" / f"{today:%Y%m%d}.csv.gz").exists() and waited < args.wait_today:
        print(f"Today's NSE file ({today}) isn't out yet; retrying in 5 minutes ({waited}/{args.wait_today} min)", flush=True)
        time.sleep(300); waited += 5
        download("NSE", start, cache / "nse", args.workers)
    if not args.no_bse:
        download("BSE", start, cache / "bse", args.workers)  # BSE often posts after NSE

    # ---- NSE: one row per (current) ticker and day, adjusted from NSE's corporate-action records
    nse = load(cache / "nse", start)
    if nse.empty:
        raise SystemExit("No NSE files in the window")
    names = nse.sort_values("date").groupby("sym")["name"].last().to_dict()
    changes = B.symbol_changes()
    nse, moved = B.apply_symbol_changes(nse, changes)
    nse_days = sorted({pd.Timestamp(x).date() for x in nse["date"].unique()})
    ca, ca_info = B.corporate_actions(nse_days, cache, args.workers)
    chain = {}
    for old, new, _ in changes:
        chain[old] = new

    def final(sym: str) -> str:
        seen = set()
        while sym in chain and sym not in seen:
            seen.add(sym)
            sym = chain[sym]
        return sym
    acts: dict[str, list] = {}
    for r in ca.itertuples(index=False):
        for kind, val in B.parse_purpose(r.purpose):
            acts.setdefault(final(r.sym), []).append((r.ex, kind, val))
    gaps = B.gap_days(nse) if len(nse_days) > 3 else set()
    frames, meta, stats, jumps = [], {}, {}, []
    last_day = nse["date"].max()
    isins_nse = set()
    for sym, g in nse.groupby("sym", sort=True):
        g = g.sort_values("date").reset_index(drop=True)
        adj, _ = B.adjust(g, gaps, sorted(acts.get(sym, [])), stats)
        adj["sym"] = sym
        frames.append(adj)
        isins_nse |= set(g["isin"])
        meta[sym] = {"name": names.get(sym) or g["name"].iloc[-1], "isin": g["isin"].iloc[-1], "ex": "NSE", "series": g["series"].iloc[-1]}
    print(f"NSE: {len(meta)} stocks over {len(nse_days)} sessions; corporate actions {stats}", flush=True)

    # ---- BSE: companies not listed on NSE
    n_bse = 0
    if not args.no_bse:
        bse = load(cache / "bse", start)
        if len(bse):
            bse = bse[~bse["isin"].isin(isins_nse)]
            latest = bse.sort_values("date").groupby("isin").last()
            used = set(meta)
            for isin, g in bse.groupby("isin", sort=True):
                g = g.sort_values(["date", "val"]).drop_duplicates("date", keep="last").reset_index(drop=True)
                row = latest.loc[isin]
                k = key_of(row["sym"])
                if k in used:
                    k = f"{k}_BSE"
                if k in used:
                    k = f"{key_of(row['sym'])}_{row['code']}"
                used.add(k)
                adj, _ = B.adjust(g, set(), [], stats)
                adj["sym"] = k
                frames.append(adj)
                meta[k] = {"name": row["name"], "isin": isin, "ex": "BSE", "series": row["series"], "code": str(row["code"]).split(".")[0]}
                n_bse += 1
            print(f"BSE-only: {n_bse} stocks", flush=True)
    allp = pd.concat(frames, ignore_index=True)
    allp = allp[["sym", "date", "open", "high", "low", "close", "volume", "value"]].sort_values(["sym", "date"])
    for s, g in allp.groupby("sym"):
        meta[s]["first"] = str(g["date"].iloc[0])[:10]
        meta[s]["last"] = str(g["date"].iloc[-1])[:10]

    # ---- breadth (NSE main board, EQ/BE)
    main_syms = {s for s, m in meta.items() if m["ex"] == "NSE" and m["series"] in ("EQ", "BE", "BZ")}
    cl = allp[allp["sym"].isin(main_syms)].pivot_table(index="date", columns="sym", values="close")
    ret = cl.pct_change(fill_method=None)
    s20, s50 = cl.rolling(20, min_periods=20).mean(), cl.rolling(50, min_periods=50).mean()
    hi, lo = cl.cummax(), cl.cummin()
    br = pd.DataFrame({"n": ret.notna().sum(axis=1), "adv": (ret > 0).sum(axis=1), "dec": (ret < 0).sum(axis=1),
                       "n20": s20.notna().sum(axis=1), "a20": (cl > s20).sum(axis=1), "n50": s50.notna().sum(axis=1), "a50": (cl > s50).sum(axis=1),
                       "nhi": cl.notna().sum(axis=1), "hi": ((cl >= hi) & (cl.notna())).sum(axis=1), "lo": ((cl <= lo) & cl.notna()).sum(axis=1)})
    br = br.iloc[1:]
    br.index.name = "date"

    o = out / "eod"
    o.mkdir(parents=True, exist_ok=True)
    allp = allp.round({"open": 2, "high": 2, "low": 2, "close": 2})
    allp["date"] = pd.to_datetime(allp["date"]).dt.strftime("%Y-%m-%d")
    allp["volume"] = allp["volume"].fillna(0).astype("int64")
    allp["value"] = allp["value"].fillna(0).round(0).astype("int64")
    with gzip.open(o / "prices.csv.gz", "wt", compresslevel=9) as f:
        allp.to_csv(f, index=False)
    br.astype(int).to_csv(o / "breadth.csv")
    asof = str(pd.Timestamp(last_day).date())
    (o / "meta.json").write_text(json.dumps({"asof": asof, "first": str(min(nse_days)), "days": args.days, "symbols": meta}, separators=(",", ":")))
    for i in np.nonzero(np.abs(np.log(allp["close"].to_numpy()[1:] / allp["close"].to_numpy()[:-1])) > 0.5)[0][:400]:
        if allp["sym"].iloc[i] == allp["sym"].iloc[i + 1]:
            jumps.append([allp["sym"].iloc[i + 1], allp["date"].iloc[i + 1], round(float(allp["close"].iloc[i + 1] / allp["close"].iloc[i]), 3)])
    rep = {"asof": asof, "first": str(min(nse_days)), "sessions": len(nse_days), "nse": len(meta) - n_bse, "bse_only": n_bse,
           "rows": len(allp), "bytes": (o / "prices.csv.gz").stat().st_size, "download": dl, "corporate_actions": {**ca_info, **stats},
           "symbol_change_rows_moved": moved, "big_moves_left": jumps[:100]}
    (ROOT / "data" / "eod").mkdir(parents=True, exist_ok=True)
    (ROOT / "data" / "eod" / "_report.json").write_text(json.dumps(rep, indent=1))
    print(json.dumps({k: v for k, v in rep.items() if k != "big_moves_left"}), flush=True)


if __name__ == "__main__":
    main()
