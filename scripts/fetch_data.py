"""Download the tradable universe and daily OHLCV history from NSE/Yahoo into data/.

Runs on GitHub Actions (open internet). Steps:
 1. Constituent lists from NSE archives: Nifty 50, Nifty 200 (with industry) and the F&O list
    (with lot sizes). Falls back to the last saved data/universe.json if NSE is unreachable.
 2. Daily prices from Yahoo Finance (split- and dividend-adjusted), 15 years on first run and
    incremental afterwards. A symbol is fully re-downloaded when its recent adjusted prices no
    longer match what is stored (a dividend or split re-adjusts all history).

Usage:  python scripts/fetch_data.py [--years 15] [--full] [--only SYM1,SYM2]
"""
from __future__ import annotations

import argparse
import csv
import io
import json
import sys
import time
from concurrent.futures import ThreadPoolExecutor
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

import pandas as pd
import requests
import yfinance as yf

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from tradeos.data.universe import INDICES, NIFTY50, SECTORS, to_yahoo  # noqa: E402
from tradeos.data.yahoo import drop_unfinished  # noqa: E402

OUT = ROOT / "data" / "prices"
UNIVERSE_FILE = ROOT / "data" / "universe.json"
UA = {"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) "
                    "Chrome/140.0 Safari/537.36", "Accept": "text/csv,*/*"}
HOSTS = ["https://nsearchives.nseindia.com", "https://archives.nseindia.com"]
INDEX_UNDERLYINGS = {"NIFTY", "BANKNIFTY", "FINNIFTY", "MIDCPNIFTY", "NIFTYNXT50", "SENSEX", "BANKEX"}

# Every index we try; each key maps to Yahoo tickers tried in order. Keys with no real history are dropped later.
EXTRA_INDICES = {
    "NIFTYNEXT50": ["^NSMIDCP"], "NIFTY100": ["^CNX100"], "NIFTY200": ["^CNX200"], "NIFTY500": ["^CRSLDX"],
    "NIFTYMIDCAP50": ["^NSEMDCP50"], "NIFTYMIDCAP100": ["NIFTY_MIDCAP_100.NS", "^CNXMIDCAP"], "NIFTYMIDSELECT": ["NIFTY_MID_SELECT.NS"],
    "NIFTYSMALLCAP100": ["^CNXSC", "NIFTY_SMLCAP_100.NS"], "NIFTYPSE": ["^CNXPSE"], "NIFTYMNC": ["^CNXMNC"],
    "NIFTYCONSUMPTION": ["^CNXCONSUM"], "NIFTYCOMMODITIES": ["^CNXCMDT"], "NIFTYSERVICES": ["^CNXSERVICE"],
    "NIFTYPVTBANK": ["NIFTY_PVT_BANK.NS"], "NIFTYHEALTHCARE": ["NIFTY_HEALTHCARE.NS"], "NIFTYOILGAS": ["NIFTY_OIL_AND_GAS.NS"],
    "NIFTYCONSDURABLES": ["NIFTY_CONSR_DURBL.NS"], "NIFTYCPSE": ["NIFTY_CPSE.NS"], "NIFTYDIVOPPS50": ["NIFTY_DIV_OPPS_50.NS"],
    "BANKEX": ["BSE-BANK.BO"], "BSE100": ["BSE-100.BO"], "BSE500": ["BSE-500.BO"], "BSEMIDCAP": ["BSE-MIDCAP.BO"], "BSESMALLCAP": ["BSE-SMLCAP.BO"],
}
# World markets, rates, currencies and commodities (Yahoo). Keys become app symbols in the "global" group.
GLOBAL = {
    "SPX": "^GSPC", "NASDAQ": "^IXIC", "DOWJONES": "^DJI", "RUSSELL2000": "^RUT", "USVIX": "^VIX", "NIKKEI": "^N225", "HANGSENG": "^HSI",
    "SHANGHAI": "000001.SS", "KOSPI": "^KS11", "TAIWAN": "^TWII", "FTSE100": "^FTSE", "DAX": "^GDAXI", "CAC40": "^FCHI", "EUROSTOXX50": "^STOXX50E",
    "MSCI_EM": "EEM", "US10Y": "^TNX", "US2Y": "^IRX", "DXY": "DX-Y.NYB", "USDINR": "INR=X", "EURINR": "EURINR=X", "GBPINR": "GBPINR=X", "JPYINR": "JPYINR=X",
    "GOLD": "GC=F", "SILVER": "SI=F", "CRUDE": "CL=F", "BRENT": "BZ=F", "NATGAS": "NG=F", "COPPER": "HG=F", "BITCOIN": "BTC-USD", "ETHEREUM": "ETH-USD",
}
# Anything else the team asked for (the app's request_data tool -> the daily job writes data/requests.json): {KEY: {"yahoo": ticker, "name": ..., "market": "global"|"india"}}
_REQ_FILE = Path(__file__).resolve().parents[1] / "data" / "requests.json"
REQUESTED = {k.upper(): v for k, v in (json.loads(_REQ_FILE.read_text()).get("prices", {}) if _REQ_FILE.exists() else {}).items() if isinstance(v, dict) and v.get("yahoo")}
ALTERNATES = {
    "NIFTYFMCG": ["NIFTY_FMCG.NS"], "NIFTYAUTO": ["NIFTY_AUTO.NS"], "NIFTYMETAL": ["NIFTY_METAL.NS"],
    "NIFTYREALTY": ["NIFTY_REALTY.NS"], "NIFTYENERGY": ["NIFTY_ENERGY.NS"], "NIFTYPSUBANK": ["NIFTY_PSU_BANK.NS"],
    "NIFTYMEDIA": ["NIFTY_MEDIA.NS"], "NIFTYINFRA": ["NIFTY_INFRA.NS"], "NIFTYFIN": ["NIFTY_FIN_SERVICE.NS", "^CNXFIN"],
    **EXTRA_INDICES,
    **{k: [v] for k, v in GLOBAL.items()},
    **{k: [v["yahoo"]] for k, v in REQUESTED.items()},
}


