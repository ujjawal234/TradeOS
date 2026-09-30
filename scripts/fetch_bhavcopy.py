"""Survivorship-free, point-in-time stock universes from NSE's daily bhavcopy.

Runs on GitHub Actions (NSE is reachable there). Steps:
 1. Download the NSE cash-market bhavcopy for every weekday since --start into a cache folder (not committed):
    old format  /content/historical/EQUITIES/YYYY/MON/cmDDMONYYYYbhav.csv.zip   (until 5 Jul 2024)
    UDiFF       /content/cm/BhavCopy_NSE_CM_0_0_0_YYYYMMDD_F_0000.csv.zip        (from 8 Jul 2024)
    Each day is reduced to equity rows (series EQ/BE/BZ, no ETFs/MF units) and cached as csv.gz.
 2. Map old tickers to today's ticker with NSE's symbolchange.csv (date-aware, chains resolved).
 3. Adjust prices for corporate actions from NSE's own records: the daily price-report zip (PRddmmyy.zip) carries
    Bc*.csv with every bonus, split, consolidation and dividend and its ex-date. Bonus/split/consolidation factors are
    applied only when the ex-date price move confirms them; dividends are taken off earlier prices like Yahoo's
    adjusted closes, so results are comparable with the rest of the app.
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
    # weekends too: NSE holds special sessions (Diwali Muhurat, Saturday DR-site sessions) and the next day's PREVCLOSE refers to them
    todo = [d for d in days if not (cache / f"{d:%Y%m%d}.csv.gz").exists() and d.isoformat() not in missing]
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


# ------------------------------------------------------------------------------------------ corporate actions
def fetch_pr(d: date, session: requests.Session) -> tuple[date, pd.DataFrame | None, str]:
    last = "no file"
    for attempt in range(3):
        for h in HOSTS:
            try:
                r = session.get(f"{h}/archives/equities/bhavcopy/pr/PR{d:%d%m%y}.zip", headers=UA, timeout=40)
            except requests.RequestException as e:
                last = f"error {e.__class__.__name__}"
                continue
            if r.status_code != 200 or len(r.content) < 200:
                last = f"http {r.status_code}"
                continue
            try:
                with zipfile.ZipFile(io.BytesIO(r.content)) as z:
                    names = [n for n in z.namelist() if n.split("/")[-1].lower().startswith("bc") and n.lower().endswith(".csv")]
                    if not names:
                        return d, pd.DataFrame(columns=["sym", "series", "ex", "purpose"]), "no bc"
                    raw = pd.read_csv(z.open(names[0]), dtype=str)
                raw.columns = [c.strip().upper() for c in raw.columns]
                out = pd.DataFrame({"sym": raw.get("SYMBOL", "").astype(str).str.strip(), "series": raw.get("SERIES", "").astype(str).str.strip(),
                                    "ex": raw.get("EX_DT", "").astype(str).str.strip(), "purpose": raw.get("PURPOSE", "").astype(str).str.strip()})
                return d, out, "ok"
            except Exception as e:  # noqa: BLE001
                last = f"bad file {e.__class__.__name__}"
        if last.startswith("http 404"):
            break
        time.sleep(1.5 * (attempt + 1))
    return d, None, last


def corporate_actions(days: list[date], cache: Path, workers: int) -> tuple[pd.DataFrame, dict]:
    cdir = cache / "ca"
    cdir.mkdir(parents=True, exist_ok=True)
    miss_file = cdir / "_missing.json"
    missing = set(json.loads(miss_file.read_text())) if miss_file.exists() else set()
    todo = [d for d in days if not (cdir / f"{d:%Y%m%d}.csv").exists() and d.isoformat() not in missing]
    print(f"Corporate actions: {len(todo)} price-report files to fetch", flush=True)
    session, got, reasons = requests.Session(), 0, {}
    with ThreadPoolExecutor(max_workers=workers) as pool:
        for i, (d, df, why) in enumerate(pool.map(lambda x: fetch_pr(x, session), todo)):
            if df is not None:
                df.to_csv(cdir / f"{d:%Y%m%d}.csv", index=False)
                got += 1
            else:
                reasons[why] = reasons.get(why, 0) + 1
                if (date.today() - d).days > 7:
                    missing.add(d.isoformat())
            if i % 500 == 0:
                print(f"  {i}/{len(todo)} scanned, {got} files", flush=True)
    miss_file.write_text(json.dumps(sorted(missing)))
    parts = [pd.read_csv(f, dtype=str) for f in sorted(cdir.glob("*.csv"))]
    ca = pd.concat(parts, ignore_index=True).dropna(subset=["sym", "ex", "purpose"]) if parts else pd.DataFrame(columns=["sym", "series", "ex", "purpose"])
    ca["ex"] = pd.to_datetime(ca["ex"], dayfirst=True, errors="coerce", format="mixed")
    ca = ca.dropna(subset=["ex"]).drop_duplicates(["sym", "ex", "purpose"])
    print(f"Corporate actions: {len(ca):,} distinct records from {len(parts)} files (new {got}; not available {reasons})", flush=True)
    return ca, {"files": len(parts), "new": got, "not_available": reasons, "records": len(ca)}


STD_SPLIT = [1 / 2, 2 / 5, 1 / 4, 1 / 5, 1 / 10, 1 / 3, 1 / 20, 1 / 100, 1 / 1.5]
STD_BONUS = [1 / 2, 2 / 3, 1 / 3, 3 / 4, 1 / 4, 4 / 5, 1 / 5, 3 / 5, 5 / 6, 1 / 6, 2 / 5]


def parse_purpose(p: str) -> list[tuple[str, float]]:
    """NSE's (often abbreviated or cut-off) purpose text -> actions:
    ('ratio', f) known price factor (bonus a:b -> b/(a+b); split/consolidation from X to Y -> Y/X)
    ('split?', 0) / ('bonus?', 0) split or bonus with an unreadable ratio (matched to standard ratios on price)
    ('demerger', 0) demerger / scheme of arrangement / capital reduction (adjusted by the ex-date price gap)
    ('div', rupees) cash dividend."""
    import re
    P = str(p).upper().replace("/-", " ").replace("-", " ")
    P = re.sub(r"(\d)\s*TO\b", r"\1 TO", re.sub(r"\bTO\s*(\d)", r"TO \1", re.sub(r"(\d)TO", r"\1 TO ", re.sub(r"TO(\d)", r"TO \1", P))))
    P = re.sub(r"(INT|FIN|SPL|SPECIAL|INTERIM|FINAL)DIV", r"\1 DIV", P)
    P = " ".join(P.split())
    out = []
    bon = re.findall(r"\bBON(?:US)?(?![A-Z])[^0-9/]{0,12}(\d+(?:\.\d+)?)\s*:\s*(\d+(?:\.\d+)?)", P)
    for x, y in bon:
        x, y = float(x), float(y)
        if x > 0 and y > 0:
            out.append(("ratio", y / (x + y)))
    if not bon and re.search(r"\bBON(?:US)?(?![A-Z])", P):
        out.append(("bonus?", 0.0))
    if re.search(r"SPLI?T|\bFV\s*SPL|FVSPL|SUB\s*DIV|CONSOL|\bSPL\s*(?:FRM|FROM|RS|RE)", P):
        m = re.search(r"(?:FRM|FROM|FR|RS|RE|INR|SPLT|SPL|SPLIT)\.?\s*(\d+(?:\.\d+)?)[^0-9]{0,24}?\bTO\s*(?:RS|RE|INR)?\.?\s*(\d+(?:\.\d+)?)", P)
        if m and float(m.group(1)) > 0 and float(m.group(2)) > 0 and m.group(1) != m.group(2):
            out.append(("ratio", float(m.group(2)) / float(m.group(1))))
        else:
            out.append(("consol?" if "CONSOL" in P else "split?", 0.0))
    for a_, b_, prem in re.findall(r"RIGHTS?\s*(\d+(?:\.\d+)?)\s*:\s*(\d+(?:\.\d+)?)\s*@?\s*(?:PRM|PREM(?:IUM)?|PREMIUM|PR)?\.?\s*(?:OF\s*)?(?:RS|RE)?\.?\s*(\d+(?:\.\d+)?)", P):
        if float(a_) > 0 and float(b_) > 0:
            out.append(("rights", (float(a_), float(b_), float(prem))))  # a new shares for b held at ~premium (+ small face value)
    if re.search(r"DEMERG|SCHEME OF ARR|ARRANGEMENT|CAP(?:ITAL)? RED|SPIN", P):
        out.append(("demerger", 0.0))
    for m in re.finditer(r"\bDIV(?:IDEND)?\b\s*[:]?\s*(?:RS|RE|INR)?\.?\s*(\d+(?:\.\d+)?)(?!\s*%|\d)", P):
        out.append(("div", float(m.group(1))))
    return out


def gap_days(df: pd.DataFrame) -> set:
    """Days where PREVCLOSE differs from the previous file's close for most stocks: a session is missing from the
    archive, so the difference is that session's price move, not a corporate action."""
    d = df.sort_values(["sym", "date"])
    f = d["prev"].to_numpy() / d.groupby("sym")["close"].shift(1).to_numpy()
    moved = pd.Series(np.abs(f - 1) >= 0.0005, index=d["date"].to_numpy())[~np.isnan(f)]
    grp = moved.groupby(level=0)
    share, count = grp.mean(), grp.size()
    out = set(share[(share > 0.3) & (count >= 50)].index)
    print(f"Gap days ignored for adjustments: {len(out)} {sorted(str(x)[:10] for x in out)[:20]}", flush=True)
    return out


