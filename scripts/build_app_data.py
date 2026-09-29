"""Build the TradeOS app's data files from data/prices/*.csv and data/universe.json.

Output (in <out>/data):
  p/<SYMBOL>.json  full daily OHLCV, compact integer encoding (format 2)
  closes.json      every symbol's closes on one calendar + equal-weight sector baskets (for
                   rotation, options, benchmarks and quick lookups without loading OHLCV)
  manifest.json    symbols (name, industry, index membership, F&O lot size, date range),
                   named universes and sector definitions

Usage:  python scripts/build_app_data.py <out_dir>
"""
from __future__ import annotations

import json
import re
import sys
from pathlib import Path

import numpy as np
import pandas as pd

ROOT = Path(__file__).resolve().parents[1]
MIN_ROWS = 200
SECTOR_SHORT = {
    "Financial Services": ("SEC_FIN", "Financial services"), "Capital Goods": ("SEC_CAPGOODS", "Capital goods"),
    "Healthcare": ("SEC_HEALTH", "Healthcare & pharma"), "Automobile and Auto Components": ("SEC_AUTO", "Auto"),
    "Fast Moving Consumer Goods": ("SEC_FMCG", "FMCG"), "Information Technology": ("SEC_IT", "IT"),
    "Consumer Services": ("SEC_CONSSVC", "Consumer services"), "Metals & Mining": ("SEC_METAL", "Metals & mining"),
    "Oil Gas & Consumable Fuels": ("SEC_ENERGY", "Oil, gas & energy"), "Power": ("SEC_POWER", "Power"),
    "Consumer Durables": ("SEC_CONSDUR", "Consumer durables"), "Chemicals": ("SEC_CHEM", "Chemicals"),
    "Realty": ("SEC_REALTY", "Realty"), "Construction Materials": ("SEC_CEMENT", "Cement & materials"),
    "Telecommunication": ("SEC_TELECOM", "Telecom"), "Services": ("SEC_SERVICES", "Services"),
}
INDEX_NAMES = {"NIFTY": "Nifty 50", "BANKNIFTY": "Nifty Bank", "SENSEX": "BSE Sensex", "INDIAVIX": "India VIX",
               "NIFTYIT": "Nifty IT", "NIFTYPHARMA": "Nifty Pharma", "NIFTYBANK": "Nifty Bank index", "NIFTYFIN": "Nifty Financial Services"}


def enc_full(df: pd.DataFrame) -> dict:
    days = df.index.values.astype("datetime64[D]").astype("int64")
    c = np.round(df["close"].values * 100).astype("int64")
    rel = lambda col: (np.round(df[col].values * 100).astype("int64") - c).tolist()  # noqa: E731
    return {"f": 2, "d0": int(days[0]), "dd": np.diff(days, prepend=days[0]).tolist(),
            "c0": int(c[0]), "c": np.diff(c, prepend=c[0]).tolist(),
            "o": rel("open"), "h": rel("high"), "l": rel("low"),
            "v": df["volume"].fillna(0).astype("int64").tolist()}