# --------------------------------------------------------------------------- constituent lists
def nse_csv(path: str) -> list[dict] | None:
    for host in HOSTS:
        try:
            r = requests.get(host + path, headers=UA, timeout=30)
            if r.status_code == 200 and len(r.text) > 200:
                return list(csv.DictReader(io.StringIO(r.text)))
        except Exception as e:
            print(f"  {host}{path}: {e}")
    return None


def clean_row(d: dict) -> dict:
    return {k.strip(): (v or "").strip() for k, v in d.items() if k}


def load_universe() -> dict:
    old = json.loads(UNIVERSE_FILE.read_text()) if UNIVERSE_FILE.exists() else {}
    stocks: dict[str, dict] = {}
    n50 = nse_csv("/content/indices/ind_nifty50list.csv")
    n200 = nse_csv("/content/indices/ind_nifty200list.csv")
    n500 = nse_csv("/content/indices/ind_nifty500list.csv")
    fno = nse_csv("/content/fo/fo_mktlots.csv")
    got = {"nifty50": n50 is not None, "nifty200": n200 is not None, "nifty500": n500 is not None, "fno": fno is not None}
    print("NSE lists fetched:", got)
    for row in map(clean_row, n500 or []):
        s = row.get("Symbol")
        if s:
            stocks.setdefault(s, {})
            stocks[s].update({"name": row.get("Company Name", ""), "industry": row.get("Industry", ""), "nifty500": True})
    for row in map(clean_row, n200 or []):
        s = row.get("Symbol")
        if s:
            stocks.setdefault(s, {})
            stocks[s].update({"name": row.get("Company Name", ""), "industry": row.get("Industry", ""), "nifty200": True})
    for row in map(clean_row, n50 or []):
        s = row.get("Symbol")
        if s:
            stocks.setdefault(s, {})
            stocks[s].update({"nifty50": True, "name": stocks[s].get("name") or row.get("Company Name", ""),
                              "industry": stocks[s].get("industry") or row.get("Industry", "")})
    for row in map(clean_row, fno or []):
        s = (row.get("SYMBOL") or "").strip()
        if not s or s.upper() == "SYMBOL" or s in INDEX_UNDERLYINGS or s.upper().startswith("NIFTY"):
            continue
        lots = [v for k, v in row.items() if k not in ("UNDERLYING", "SYMBOL") and v.strip().isdigit()]
        stocks.setdefault(s, {})
        stocks[s].update({"fno": True, "lot_size": int(lots[0]) if lots else None,
                          "name": stocks[s].get("name") or row.get("UNDERLYING", "")})
    # keep what NSE didn't return this time from the previous file (so a blocked download never shrinks the universe)
    for s, meta in (old.get("stocks") or {}).items():
        if s not in stocks:
            if (meta.get("nifty200") and not got["nifty200"]) or (meta.get("fno") and not got["fno"]) \
                    or (meta.get("nifty50") and not got["nifty50"]) or (meta.get("nifty500") and not got["nifty500"]):
                stocks[s] = meta
        else:
            for k, v in meta.items():
                stocks[s].setdefault(k, v)
    if not stocks:  # first run and NSE unreachable: fall back to the built-in Nifty 50
        stocks = {s: {"nifty50": True, "nifty200": True} for s in NIFTY50}
    for s in NIFTY50:
        if s not in stocks and not got["nifty50"]:
            stocks[s] = {"nifty50": True}
    for meta in stocks.values():
        for k in ("nifty50", "nifty200", "nifty500", "fno"):
            meta.setdefault(k, False)
        if meta["nifty200"] or meta["nifty50"]:
            meta["nifty500"] = True
    return {"generated": date.today().isoformat(), "lists_fetched": got, "stocks": dict(sorted(stocks.items()))}


