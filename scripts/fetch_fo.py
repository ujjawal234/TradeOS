"""NSE option prices for TradeOS, from NSE's daily F&O bhavcopy (runs on GitHub Actions; NSE is reachable there).

 1. Download the F&O bhavcopy for every trading day since --start into a cache folder (not committed):
      old format  /content/historical/DERIVATIVES/YYYY/MON/foDDMONYYYYbhav.csv.zip   (until 5 Jul 2024)
      UDiFF       /content/fo/BhavCopy_NSE_FO_0_0_0_YYYYMMDD_F_0000.csv.zip          (from 8 Jul 2024)
    Each day is reduced to futures and options on each underlying's nearest 4 expiries, strikes within ±30% of the
    futures price, and cached as csv.gz. Trading days come from the cash-market cache (.bhav_cache, scripts/fetch_bhavcopy.py),
    which also gives each stock's unadjusted spot close.
 2. Walk the days in order and build, per underlying (index or stock, including ones that later left F&O):
    - a daily summary: futures price, spot, 30-day at-the-money implied volatility (interpolated in variance between expiries),
      nearest / next expiry ATM IV, ATM straddle as % of the forward, days to expiry, put/call ratio (open interest and volume),
      max pain, 5% skew (put IV at 95% minus call IV at 105% of the forward), futures and option open interest;
    - option chains for backtests: the nearest two expiries and the nearest two monthly expiries, each with a fixed set of
      strikes chosen the first day that expiry is used (a moneyness grid around its forward, snapped to listed strikes),
      and every day's price for each of them (close when traded that day, NSE's settlement/theoretical price otherwise).
 3. Write app-ready bundles (gzip JSON) into --out; the workflow uploads them as a GitHub release asset, so the git repo
    stays small. Small reports go to data/options/.

Usage: python scripts/fetch_fo.py [--start 2011-01-01] [--end YYYY-MM-DD] [--cache .fo_cache] [--eq-cache .bhav_cache] [--out build_opt]
"""
from __future__ import annotations

import argparse
import gzip
import io
import json
import math
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
from fetch_bhavcopy import HOSTS, UA, symbol_changes  # noqa: E402

ROOT = Path(__file__).resolve().parents[1]
REPORT = ROOT / "data" / "options"
UDIFF_FROM = date(2024, 7, 8)
R = 0.065                      # discount rate for Black-76
KEEP_EXPIRIES = 4
BAND = 0.30                    # cache strikes within ±30% of the futures price
INDEX_UNDERLYINGS = {"NIFTY", "BANKNIFTY", "FINNIFTY", "MIDCPNIFTY", "NIFTYNXT50", "NIFTYIT", "NIFTYMID50", "NIFTYINFRA", "NIFTYPSE", "NIFTYCPSE", "NIFTYMIDCAP", "BANKEX", "SENSEX", "NIFTYDIV", "NIFTYSMALLCAP"}
KEEP_INDICES = {"NIFTY", "BANKNIFTY", "FINNIFTY", "MIDCPNIFTY", "NIFTYNXT50"}
INDEX_SPOT = {  # spot history from data/indices (NSE index files), newest name first
    "NIFTY": ["NIFTY_50", "CNX_NIFTY"], "BANKNIFTY": ["NIFTY_BANK", "CNX_BANK"], "FINNIFTY": ["NIFTY_FINANCIAL_SERVICES", "CNX_FINANCE"],
    "MIDCPNIFTY": ["NIFTY_MIDCAP_SELECT"], "NIFTYNXT50": ["NIFTY_NEXT_50", "CNX_NIFTY_JUNIOR"], "NIFTYIT": ["NIFTY_IT", "CNX_IT"]}
# chain strike grids (% from the forward on the day an expiry is first used)
GRID_INDEX = [-8, -7, -6, -5, -4.5, -4, -3.5, -3, -2.5, -2, -1.75, -1.5, -1.25, -1, -0.75, -0.5, -0.25, 0,
              0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2, 2.5, 3, 3.5, 4, 4.5, 5, 6, 7, 8]
GRID_STOCK = [-15, -10, -7.5, -6.25, -5, -3.75, -2.5, -1.25, 0, 1.25, 2.5, 3.75, 5, 6.25, 7.5, 10, 15]
KIND = {"FUTIDX": "IF", "FUTSTK": "SF", "OPTIDX": "IO", "OPTSTK": "SO", "IDF": "IF", "STF": "SF", "IDO": "IO", "STO": "SO"}
COLS = ["sym", "kind", "exp", "k", "o", "c", "s", "v", "oi", "u", "lot"]