def adjust(g: pd.DataFrame, gaps: set = frozenset(), acts: list | None = None, stats: dict | None = None) -> tuple[pd.DataFrame, list]:
    """Back-adjust one ticker: NSE-recorded bonuses/splits/consolidations (confirmed by the ex-date price move) and
    dividends; plus any PREVCLOSE adjustment NSE itself made."""
    close, prev, opn = g["close"].to_numpy(), g["prev"].to_numpy(), g["open"].to_numpy()
    dates = g["date"].to_numpy()
    f = np.ones(len(g))
    f[1:] = prev[1:] / close[:-1]
    if gaps:
        f[g["date"].isin(gaps).to_numpy()] = 1.0
    f[~np.isfinite(f) | (f <= 0)] = 1.0
    f[np.abs(f - 1) < 0.02] = 1.0  # only NSE's own large adjustments count; small ones are dividends handled below
    f[(f < 0.001) | (f > 1000)] = 1.0
    st = stats if stats is not None else {}
    by_day: dict = {}
    for ex, kind, val in acts or []:
        by_day.setdefault(ex, []).append((kind, val))
    for ex, a in sorted(by_day.items()):
        t = int(np.searchsorted(dates, np.datetime64(ex)))
        if t <= 0 or t >= len(g) or (dates[t] - np.datetime64(ex)) > np.timedelta64(7, "D"):
            st["outside_data"] = st.get("outside_data", 0) + 1
            continue
        c = close[t - 1]
        moves = [np.log(x / c) for x in (opn[t], close[t]) if x > 0]
        err = lambda v: min(abs(m - np.log(v)) for m in moves) if moves and v > 0 else 9  # noqa: E731
        kinds = {k for k, _ in a}
        ratios = [v for k, v in a if k == "ratio" and abs(v - 1) >= 0.02]
        applied = False
        if (ratios or kinds & {"split?", "bonus?", "consol?"}) and f[t] == 1.0:
            # the same announcement can be listed more than once, and a bonus and a split can share an ex-date;
            # unreadable ratios are matched to standard ones — whichever combination fits the ex-date move
            cands = {round(float(np.prod(ratios)), 6), round(float(np.prod(sorted(set(ratios)))), 6), *[round(x, 6) for x in set(ratios)]} if ratios else set()
            base = [float(np.prod(sorted(set(ratios))))] if ratios else [1.0]
            if "split?" in kinds:
                cands |= {round(b * x, 6) for b in base for x in STD_SPLIT}
            if "bonus?" in kinds:
                cands |= {round(b * x, 6) for b in base for x in STD_BONUS}
            if "split?" in kinds and "bonus?" in kinds:
                cands |= {round(x * y, 6) for x in STD_SPLIT for y in STD_BONUS}
            if "consol?" in kinds:
                cands |= {round(b * x, 6) for b in base for x in (2, 4, 5, 10, 20)}
            known = ({round(float(np.prod(ratios)), 6), round(float(np.prod(sorted(set(ratios)))), 6), *[round(x, 6) for x in set(ratios)]}) if ratios else set()
            cands.discard(1.0)
            best = min(cands, key=err) if cands else None
            tol = 0.2 if best in known else 0.1  # a ratio NSE stated may sit further from the move than one we infer
            if best is not None and err(best) < tol:
                f[t] *= best
                applied = True
                st["ratio_applied"] = st.get("ratio_applied", 0) + 1
            else:
                st["ratio_rejected"] = st.get("ratio_rejected", 0) + 1
        if "demerger" in kinds and not applied and f[t] == 1.0 and moves:
            go, gc = (opn[t] / c if opn[t] > 0 else 1.0), close[t] / c
            # the ex-date open is normally the discovered price; if it opened near the old price and then collapsed, use the close
            gap = gc if (abs(np.log(go)) < 0.15 and abs(np.log(gc)) > 0.3) or not (0.02 < go < 0.97) else go
            if 0.02 < gap < 0.97:
                f[t] *= gap
                st["demergers"] = st.get("demergers", 0) + 1
        for k, v in a:
            if k == "rights" and f[t] == 1.0:
                na, nb, price = v
                terp = (nb * c + na * price) / (na + nb)  # theoretical ex-rights price
                if price < c and 0.4 < terp / c < 0.995:
                    f[t] *= terp / c
                    st["rights"] = st.get("rights", 0) + 1
        divs = sorted({round(v, 4) for k, v in a if k == "div" and v > 0})
        dsum = sum(divs)
        # ordinary dividends as stated; a very large (special) one only when the ex-date move confirms it
        if divs and (dsum < 0.25 * c or (dsum < 0.9 * c and err((c - dsum) / c) < 0.15)):
            f[t] *= (c - dsum) / c
            st["dividends"] = st.get("dividends", 0) + 1
    # splits NSE's records miss: a close-to-close AND open move within 6% of 1/2, 1/4, 1/5 or 1/10, without the
    # turnover spike a crash brings (a split leaves traded value roughly unchanged)
    val = g["val"].to_numpy()
    for t in range(21, len(g)):
        if f[t] != 1.0 or close[t - 1] <= 0:
            continue
        rc, ro = close[t] / close[t - 1], (opn[t] / close[t - 1] if opn[t] > 0 else close[t] / close[t - 1])
        if abs(np.log(rc)) < 0.6:
            continue
        for k in (0.5, 0.25, 0.2, 0.1):
            if abs(np.log(rc / k)) < 0.06 and abs(np.log(ro / k)) < 0.12:
                base = np.nanmedian(val[t - 20:t])
                if base > 0 and val[t] < 4 * base:
                    f[t] = k
                    st["inferred_splits"] = st.get("inferred_splits", 0) + 1
                break
    events = [(str(g["date"].iloc[i])[:10], round(float(f[i]), 5)) for i in np.nonzero(np.abs(f - 1) >= 0.02)[0]]
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
    changes = symbol_changes()
    df, moved = apply_symbol_changes(df, changes)
    ca, ca_info = corporate_actions(sorted({pd.Timestamp(x).date() for x in df["date"].unique()}), cache, args.workers)
    uni, members, info = build(df)
    gaps = gap_days(df)
    print(f"Reviews: {len(info['reviews'])} ({info['reviews'][0]} … {info['reviews'][-1]}); stocks ever in the top 200: {len(members)}", flush=True)
    prices = OUT / "prices"
    prices.mkdir(parents=True, exist_ok=True)
    keep = set(members)
    for f in prices.glob("*.csv"):
        if f.stem not in keep:
            f.unlink()
    # corporate actions per (today's) ticker
    def current(sym: str, when) -> str:
        for old, new, d in changes:
            if sym == old and when < pd.Timestamp(d):
                sym = new
        return sym
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
        cur = current(r.sym, r.ex)
        if cur not in keep and final(r.sym) in keep:
            cur = final(r.sym)
        for kind, val in parse_purpose(r.purpose):
            acts.setdefault(cur, []).append((r.ex, kind, val))
    ca_stats: dict = {}
    adj_stats, examples, ends, jumps = {"tickers_adjusted": 0, "events": 0, "small_events": 0}, {}, {}, []
    for sym, g in df[df["sym"].isin(keep)].groupby("sym", sort=True):
        out, events = adjust(g.sort_values("date").reset_index(drop=True), gaps, sorted(acts.get(sym, [])), ca_stats)
        r = np.log(out["close"].to_numpy()[1:] / out["close"].to_numpy()[:-1])
        for i in np.nonzero(np.abs(r) > 0.4)[0]:  # large one-day moves left after adjusting: listed for review
            jumps.append([sym, str(out["date"].iloc[i + 1])[:10], round(float(np.exp(r[i])), 3)])
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
    print(f"Corporate actions applied: {ca_stats}; one-day moves beyond ±40% left: {len(jumps)}", flush=True)
    # diagnostics: NSE's records near each unexplained move, and split/bonus texts the parser could not read
    ca["cur"] = [(current(a, b) if current(a, b) in keep else final(a)) for a, b in zip(ca["sym"], ca["ex"])]
    for j in jumps[:200]:
        near = ca[(ca["cur"] == j[0]) & ((ca["ex"] - pd.Timestamp(j[1])).abs() <= pd.Timedelta(days=20))]
        j.append([f"{str(r.ex)[:10]} {r.purpose}" for r in near.itertuples()][:4])
    dbg = {}
    for sym, day in (("ADANIENT", "2015-06-03"), ("360ONE", "2023-03-02")):
        g = df[(df["sym"] == sym) & ((df["date"] - pd.Timestamp(day)).abs() <= pd.Timedelta(days=5))]
        dbg[sym] = {"rows": g[["date", "series", "open", "close", "prev", "val"]].astype(str).values.tolist(), "acts": [[str(e)[:10], k, str(v)] for e, k, v in acts.get(sym, []) if abs((pd.Timestamp(e) - pd.Timestamp(day)).days) <= 30]}
    kw = ca[ca["purpose"].str.upper().str.contains("SPLIT|SUB|BONUS|CONSOL|FV|FACE", regex=True, na=False)]
    unread = sorted({p for p in kw["purpose"] if not any(k in ("ratio", "split?", "bonus?", "demerger") for k, _ in parse_purpose(p))})
    (OUT / "_report.json").write_text(json.dumps({**info, "download": dl, "corporate_actions": {**ca_info, **ca_stats}, "big_moves_left": jumps[:200], "debug": dbg, "unread_split_texts": unread[:300], "gap_days": sorted(str(x)[:10] for x in gaps), "symbol_change_rows_moved": moved, "members": len(members),
        "members_no_longer_trading": len(stale), "examples_no_longer_trading": stale[:60], "adjustments": adj_stats,
        "adjustment_examples": examples, "sizes": {k: [len(x[1]) for x in v][-3:] for k, v in uni.items()}}, indent=1))
    print(f"Wrote {len(members)} price files; {len(stale)} of them stopped trading (delisted, merged or suspended). Adjustments: {adj_stats}", flush=True)


if __name__ == "__main__":
    main()