# --------------------------------------------------------------------------- prices
def yahoo_history(ticker: str, start: str) -> pd.DataFrame:
    last = None
    for attempt in range(4):
        try:
            t = yf.Ticker(ticker)
            df = t.history(start=start, auto_adjust=True, actions=False)
            if df is not None and not df.empty:
                df = df.rename(columns=str.lower)[["open", "high", "low", "close", "volume"]]
                idx = df.index.tz_localize(None) if df.index.tz is not None else df.index
                df.index = pd.DatetimeIndex(idx).normalize()
                df.index.name = "date"
                df = df[~df.index.duplicated(keep="last")].dropna(subset=["close"])
                try:
                    meta = t.history_metadata
                except Exception:
                    meta = None
                df = drop_unfinished(df, meta)  # a run during market hours must not store a half-day bar
                if df.empty:
                    last = "only an unfinished session"
                    break
                return df[df["close"] > 0].round(2)
            last = "empty"
        except Exception as e:
            last = str(e)
        time.sleep(2 * (attempt + 1))
    raise RuntimeError(f"{ticker}: {last}")


def batch_rescue(syms: list[str]) -> list[str]:
    """append recent bars for symbols whose single download failed, using yf.download in chunks"""
    done = []
    tick = {}
    for s in syms:
        t = ALTERNATES[s][0] if (s in EXTRA_INDICES or s in GLOBAL or s in REQUESTED) else to_yahoo(s)
        tick[t] = s
    items = list(tick.items())
    now_utc = datetime.now(timezone.utc)
    for k in range(0, len(items), 40):
        chunk = dict(items[k:k + 40])
        try:
            raw = yf.download(list(chunk), period="1mo", interval="1d", group_by="ticker", auto_adjust=True, threads=False, progress=False)
        except Exception as e:  # noqa: BLE001
            print(f"  batch download failed: {e}")
            time.sleep(5)
            continue
        for t, s in chunk.items():
            try:
                df = (raw[t] if len(chunk) > 1 else raw).rename(columns=str.lower)[["open", "high", "low", "close", "volume"]].dropna(subset=["close"])
                idx = df.index.tz_localize(None) if df.index.tz is not None else df.index
                df.index = pd.DatetimeIndex(idx).normalize()
                if s not in GLOBAL and s not in REQUESTED and (now_utc.hour < 10 or (now_utc.hour == 10 and now_utc.minute < 15)):
                    df = df[df.index.date < now_utc.date()]  # no half-day bar for Indian symbols before the close
                path = OUT / f"{s}.csv"
                old = pd.read_csv(path, index_col=0, parse_dates=True)
                ov = old.index.intersection(df.index)
                if len(ov) < 3 or (df.loc[ov, "close"] / old.loc[ov, "close"] - 1).abs().max() > 0.005:
                    continue
                new = pd.concat([old[old.index < df.index[0]], df[df["close"] > 0].round(2)])
                new = new[~new.index.duplicated(keep="last")]
                new.to_csv(path)
                done.append(s)
            except Exception:  # noqa: BLE001
                continue
        time.sleep(2)
    return done