# ------------------------------------------------------------------------------------------ download
def urls_for(d: date) -> list[str]:
    mon = d.strftime("%b").upper()
    old = f"/content/historical/DERIVATIVES/{d:%Y}/{mon}/fo{d:%d}{mon}{d:%Y}bhav.csv.zip"
    new = f"/content/fo/BhavCopy_NSE_FO_0_0_0_{d:%Y%m%d}_F_0000.csv.zip"
    paths = [new, old] if d >= UDIFF_FROM - timedelta(days=10) else [old, new]
    return [h + p for p in paths for h in HOSTS]


def normalise(raw: pd.DataFrame) -> pd.DataFrame:
    raw.columns = [c.strip() for c in raw.columns]
    num = lambda s: pd.to_numeric(s, errors="coerce")  # noqa: E731
    if "TckrSymb" in raw.columns:  # UDiFF
        df = pd.DataFrame({"sym": raw["TckrSymb"].astype(str).str.strip(), "kind": raw["FinInstrmTp"].astype(str).str.strip().map(KIND),
                           "exp": pd.to_datetime(raw["XpryDt"].astype(str).str.strip(), errors="coerce"),
                           "k": num(raw.get("StrkPric")), "o": raw.get("OptnTp", pd.Series("", index=raw.index)).astype(str).str.strip(),
                           "c": num(raw["ClsPric"]), "s": num(raw["SttlmPric"]), "v": num(raw["TtlTradgVol"]), "oi": num(raw["OpnIntrst"]),
                           "u": num(raw.get("UndrlygPric")), "lot": num(raw.get("NewBrdLotQty"))})
    else:
        df = pd.DataFrame({"sym": raw["SYMBOL"].astype(str).str.strip(), "kind": raw["INSTRUMENT"].astype(str).str.strip().map(KIND),
                           "exp": pd.to_datetime(raw["EXPIRY_DT"].astype(str).str.strip(), format="%d-%b-%Y", errors="coerce"),
                           "k": num(raw["STRIKE_PR"]), "o": raw["OPTION_TYP"].astype(str).str.strip(),
                           "c": num(raw["CLOSE"]), "s": num(raw["SETTLE_PR"]), "v": num(raw["CONTRACTS"]), "oi": num(raw["OPEN_INT"]),
                           "u": np.nan, "lot": np.nan})
    df = df.dropna(subset=["kind", "exp"])
    df["o"] = df["o"].str.upper().map({"CE": "C", "CA": "C", "PE": "P", "PA": "P"}).fillna("")
    df.loc[df["kind"].isin(["IF", "SF"]), "o"] = ""
    df = df[(df["kind"].isin(["IF", "SF"])) | (df["o"] != "")]
    for c in ("c", "s", "v", "oi"):
        df[c] = df[c].fillna(0.0)
    return df


def trim(df: pd.DataFrame, d: date) -> pd.DataFrame:
    """futures + options on each underlying's nearest KEEP_EXPIRIES expiries, strikes within ±BAND of its futures price"""
    df = df[df["exp"] >= pd.Timestamp(d)]
    fut = df[df["kind"].isin(["IF", "SF"])].sort_values("exp")
    ref = fut.groupby("sym")["c"].first()
    ref = ref.where(ref > 0, fut.groupby("sym")["s"].first())
    opt = df[df["kind"].isin(["IO", "SO"])]
    ex = opt[["sym", "exp"]].drop_duplicates().sort_values(["sym", "exp"])
    ex["n"] = ex.groupby("sym").cumcount()
    opt = opt.merge(ex[ex["n"] < KEEP_EXPIRIES][["sym", "exp"]], on=["sym", "exp"])
    und = opt.groupby("sym")["u"].median()
    f = opt["sym"].map(ref).fillna(opt["sym"].map(und))
    med = opt.groupby("sym")["k"].transform("median")
    f = f.where(f > 0, med)
    opt = opt[(opt["k"] >= f * (1 - BAND)) & (opt["k"] <= f * (1 + BAND)) & ((opt["s"] > 0) | (opt["c"] > 0) | (opt["oi"] > 0))]
    out = pd.concat([fut, opt], ignore_index=True)
    out["exp"] = out["exp"].dt.strftime("%Y%m%d").astype(int)
    return out[COLS]


def fetch_day(d: date, session: requests.Session) -> tuple[date, pd.DataFrame | None, str]:
    last = "no file"
    for attempt in range(3):
        for u in urls_for(d):
            try:
                r = session.get(u, headers=UA, timeout=60)
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
                return d, trim(normalise(raw), d), "ok"
            except Exception as e:  # noqa: BLE001 — a bad file is treated like a missing one
                last = f"bad file {e.__class__.__name__}: {str(e)[:80]}"
        if last.startswith("http 404"):
            break
        time.sleep(1.5 * (attempt + 1))
    return d, None, last