def main(out: Path) -> None:
    src, dst = ROOT / "data" / "prices", out / "data"
    (dst / "p").mkdir(parents=True, exist_ok=True)
    uni = json.loads((ROOT / "data" / "universe.json").read_text())["stocks"]
    fetched = json.loads((ROOT / "data" / "manifest.json").read_text())
    frames, symbols = {}, {}
    for f in sorted(src.glob("*.csv")):
        df = pd.read_csv(f, index_col=0, parse_dates=True).dropna(subset=["close"])
        df = df[~df.index.duplicated(keep="last")].sort_index()
        if len(df) < MIN_ROWS:
            continue
        s = f.stem
        frames[s] = df
        (dst / "p" / f"{s}.json").write_text(json.dumps(enc_full(df), separators=(",", ":")))
        meta = uni.get(s, {})
        symbols[s] = {"first": str(df.index[0].date()), "last": str(df.index[-1].date()), "rows": len(df),
                      "name": meta.get("name") or INDEX_NAMES.get(s, s), "industry": meta.get("industry") or ("Index" if s in INDEX_NAMES else ""),
                      "n50": bool(meta.get("nifty50")), "n200": bool(meta.get("nifty200")), "fno": bool(meta.get("fno")),
                      "lot": meta.get("lot_size"), "kind": "index" if s in INDEX_NAMES else "stock"}
    # calendar = union of all trading days
    cal = sorted(set().union(*[set(df.index) for df in frames.values()]))
    cal_idx = pd.DatetimeIndex(cal)
    closes = pd.DataFrame({s: df["close"] for s, df in frames.items()}).reindex(cal_idx)
    # equal-weight sector baskets from today's Nifty 200 members (daily rebalanced, base 1000)
    sectors = {}
    for industry, (code, label) in SECTOR_SHORT.items():
        members = [s for s, m in symbols.items() if m["n200"] and m["industry"] == industry]
        if len(members) < 3:
            continue
        rets = closes[members].pct_change(fill_method=None)
        avail = closes[members].notna().sum(axis=1)
        r = rets.mean(axis=1, skipna=True).where(avail >= 3)
        first = r.first_valid_index()
        if first is None:
            continue
        r = r.loc[first:].fillna(0.0)
        level = 1000 * (1 + r).cumprod()
        closes[code] = level.round(2)
        sectors[code] = {"label": label, "industry": industry, "members": members}
        symbols[code] = {"first": str(level.index[0].date()), "last": str(level.index[-1].date()), "rows": int(level.notna().sum()),
                         "name": f"{label} basket", "industry": industry, "n50": False, "n200": False, "fno": False, "lot": None,
                         "kind": "basket"}
    days = cal_idx.values.astype("datetime64[D]").astype("int64")
    pack = {"f": 2, "d0": int(days[0]), "dd": np.diff(days, prepend=days[0]).tolist(), "s": {}}
    for s in closes.columns:
        col = closes[s]
        fv = col.first_valid_index()
        if fv is None:
            continue
        i0 = int(cal_idx.get_loc(fv))
        v = np.round(col.iloc[i0:].ffill().values * 100).astype("int64")
        pack["s"][s] = {"i0": i0, "c0": int(v[0]), "c": np.diff(v, prepend=v[0]).tolist()}
    (dst / "closes.json").write_text(json.dumps(pack, separators=(",", ":")))

    def members(pred):
        return sorted(s for s, m in symbols.items() if m["kind"] == "stock" and pred(m))
    industries = {}
    for code, sec in sectors.items():
        industries[code[4:].lower()] = sec["members"]  # fin, auto, fmcg, metal, energy, ...
    universes = {
        "nifty50": members(lambda m: m["n50"]), "nifty200": members(lambda m: m["n200"]),
        "fno": members(lambda m: m["fno"]), "all": members(lambda m: True),
        "sectors": sorted(sectors), "indices": [s for s in ["NIFTY", "BANKNIFTY", "SENSEX", "NIFTYIT", "NIFTYPHARMA", "NIFTYFIN"] if s in symbols],
        "banks": [s for s in ["HDFCBANK", "ICICIBANK", "SBIN", "AXISBANK", "KOTAKBANK", "INDUSINDBK", "BANKBARODA", "PNB", "CANBK", "FEDERALBNK", "IDFCFIRSTB", "AUBANK", "UNIONBANK", "BANKINDIA", "INDIANB"] if s in symbols],
        **industries,
    }
    manifest = {"generated": fetched.get("generated"), "source": "Yahoo Finance (split & dividend adjusted); lists from NSE",
                "symbols": symbols, "universes": universes, "sectors": sectors}
    (dst / "manifest.json").write_text(json.dumps(manifest, separators=(",", ":")))
    size = sum(p.stat().st_size for p in dst.rglob("*.json"))
    print(f"{len(frames)} symbols, {len(sectors)} sector baskets, {len(universes)} universes, {size / 1e6:.1f} MB -> {dst}")


if __name__ == "__main__":
    main(Path(sys.argv[1]))