def update_symbol(sym: str, start15: str, full: bool) -> dict:
    path = OUT / f"{sym}.csv"
    tickers = ALTERNATES[sym] if (sym in EXTRA_INDICES or sym in GLOBAL or sym in REQUESTED) else [to_yahoo(sym)] + [t for t in ALTERNATES.get(sym, []) if t != to_yahoo(sym)]
    old = pd.read_csv(path, index_col=0, parse_dates=True) if path.exists() and not full else None
    if old is not None and len(old) > 200:
        recent_start = (old.index[-1] - pd.Timedelta(days=12)).date().isoformat()
        try:
            new = yahoo_history(tickers[0], recent_start)
            overlap = old.index.intersection(new.index)
            drift = (new.loc[overlap, "close"] / old.loc[overlap, "close"] - 1).abs().max() if len(overlap) else 1
            if len(overlap) >= 3 and drift < 0.005:
                df = pd.concat([old[old.index < new.index[0]], new])
                df.to_csv(path)
                return {"symbol": sym, "rows": len(df), "mode": "incremental", "ticker": tickers[0]}
        except Exception:
            pass  # fall through to a full download
    best, used = None, None
    for t in tickers:
        try:
            df = yahoo_history(t, start15)
        except Exception:
            continue
        if best is None or len(df) > len(best):
            best, used = df, t
        if len(best) > 200:
            break
    if best is None:
        raise RuntimeError("no data")
    best.to_csv(path)
    return {"symbol": sym, "rows": len(best), "mode": "full", "ticker": used}


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--years", type=int, default=15)
    ap.add_argument("--full", action="store_true")
    ap.add_argument("--only", default="")
    args = ap.parse_args()
    OUT.mkdir(parents=True, exist_ok=True)
    universe = load_universe()
    UNIVERSE_FILE.write_text(json.dumps(universe, indent=1))
    stocks = list(universe["stocks"])
    print(f"Universe: {len(stocks)} stocks ({sum(m['nifty200'] for m in universe['stocks'].values())} Nifty 200, "
          f"{sum(m['fno'] for m in universe['stocks'].values())} F&O)")
    symbols = list(dict.fromkeys(INDICES + ["INDIAVIX"] + SECTORS + list(EXTRA_INDICES) + list(GLOBAL) + stocks + list(REQUESTED)))
    if args.only:
        symbols = [s.strip().upper() for s in args.only.split(",") if s.strip()]
    start15 = (date.today() - timedelta(days=int(args.years * 365.25) + 5)).isoformat()
    manifest_path = ROOT / "data" / "manifest.json"
    manifest = json.loads(manifest_path.read_text()) if manifest_path.exists() else {"symbols": {}}
    failed = {}

    def job(sym):
        try:
            return update_symbol(sym, start15, args.full)
        except Exception as e:
            return {"symbol": sym, "error": str(e)[:200]}

    with ThreadPoolExecutor(max_workers=6) as pool:
        for r in pool.map(job, symbols):
            s = r["symbol"]
            if "error" in r:
                failed[s] = r["error"]
                print(f"FAIL {s:<14} {r['error']}")
                continue
            df = pd.read_csv(OUT / f"{s}.csv", index_col=0, parse_dates=True)
            manifest["symbols"][s] = {"yahoo": r["ticker"], "rows": len(df), "first": str(df.index[0].date()),
                                      "last": str(df.index[-1].date())}
            print(f"OK   {s:<14} {len(df):>5} rows ({r['mode']})")
    # second chance for failures: one batched Yahoo download (fewer requests; per-ticker calls get rate-limited)
    if failed:
        rescued = batch_rescue([s for s in failed if (OUT / f"{s}.csv").exists()])
        for s in rescued:
            failed.pop(s, None)
            df = pd.read_csv(OUT / f"{s}.csv", index_col=0, parse_dates=True)
            manifest["symbols"][s] = {**manifest["symbols"].get(s, {}), "rows": len(df), "first": str(df.index[0].date()), "last": str(df.index[-1].date())}
        print(f"batch rescue: {len(rescued)} symbols updated")
    (ROOT / "data" / "_fetch_report.json").write_text(json.dumps({"at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"), "symbols": len(symbols),
        "failed": len(failed), "errors": dict(list(failed.items())[:60])}, indent=1))
    # fetched_at (UTC) tells the daily job whether this run happened after the Indian close (>= 10:20 UTC = 15:50 IST);
    # "generated" alone can't, since a run at noon has today's date too
    manifest.update({"generated": date.today().isoformat(), "fetched_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
                     "start": start15, "adjusted": True,
                     "source": "Yahoo Finance", "failed": failed})
    manifest_path.write_text(json.dumps(manifest, indent=1))
    ok = len(symbols) - len(failed)
    print(f"\n{ok} ok, {len(failed)} failed")
    if ok < len(symbols) * 0.6:
        sys.exit("Too many failures")


if __name__ == "__main__":
    main()