def trading_days(eq_cache: Path, start: date, end: date) -> list[date]:
    days = sorted(datetime.strptime(f.name[:8], "%Y%m%d").date() for f in eq_cache.glob("*.csv.gz") if f.name[:8].isdigit())
    return [d for d in days if start <= d <= end]


def download(days: list[date], cache: Path, workers: int) -> dict:
    cache.mkdir(parents=True, exist_ok=True)
    miss_file = cache / "_missing.json"
    missing = set(json.loads(miss_file.read_text())) if miss_file.exists() else set()
    todo = [d for d in days if not (cache / f"{d:%Y%m%d}.csv.gz").exists() and d.isoformat() not in missing]
    print(f"F&O bhavcopy: {len(todo)} trading days to fetch of {len(days)}", flush=True)
    session, got, reasons, t0 = requests.Session(), 0, {}, time.time()
    with ThreadPoolExecutor(max_workers=workers) as pool:
        for i, (d, df, why) in enumerate(pool.map(lambda x: fetch_day(x, session), todo)):
            if df is not None and len(df):
                with gzip.open(cache / f"{d:%Y%m%d}.csv.gz", "wt") as f:
                    df.to_csv(f, index=False)
                got += 1
            else:
                reasons[why] = reasons.get(why, 0) + 1
                if (date.today() - d).days > 7:
                    missing.add(d.isoformat())
            if i % 200 == 0:
                print(f"  {i}/{len(todo)} scanned, {got} files, {time.time() - t0:.0f}s", flush=True)
    miss_file.write_text(json.dumps(sorted(missing)))
    print(f"Downloaded {got} new F&O files; not available: {reasons}", flush=True)
    return {"new_files": got, "not_available": reasons}


# ------------------------------------------------------------------------------------------ Black-76
from scipy.special import ndtr  # noqa: E402


def b76(F, K, T, sg, is_call):
    st = sg * np.sqrt(T)
    with np.errstate(divide="ignore", invalid="ignore"):
        d1 = (np.log(F / K) + 0.5 * sg * sg * T) / st
    d2 = d1 - st
    df = np.exp(-R * T)
    return np.where(is_call, df * (F * ndtr(d1) - K * ndtr(d2)), df * (K * ndtr(-d2) - F * ndtr(-d1)))


def implied_vol(px, F, K, T, is_call):
    """vectorised bisection; NaN where the price is at/below intrinsic or unusable"""
    px, F, K, T = (np.asarray(a, dtype=float) for a in (px, F, K, T))
    is_call = np.asarray(is_call, dtype=bool)
    if not len(px):
        return px
    ok = (px > 0) & (T > 0) & (F > 0) & (K > 0)
    px, F, K, T = (np.where(ok, a, 1.0) for a in (px, F, K, T))
    lo, hi = np.full(px.shape, 1e-3), np.full(px.shape, 4.0)
    intr = np.exp(-R * T) * np.where(is_call, np.maximum(F - K, 0), np.maximum(K - F, 0))
    ok &= px > intr + 1e-6
    ok &= b76(F, K, T, hi, is_call) > px
    for _ in range(45):
        mid = 0.5 * (lo + hi)
        above = b76(F, K, T, mid, is_call) > px
        hi = np.where(above, mid, hi)
        lo = np.where(above, lo, mid)
    return np.where(ok, 0.5 * (lo + hi), np.nan)


# ------------------------------------------------------------------------------------------ per-day analysis
def price_of(c, s, v):
    """close when the contract traded that day, else NSE's settlement (theoretical) price"""
    return np.where((v > 0) & (c > 0), c, np.where(s > 0, s, c))


def monthly_set(exps) -> set:
    """an expiry is monthly when no listed expiry falls later in the same calendar month"""
    by = {}
    for e in exps:
        by[e // 100] = max(by.get(e // 100, 0), e)
    return set(by.values())


class IVQueue:
    """collects implied-vol requests for a whole day and solves them in one vectorised pass"""
    def __init__(self):
        self.rows = []

    def add(self, px, F, K, T, call) -> int:
        self.rows.append((px, F, K, T, call))
        return len(self.rows) - 1

    def solve(self):
        if not self.rows:
            self.iv = np.array([])
            return
        a = np.array(self.rows, dtype=float)
        self.iv = implied_vol(a[:, 0], a[:, 1], a[:, 2], a[:, 3], a[:, 4] > 0.5)

    def __getitem__(self, i):
        return float(self.iv[i]) if i is not None and i >= 0 else np.nan


def analyse(sym, a, lo, hi, d_ord: int, spot: float, q: IVQueue) -> dict:
    """one underlying on one day: futures, chains per expiry (numpy), IV requests queued"""
    o, ex, k, c, s, v, oi, u, lot = (a[x][lo:hi] for x in ("o", "exp", "k", "c", "s", "v", "oi", "u", "lot"))
    fut = o == 0
    out = {"F": np.nan, "foi": np.nan, "lot": np.nan}
    if fut.any():
        fi = np.flatnonzero(fut)[np.argsort(ex[fut], kind="stable")]
        out["F"] = float(c[fi[0]] if c[fi[0]] > 0 else s[fi[0]])
        out["foi"] = float(oi[fut].sum())
        if len(fi) > 1:
            out["F2"] = float(c[fi[1]] if c[fi[1]] > 0 else s[fi[1]])
        if out["foi"] > 0:
            out["roll"] = float(oi[fi[1:]].sum() / out["foi"] * 100)  # % of futures OI already in later months
        e0 = int(ex[fi[0]]); out["_fdte"] = date(e0 // 10000, e0 // 100 % 100, e0 % 100).toordinal() - d_ord
    lots = lot[np.isfinite(lot)]
    if len(lots):
        out["lot"] = float(lots[0])
    us = u[np.isfinite(u)]
    out["S"] = float(np.median(us)) if len(us) else spot
    if out["F"] == out["F"] and out["S"] == out["S"] and out["S"] > 0 and "_fdte" in out:
        out["basis"] = (out["F"] / out["S"] - 1) * 365 / max(out["_fdte"], 1) * 100  # annualised futures premium, %
    op = ~fut
    chains = {}
    if not op.any():
        out["chains"] = chains
        return out
    isC = o == 1
    cm, pm = op & isC, op & ~isC
    out["coi"], out["poi"] = float(oi[cm].sum()), float(oi[pm].sum())
    out["pcr"] = out["poi"] / out["coi"] if out["coi"] > 0 else np.nan
    cvs, pvs = v[cm].sum(), v[pm].sum()
    out["pcrv"] = float(pvs / cvs) if cvs > 0 else np.nan
    exps = np.unique(ex[op])
    mset = monthly_set(exps.tolist())
    px_all = price_of(c, s, v)
    Fref = out["F"] if out["F"] == out["F"] and out["F"] > 0 else out["S"]
    for e in exps:
        e = int(e)
        ed = date(e // 10000, e // 100 % 100, e % 100).toordinal()
        dte = ed - d_ord
        T = (dte + 0.25) / 365.0
        mc, mp_ = cm & (ex == e), pm & (ex == e)
        ks = np.union1d(k[mc], k[mp_])
        n = len(ks)
        cp, pp, cv, pv, coi, poi = (np.zeros(n) for _ in range(6))
        ic, ip = np.searchsorted(ks, k[mc]), np.searchsorted(ks, k[mp_])
        cp[ic], cv[ic], coi[ic] = px_all[mc], v[mc], oi[mc]
        pp[ip], pv[ip], poi[ip] = px_all[mp_], v[mp_], oi[mp_]
        if dte <= 0:  # expiry day: NSE's "settlement" column holds the final settlement price, not the option's value
            fsp = out["S"] if out["S"] == out["S"] else Fref
            if fsp == fsp and fsp > 0:
                cp = np.where(cv > 0, cp, np.maximum(fsp - ks, 0)); pp = np.where(pv > 0, pp, np.maximum(ks - fsp, 0))
        Fe = Fref
        both = (cp > 0) & (pp > 0)
        for mask in (both & (cv > 0) & (pv > 0), both):
            if mask.any():
                idx = np.flatnonzero(mask)
                j = idx[int(np.argmin(np.abs(cp[idx] - pp[idx])))]
                cand = ks[j] + math.exp(R * T) * (cp[j] - pp[j])
                if not (Fe == Fe and Fe > 0) or abs(cand / Fe - 1) < 0.06:
                    Fe = float(cand)
                break
        ch = {"k": ks, "c": cp, "p": pp, "cv": cv, "pv": pv, "coi": coi, "poi": poi, "F": Fe, "dte": dte, "T": T, "monthly": e in mset}
        if Fe == Fe and Fe > 0 and dte >= 0 and n:
            j = int(np.argmin(np.abs(ks - Fe)))
            ch["atm"] = j
            ch["qc"] = q.add(cp[j], Fe, ks[j], T, 1) if cp[j] > 0 else None
            ch["qp"] = q.add(pp[j], Fe, ks[j], T, 0) if pp[j] > 0 else None
        chains[e] = ch
    # skew request on the expiry nearest 30 days with at least a week left
    live = [(e, ch) for e, ch in chains.items() if ch["dte"] >= 3 and "atm" in ch]
    if live:
        wk = [x for x in live if x[1]["dte"] >= 7] or live
        e, ch = min(wk, key=lambda x: abs(x[1]["T"] - 30 / 365))
        ks, Fe = ch["k"], ch["F"]
        jp, jc = int(np.argmin(np.abs(ks - Fe * 0.95))), int(np.argmin(np.abs(ks - Fe * 1.05)))
        if abs(ks[jp] / Fe - 0.95) < 0.03 and abs(ks[jc] / Fe - 1.05) < 0.03 and ch["p"][jp] > 0 and ch["c"][jc] > 0:
            out["qsk"] = (q.add(ch["p"][jp], Fe, ks[jp], ch["T"], 0), q.add(ch["c"][jc], Fe, ks[jc], ch["T"], 1))
    # max pain on the nearest monthly expiry
    mons = sorted(e for e in chains if chains[e]["monthly"] and chains[e]["dte"] >= 0)
    if mons:
        ch = chains[mons[0]]
        ks = ch["k"]
        if len(ks) and ch["coi"].sum() + ch["poi"].sum() > 0 and len(ks) <= 600:
            diff = ks[:, None] - ks[None, :]
            pain = (np.maximum(diff, 0) * ch["coi"][None, :]).sum(1) + (np.maximum(-diff, 0) * ch["poi"][None, :]).sum(1)
            out["mp"] = float(ks[int(np.argmin(pain))])
    out["chains"] = chains
    return out


def finish(out: dict, q: IVQueue) -> dict:
    """turn queued IVs into the summary numbers"""
    atm = []
    for e, ch in sorted(out["chains"].items()):
        if "atm" not in ch:
            continue
        ivs = [x for x in (q[ch.get("qc")], q[ch.get("qp")]) if x == x]
        iv = sum(ivs) / len(ivs) if ivs else np.nan
        j = ch["atm"]
        strad = (ch["c"][j] + ch["p"][j]) / ch["F"] * 100 if ch["c"][j] > 0 and ch["p"][j] > 0 else np.nan
        atm.append((ch["T"], iv, ch["dte"], strad))
    live = [x for x in atm if x[2] >= 1 and x[1] == x[1]]
    if live:
        out.update({"ivn": live[0][1], "dte": live[0][2], "st": live[0][3]})
        if len(live) > 1:
            out["ivx"] = live[1][1]
    usable = [x for x in atm if x[2] >= 3 and x[1] == x[1]]
    if usable:
        t30 = 30 / 365.0
        below = [x for x in usable if x[0] <= t30]; above = [x for x in usable if x[0] > t30]
        if below and above:
            a_, b_ = below[-1], above[0]
            w = (b_[0] - t30) / (b_[0] - a_[0])
            out["iv30"] = math.sqrt(max(w * a_[1] ** 2 * a_[0] + (1 - w) * b_[1] ** 2 * b_[0], 0) / t30)
        else:
            out["iv30"] = (above[0] if above else below[-1])[1]
    if "qsk" in out:
        ivp, ivc = q[out["qsk"][0]], q[out["qsk"][1]]
        if ivp == ivp and ivc == ivc:
            out["sk"] = ivp - ivc
    return out


# ------------------------------------------------------------------------------------------ build
def load_index_spots() -> dict:
    """index spot closes from data/indices (NSE index files)"""
    idx = {}
    for sym, names in INDEX_SPOT.items():
        ser = {}
        for n in reversed(names):
            f = ROOT / "data" / "indices" / f"{n}.csv"
            if f.exists():
                df = pd.read_csv(f, usecols=["date", "close"]).dropna()
                ser.update(dict(zip(df["date"], df["close"])))
        idx[sym] = ser
    return idx


def eq_close(eq_cache: Path, d: date) -> dict:
    f = eq_cache / f"{d:%Y%m%d}.csv.gz"
    if not f.exists():
        return {}
    df = pd.read_csv(f, usecols=["sym", "series", "close"])
    df = df.sort_values("series", key=lambda x: x != "EQ").drop_duplicates("sym")
    return dict(zip(df["sym"].astype(str), df["close"].astype(float)))


SUMK = ["F", "F2", "basis", "roll", "S", "iv30", "ivn", "ivx", "st", "dte", "pcr", "pcrv", "mp", "sk", "foi", "coi", "poi", "lot"]


def build(days: list[date], cache: Path, eq_cache: Path, debug: bool) -> dict:
    changes = symbol_changes()
    ren = {}
    for old, new, cd in changes:
        ren.setdefault(old, []).append((cd, new))

    def current(sym: str, d: date) -> str:
        seen = 0
        while sym in ren and seen < 5:
            nxt = [n for cd, n in ren[sym] if d < cd]
            if not nxt:
                break
            sym, seen = nxt[0], seen + 1
        return sym

    idx_spot = load_index_spots()
    S: dict[str, dict] = {}
    anchors: dict[tuple, bool] = {}
    dbg, t0, used = {}, time.time(), 0
    OMAP = {"": 0, "C": 1, "P": 2}
    for n, d in enumerate(days):
        f = cache / f"{d:%Y%m%d}.csv.gz"
        if not f.exists():
            continue
        df = pd.read_csv(f, dtype={"sym": str, "kind": str, "o": str}, keep_default_na=False, na_values={"u": [""], "lot": [""], "k": [""]})
        if df.empty:
            continue
        df["sym"] = [current(x, d) for x in df["sym"]]
        df = df.sort_values(["sym", "exp", "k"], kind="stable")
        a = {"o": df["o"].map(OMAP).fillna(0).to_numpy(int), "exp": df["exp"].to_numpy(np.int64), "k": df["k"].to_numpy(float),
             "c": df["c"].to_numpy(float), "s": df["s"].to_numpy(float), "v": df["v"].to_numpy(float), "oi": df["oi"].to_numpy(float),
             "u": pd.to_numeric(df["u"], errors="coerce").to_numpy(float), "lot": pd.to_numeric(df["lot"], errors="coerce").to_numpy(float)}
        kinds = df["kind"].to_numpy()
        syms, starts = np.unique(df["sym"].to_numpy(), return_index=True)
        ends = list(starts[1:]) + [len(df)]
        eqc = eq_close(eq_cache, d)
        iso, d_ord = d.isoformat(), d.toordinal()
        q = IVQueue()
        todo = []
        for sym, lo, hi in zip(syms, starts, ends):
            is_idx = kinds[lo] in ("IF", "IO")
            if is_idx and sym not in KEEP_INDICES:  # mini/foreign/sector index options (DJIA, S&P500, MINIFTY, CNXIT...): tiny, skipped
                continue
            spot = idx_spot.get(sym, {}).get(iso, np.nan) if is_idx else eqc.get(sym, np.nan)
            todo.append((sym, is_idx, analyse(sym, a, lo, hi, d_ord, spot, q)))
        q.solve()
        used += 1
        for sym, is_idx, out in todo:
            out = finish(out, q)
            chains = out["chains"]
            if not chains and out.get("F") != out.get("F"):
                continue
            u = S.setdefault(sym, {"kind": "index" if is_idx else "stock", "days": [], "sum": {x: [] for x in SUMK}, "ex": {}})
            if u["days"] and u["days"][-1] == iso:
                continue
            u["days"].append(iso)
            i = len(u["days"]) - 1
            if out.get("S") != out.get("S"):  # no spot: the forward of the expiry closest to today (≈ spot on its last day)
                lv = sorted((ch["dte"], ch["F"]) for ch in chains.values() if ch["dte"] >= 0 and ch["F"] == ch["F"])
                out["S"] = lv[0][1] if lv else out.get("F", np.nan)
            for x in SUMK:
                u["sum"][x].append(out.get(x, np.nan))
            exps = sorted(e for e, ch in chains.items() if ch["dte"] >= 0)
            mons = [e for e in exps if chains[e]["monthly"]]
            grid = GRID_INDEX if is_idx else GRID_STOCK
            for e in sorted(set(exps[:2] + mons[:1] + (mons[1:2] if not is_idx else []))):  # indices: 2 nearest + nearest monthly
                ch = chains[e]
                if (sym, e) not in anchors:
                    Fe = ch["F"] if ch["F"] == ch["F"] else out.get("F")
                    if not (Fe == Fe and Fe and Fe > 0) or not len(ch["k"]):
                        continue
                    ks = ch["k"]
                    sel = sorted({float(ks[int(np.argmin(np.abs(ks - Fe * (1 + m / 100))))]) for m in grid})
                    sel = [x for x in sel if abs(x / Fe - 1) <= (0.085 if is_idx else 0.16)]
                    anchors[(sym, e)] = True
                    u["ex"][e] = {"k": sel, "i0": i, "C": [], "P": []}
                blk = u["ex"].get(e)
                if blk is None:
                    continue
                while blk["i0"] + len(blk["C"]) < i:
                    blk["C"].append(None); blk["P"].append(None)
                pos = {x: j for j, x in enumerate(ch["k"].tolist())}
                rc, rp = [], []
                for x in blk["k"]:
                    j = pos.get(x)
                    for arr, vol, row in ((ch["c"], ch["cv"], rc), (ch["p"], ch["pv"], rp)):
                        if j is None:
                            row.append(None)
                        else:
                            px = float(arr[j])
                            row.append(0 if px <= 0 else int(round(px * 20)) * (1 if vol[j] > 0 else -1))
                blk["C"].append(rc); blk["P"].append(rp)
            if debug and sym in ("NIFTY", "RELIANCE", "BANKNIFTY", "INFY") and d.day in (3, 4, 5, 6) and len(dbg) < 60:
                e0 = exps[0] if exps else None
                if e0 is not None:
                    ch = chains[e0]; j = ch.get("atm", 0)
                    rows = [[float(ch["k"][jj]), float(ch["c"][jj]), float(ch["cv"][jj]), float(ch["p"][jj]), float(ch["pv"][jj])] for jj in range(max(0, j - 2), min(len(ch["k"]), j + 3))]
                    dbg[f"{sym} {iso}"] = {"summary": {x: (round(float(out[x]), 4) if isinstance(out.get(x), (int, float)) and out[x] == out[x] else None) for x in SUMK},
                                           "exp": e0, "F_e": ch["F"], "dte": ch["dte"], "atm_rows[k,call,callvol,put,putvol]": rows}
        if n % 250 == 0:
            print(f"  built {n}/{len(days)} days ({d}), {len(S)} underlyings, {time.time() - t0:.0f}s", flush=True)
    return {"S": S, "debug": dbg, "days_used": used}


def raw_sample(cache: Path, days: list[date]) -> dict:
    """a few raw cached rows around the money, to check how NSE fills close vs settle"""
    out = {}
    for d in days:
        f = cache / f"{d:%Y%m%d}.csv.gz"
        if not f.exists():
            continue
        df = pd.read_csv(f, dtype={"sym": str, "o": str}, keep_default_na=False)
        for col in ("k", "c", "s", "v", "oi", "exp"):
            df[col] = pd.to_numeric(df[col], errors="coerce")
        for sym in ("NIFTY", "RELIANCE"):
            g = df[(df["sym"] == sym)]
            if g.empty:
                continue
            fut = g[g["o"] == ""]
            e0 = g[g["o"] != ""]["exp"].min()
            F = float(fut["c"].iloc[0]) if len(fut) else float(g["k"].median())
            x = g[(g["exp"] == e0) & (g["o"] != "") & ((g["k"] - F).abs() <= F * 0.03)]
            out[f"{sym} {d}"] = x.astype(str).values.tolist()[:12]
    return out


SCALE = {"F2": 100, "basis": 100, "roll": 10, "iv30": 1000, "ivn": 1000, "ivx": 1000, "st": 1000, "dte": 1, "pcr": 1000, "pcrv": 1000, "mp": 100, "sk": 1000, "foi": 1, "coi": 1, "poi": 1}


def ints(vals, mult):
    return [None if v != v else int(round(v * mult)) for v in vals]


def pack(u: dict) -> tuple[dict, dict]:
    """compact JSON for the app. chains: day offsets, futures/spot (×100), per-expiry strike list + daily price rows
    (price×20, negative = not traded that day, null = not listed). summary: scaled integer series (see SCALE)."""
    ep = [(date.fromisoformat(x) - date(1970, 1, 1)).days for x in u["days"]]
    dd = np.diff(ep, prepend=ep[0]).tolist()
    ex = []
    for e, blk in sorted(u["ex"].items()):
        ed = (datetime.strptime(str(e), "%Y%m%d").date() - date(1970, 1, 1)).days
        ex.append([ed, [round(k, 2) for k in blk["k"]], blk["i0"], blk["C"], blk["P"]])
    chains = {"d0": ep[0], "dd": dd, "F": ints(u["sum"]["F"], 100), "S": ints(u["sum"]["S"], 100), "ex": ex}
    summ = {"d0": ep[0], "dd": dd, "scale": SCALE, "s": {k: ints(u["sum"][k], m) for k, m in SCALE.items() if any(v == v for v in u["sum"][k])}}
    return chains, summ


def write_app(S: dict, out: Path, chain_bytes: int = 6_000_000, sum_bytes: int = 3_000_000) -> dict:
    """gzip JSON bundles of several underlyings each (an artifact holds ~500 files): cNN = chains, sNN = summaries"""
    out.mkdir(parents=True, exist_ok=True)
    for f in out.glob("*.json.gz"):
        f.unlink()
    order = sorted(S, key=lambda s: (S[s]["kind"] != "index", s))
    index, sizes = {}, {}
    bufs = {"c": [{}, 0, 0, chain_bytes], "s": [{}, 0, 0, sum_bytes]}

    def flush(kind):
        cur, _, b, _ = bufs[kind]
        if not cur:
            return
        key = f"{kind}{b:02d}"
        (out / f"{key}.json.gz").write_bytes(gzip.compress(json.dumps(cur, separators=(",", ":")).encode(), 9))
        for sym in cur:
            index[sym][kind] = key
        bufs[kind] = [{}, 0, b + 1, bufs[kind][3]]

    for sym in order:
        u = S[sym]
        lot = next((v for v in reversed(u["sum"]["lot"]) if v == v), None)
        index[sym] = {"kind": u["kind"], "first": u["days"][0], "last": u["days"][-1], "days": len(u["days"]), "lot": lot, "expiries": len(u["ex"])}
        ch, sm = pack(u)
        for kind, obj in (("c", ch), ("s", sm)):
            z = len(gzip.compress(json.dumps(obj, separators=(",", ":")).encode(), 6))
            sizes[f"{sym}.{kind}"] = z
            if bufs[kind][0] and bufs[kind][1] + z > bufs[kind][3]:
                flush(kind)
            bufs[kind][0][sym] = obj
            bufs[kind][1] += z
    flush("c"); flush("s")
    return {"index": index, "sizes": sizes}


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--start", default="2011-01-01")
    ap.add_argument("--end", default=None)
    ap.add_argument("--cache", default=".fo_cache")
    ap.add_argument("--eq-cache", default=".bhav_cache")
    ap.add_argument("--out", default="build_opt")
    ap.add_argument("--workers", type=int, default=8)
    ap.add_argument("--wait-today", type=int, default=0)
    ap.add_argument("--debug", action="store_true")
    args = ap.parse_args()
    start = date.fromisoformat(args.start)
    end = date.fromisoformat(args.end) if args.end else date.today()
    cache, eqc, out = (ROOT / p if not Path(p).is_absolute() else Path(p) for p in (args.cache, args.eq_cache, args.out))
    days = trading_days(eqc, start, end)
    if not days:
        raise SystemExit(f"No trading days found in {eqc} (run scripts/fetch_bhavcopy.py first)")
    dl = download(days, cache, args.workers)
    today_ist = (datetime.utcnow() + timedelta(hours=5, minutes=30)).date()
    waited = 0
    while args.wait_today and today_ist.weekday() < 5 and today_ist in days and not (cache / f"{today_ist:%Y%m%d}.csv.gz").exists() and waited < args.wait_today:
        print(f"Today's F&O bhavcopy ({today_ist}) isn't out yet; retrying in 5 minutes", flush=True)
        time.sleep(300); waited += 5
        download([today_ist], cache, args.workers)
    res = build(days, cache, eqc, args.debug)
    S = res["S"]
    app = write_app(S, out / "app" / "opt")
    idx = {"asof": max(u["days"][-1] for u in S.values()) if S else None, "underlyings": app["index"],
           "method": "NSE F&O bhavcopy. Price = close when the contract traded that day, else NSE's settlement (theoretical) price; "
                     "negative in the data = not traded that day. Chains keep the nearest two expiries and nearest two monthly expiries, "
                     "each with a fixed strike set chosen the first day it is used (moneyness grid around its forward). IV = Black-76 on the "
                     "put-call-parity forward, r = 6.5%; iv30 interpolated in total variance."}
    (out / "app" / "opt" / "index.json").write_text(json.dumps(idx, separators=(",", ":")))
    REPORT.mkdir(parents=True, exist_ok=True)
    (REPORT / "index.json").write_text(json.dumps(idx, indent=1))
    tot = sum(f.stat().st_size for f in (out / "app" / "opt").glob("*.gz"))
    big = sorted(app["sizes"].items(), key=lambda x: -x[1])[:15]
    (REPORT / "_report.json").write_text(json.dumps({"asof": idx["asof"], "days": len(days), "days_used": res["days_used"], "download": dl, "underlyings": len(S),
        "indices": sorted(s for s, u in S.items() if u["kind"] == "index"), "bundle_bytes": tot, "bundles": len(list((out / "app" / "opt").glob("*.gz"))),
        "largest": big, "debug": res["debug"], "raw_sample": raw_sample(cache, [x for x in days if x.day in (4, 5)][:: max(1, len(days) // 12)][:12]) if args.debug else None}, indent=1))
    print(f"Options: {len(S)} underlyings, {tot / 1e6:.1f} MB gzip in {len(list((out / 'app' / 'opt').glob('*.gz')))} bundles", flush=True)


if __name__ == "__main__":
    main()
