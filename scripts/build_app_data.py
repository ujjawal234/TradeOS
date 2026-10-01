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

import gzip
import json
import shutil
import re
import sys
from pathlib import Path

import numpy as np
import pandas as pd

ROOT = Path(__file__).resolve().parents[1]
MIN_ROWS = 60          # stocks: include recent listings (e.g. new F&O entrants)
MIN_ROWS_INDEX = 200
IDX_DIR = ROOT / "data" / "indices"
# F&O index keys taken from NSE's official series (Yahoo is the fallback)
PRIMARY = {"NIFTY_50": "NIFTY", "NIFTY_BANK": "BANKNIFTY", "NIFTY_FINANCIAL_SERVICES": "FINNIFTY",
           "NIFTY_MIDCAP_SELECT": "MIDCPNIFTY", "NIFTY_NEXT_50": "NIFTYNXT50", "INDIA_VIX": "INDIAVIX"}
# Yahoo copies (verified identical to NSE) extend history before NSE's archive starts (Feb 2012; VIX May 2014)
YAHOO_BACKFILL = {"NIFTY": "NIFTY", "BANKNIFTY": "BANKNIFTY", "NIFTY_IT": "NIFTYIT", "NIFTY_PHARMA": "NIFTYPHARMA", "NIFTYNXT50": "NIFTYNEXT50",
                  "INDIAVIX": "INDIAVIX", "NIFTY_100": "NIFTY100", "NIFTY_200": "NIFTY200", "NIFTY_500": "NIFTY500", "NIFTY_MIDCAP_50": "NIFTYMIDCAP50"}
# every NSE series is kept except superseded copies and non-price series; debt (G-Sec, bond, overnight rate) and
# derived (leveraged, inverse, futures, arbitrage, USD) series are tagged so they can serve as cash, defensive
# assets, benchmarks or rotation universes of their own.
SKIP = re.compile(r" - OLD$|DIVIDEND POINTS", re.I)
DEBT = re.compile(r"G-?SEC|GILT|BHARAT BOND|\bBOND\b|\bSDL\b|T-?BILL|1D RATE|MONEY MARKET|CRISIL|\bAAA\b|CORPORATE BOND|DEBT", re.I)
DERIVED = re.compile(r"INVERSE|LEVERAGE|FUTURES|ARBITRAGE|\bUSD\b", re.I)
# NSE renamed its indices (S&P CNX -> CNX -> NIFTY, ~2015); these chains are stitched into one history.
RENAMES = {
    "Nifty 50": ["S&P CNX Nifty", "CNX Nifty"], "Nifty Next 50": ["CNX Nifty Junior"], "Nifty 100": ["CNX 100"], "Nifty 200": ["CNX 200"],
    "Nifty 500": ["S&P CNX 500", "CNX 500"], "Nifty Midcap 100": ["CNX Midcap", "Nifty Free Float Midcap 100", "Nifty Full Midcap 100"],
    "Nifty Smallcap 100": ["CNX Smallcap", "Nifty Free Float Smallcap 100", "Nifty Full Smallcap 100"], "Nifty Auto": ["CNX Auto"], "Nifty Bank": ["CNX Bank"],
    "Nifty Financial Services": ["CNX Finance"], "Nifty FMCG": ["CNX FMCG"], "Nifty IT": ["CNX IT"], "Nifty Media": ["CNX Media"], "Nifty Metal": ["CNX Metal"],
    "Nifty Pharma": ["CNX Pharma"], "Nifty PSU Bank": ["CNX PSU Bank"], "Nifty Realty": ["CNX Realty"], "Nifty Energy": ["CNX Energy"],
    "Nifty Infrastructure": ["CNX Infrastructure"], "Nifty Commodities": ["CNX Commodities"], "Nifty India Consumption": ["CNX Consumption"],
    "Nifty MNC": ["CNX MNC"], "Nifty PSE": ["CNX PSE"], "Nifty Services Sector": ["CNX Service Sector"], "Nifty CPSE": ["CPSE"],
    "Nifty Dividend Opportunities 50": ["CNX Dividend Opportunities"], "Nifty High Beta 50": ["CNX High Beta"], "Nifty Low Volatility 50": ["CNX Low Volatility"],
    "Nifty Alpha 50": ["CNX Alpha Index"], "Nifty100 Equal Weight": ["CNX 100 Equal Weight"], "Nifty100 Liquid 15": ["LIX 15", "NI15"],
    "Nifty Midcap Liquid 15": ["LIX15 Midcap"], "Nifty50 Value 20": ["NV 20"], "Nifty Quality 30": ["NSE Quality 30"], "Nifty Shariah 25": ["CNX Shariah25"],
    "Nifty50 Shariah": ["S&P CNX Nifty Shariah", "CNX Nifty Shariah"], "Nifty500 Shariah": ["S&P CNX 500 Shariah", "CNX 500 Shariah"],
}
SECTOR_RX = re.compile(r"^NIFTY (AUTO|BANK|FINANCIAL SERVICES|FMCG|IT|MEDIA|METAL|PHARMA|PSU BANK|PRIVATE BANK|REALTY|HEALTHCARE( INDEX)?|CONSUMER DURABLES|OIL (&|AND) GAS|CHEMICALS|ENERGY|INFRASTRUCTURE|CAPITAL GOODS|CEMENT|POWER|TELECOMMUNICATIONS)$", re.I)
FACTOR_RX = re.compile(r"ALPHA|LOW VOLATILITY|LOW VOL|QUALITY|VALUE|MOMENTUM|EQUAL WEIGHT|DIVIDEND|GROWTH|HIGH BETA|LIQUID 15|QUANT", re.I)
BROAD_RX = re.compile(r"^NIFTY ?(50|NEXT 50|NEXT 100|100|200|500|MIDCAP|SMALLCAP|SMLCAP|MICROCAP|LARGEMIDCAP|LARGE MIDCAP|MIDSMALLCAP|MIDSMALL ?CAP|TOTAL MARKET|MIDCAP SELECT|MID ?CAP|SMALL ?CAP)( ?\d+)?( INDEX)?$", re.I)
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
GLOBAL_NAMES = {"SPX": "S&P 500 (US)", "NASDAQ": "Nasdaq Composite (US)", "DOWJONES": "Dow Jones (US)", "RUSSELL2000": "Russell 2000 (US)",
    "USVIX": "CBOE VIX (US volatility)", "NIKKEI": "Nikkei 225 (Japan)", "HANGSENG": "Hang Seng (Hong Kong)", "SHANGHAI": "Shanghai Composite (China)",
    "KOSPI": "KOSPI (Korea)", "TAIWAN": "Taiwan Weighted", "FTSE100": "FTSE 100 (UK)", "DAX": "DAX (Germany)", "CAC40": "CAC 40 (France)",
    "EUROSTOXX50": "Euro Stoxx 50", "MSCI_EM": "MSCI Emerging Markets ETF (EEM, USD)", "US10Y": "US 10-year Treasury yield (%)", "US2Y": "US 13-week T-bill yield (%)",
    "DXY": "US Dollar Index", "USDINR": "USD/INR", "EURINR": "EUR/INR", "GBPINR": "GBP/INR", "JPYINR": "JPY/INR", "GOLD": "Gold (USD/oz, COMEX)",
    "SILVER": "Silver (USD/oz, COMEX)", "CRUDE": "WTI crude oil (USD/bbl)", "BRENT": "Brent crude (USD/bbl)", "NATGAS": "Natural gas (USD, NYMEX)",
    "COPPER": "Copper (USD/lb, COMEX)", "BITCOIN": "Bitcoin (USD)", "ETHEREUM": "Ether (USD)"}
INDEX_NAMES = {"NIFTY": "Nifty 50", "BANKNIFTY": "Nifty Bank", "SENSEX": "BSE Sensex", "INDIAVIX": "India VIX",
               "NIFTYIT": "Nifty IT", "NIFTYPHARMA": "Nifty Pharma", "NIFTYBANK": "Nifty Bank index", "NIFTYFIN": "Nifty Financial Services",
               "NIFTYFMCG": "Nifty FMCG", "NIFTYAUTO": "Nifty Auto", "NIFTYMETAL": "Nifty Metal", "NIFTYREALTY": "Nifty Realty",
               "NIFTYENERGY": "Nifty Energy", "NIFTYPSUBANK": "Nifty PSU Bank", "NIFTYMEDIA": "Nifty Media", "NIFTYINFRA": "Nifty Infrastructure",
               "NIFTYNEXT50": "Nifty Next 50", "NIFTY100": "Nifty 100", "NIFTY200": "Nifty 200", "NIFTY500": "Nifty 500",
               "NIFTYMIDCAP50": "Nifty Midcap 50", "NIFTYMIDCAP100": "Nifty Midcap 100", "NIFTYMIDSELECT": "Nifty Midcap Select",
               "NIFTYSMALLCAP100": "Nifty Smallcap 100", "NIFTYPSE": "Nifty PSE", "NIFTYMNC": "Nifty MNC", "NIFTYCONSUMPTION": "Nifty India Consumption",
               "NIFTYCOMMODITIES": "Nifty Commodities", "NIFTYSERVICES": "Nifty Services Sector", "NIFTYPVTBANK": "Nifty Private Bank",
               "NIFTYHEALTHCARE": "Nifty Healthcare", "NIFTYOILGAS": "Nifty Oil & Gas", "NIFTYCONSDURABLES": "Nifty Consumer Durables",
               "NIFTYCPSE": "Nifty CPSE", "NIFTYDIVOPPS50": "Nifty Dividend Opportunities 50", "BANKEX": "BSE Bankex", "BSE100": "BSE 100",
               "BSE500": "BSE 500", "BSEMIDCAP": "BSE Midcap", "BSESMALLCAP": "BSE Smallcap"}


def code_of(name: str) -> str:
    return re.sub(r"_+", "_", re.sub(r"[^A-Z0-9]+", "_", name.upper())).strip("_")


def stitch(target: pd.DataFrame, olds: list[pd.DataFrame], label: str) -> pd.DataFrame:
    """Fill dates missing from `target` (before its start or holes inside it) with renamed predecessors,
    but only where the predecessor's level joins the target at every edge (1% on overlap, 5% across <=5 days)."""
    out = target
    for old in sorted(olds, key=lambda d: d.index[-1], reverse=True):
        block = old[~old.index.isin(out.index)]
        if block.empty:
            continue
        common = old.index.intersection(out.index)
        ok, why = True, ""
        if len(common):
            r = out.loc[common, "close"] / old.loc[common, "close"]
            ok, why = bool((r - 1).abs().max() <= 0.01), f"overlap ratio {r.iloc[0]:.3f}"
        for edge_date, side in ((block.index[0], "prev"), (block.index[-1], "next")):
            nb = out[out.index < edge_date] if side == "prev" else out[out.index > edge_date]
            if nb.empty:
                continue
            nd = nb.index[-1] if side == "prev" else nb.index[0]
            if abs((nd - edge_date).days) > 5:
                continue  # not adjacent; nothing to compare at this edge
            ratio = nb.loc[nd, "close"] / block.loc[edge_date, "close"]
            if abs(ratio - 1) > 0.05:
                ok, why = False, f"{side} edge ratio {ratio:.3f}"
        if not ok:
            print(f"  not stitched: {label} <- predecessor ending {old.index[-1].date()} ({why})")
            continue
        out = pd.concat([out, block]).sort_index()
    return out


def val_arr(df: pd.DataFrame, col: str):
    if col not in df or df[col].notna().sum() < 50:
        return None
    return [None if pd.isna(x) else round(float(x), 2) for x in df[col].values]


def enc_full(df: pd.DataFrame) -> dict:
    days = df.index.values.astype("datetime64[D]").astype("int64")
    c = np.round(df["close"].values * 100).astype("int64")
    rel = lambda col: (np.round(df[col].values * 100).astype("int64") - c).tolist()  # noqa: E731
    return {"f": 2, "d0": int(days[0]), "dd": np.diff(days, prepend=days[0]).tolist(),
            "c0": int(c[0]), "c": np.diff(c, prepend=c[0]).tolist(),
            "o": rel("open"), "h": rel("high"), "l": rel("low"),
            "v": df["volume"].fillna(0).astype("int64").tolist(),
            **{k: a for k in ("pe", "pb", "dy") if (a := val_arr(df, k)) is not None}}


PIT_DIR = ROOT / "data" / "pit"


def packed(obj) -> str:
    """large data files: gzip, then base64 inside a small JSON wrapper (artifacts serve .json but not .gz); the page unpacks
    it with DecompressionStream. ~3x smaller than plain JSON."""
    import base64
    return json.dumps({"b64gz": base64.b64encode(gzip.compress(json.dumps(obj, separators=(",", ":")).encode(), 9)).decode()})


def consensus_fix(nse: pd.DataFrame, yahoo: pd.Series | None, sym: str, repairs: list) -> pd.DataFrame:
    """NSE's corporate-action records occasionally miss an event (e.g. a bonus with no record that day), leaving a fake
    jump. Where Yahoo's adjusted series exists, a one-day NSE move of 10%+ that Yahoo doesn't show — checked over a
    5-day window so a one-day date offset in Yahoo's data doesn't count — is treated as a missed adjustment and the NSE
    history before it is rescaled. NSE is kept where Yahoo has the jump (Yahoo's own demerger/bonus errors)."""
    if yahoo is None or len(yahoo) < 50 or len(nse) < 50:
        return nse
    c = nse["close"]
    r = np.log(c).diff()
    y = yahoo.reindex(c.index).ffill()
    for t in r.index[(r.abs() > 0.1).to_numpy()][::-1]:  # latest first, so each fix sees already-fixed later data
        i = c.index.get_loc(t)
        a, b = max(0, i - 3), min(len(c) - 1, i + 2)
        if not (y.iloc[a] == y.iloc[a] and y.iloc[b] == y.iloc[b] and y.iloc[i - 1] == y.iloc[i - 1] and y.iloc[i] == y.iloc[i]):
            continue
        cc = nse["close"]
        wn, wy = np.log(cc.iloc[b] / cc.iloc[a]), np.log(y.iloc[b] / y.iloc[a])
        ry = np.log(y.iloc[i] / y.iloc[i - 1])
        rn = np.log(cc.iloc[i] / cc.iloc[i - 1])
        if abs(ry) < 0.04 and abs(wn - wy) > 0.1 and abs(rn - ry) > 0.1:
            k = float(np.exp(rn - ry))
            before = nse.index < t
            for col in ("open", "high", "low", "close"):
                nse.loc[before, col] = nse.loc[before, col] * k
            if "volume" in nse:
                nse.loc[before, "volume"] = nse.loc[before, "volume"] / k
            repairs.append([sym, str(t.date()), round(k, 4)])
    return nse


PIT_FRAMES: dict = {}  # NSE bhavcopy series (after consensus_fix), reused as the app's main stock prices
PIT_REPAIRS: list = []


def load_pit_frames() -> tuple[dict, list]:
    """NSE bhavcopy OHLCV per stock (scripts/fetch_bhavcopy.py), cross-checked against Yahoo (consensus_fix); cached"""
    if PIT_FRAMES:
        return PIT_FRAMES, PIT_REPAIRS
    pdir = PIT_DIR / "prices"
    if not pdir.exists():
        return {}, []
    frames, repairs = PIT_FRAMES, PIT_REPAIRS
    for f in sorted(pdir.glob("*.csv")):
        df = pd.read_csv(f, index_col=0, parse_dates=True).dropna(subset=["close"])
        df = df[(df["close"] > 0) & ~df.index.duplicated(keep="last")].sort_index()
        if len(df) < 20:
            continue
        yf = ROOT / "data" / "prices" / f"{f.stem}.csv"
        if yf.exists():
            y = pd.read_csv(yf, index_col=0, parse_dates=True)["close"].dropna()
            df = consensus_fix(df, y[~y.index.duplicated(keep="last")].sort_index(), f.stem, repairs)
        for col in ("open", "high", "low"):
            df[col] = df[col].fillna(df["close"])
        df["volume"] = df["volume"].fillna(0)
        frames[f.stem] = df
    return frames, repairs




def build_pit(dst: Path, universes: dict) -> dict | None:
    """Survivorship-free universes (scripts/fetch_bhavcopy.py): data/pit/{closes.json, membership.json, p/<SYM>.json}.
    Their prices come from NSE bhavcopy and live apart from the Yahoo series, so a point-in-time backtest uses one
    consistent source for every stock in it (including ones that later fell out or were delisted)."""
    mem_file, pdir = PIT_DIR / "membership.json", PIT_DIR / "prices"
    if not mem_file.exists() or not pdir.exists():
        return None
    mem = json.loads(mem_file.read_text())
    out = dst / "pit"
    (out / "full").mkdir(parents=True, exist_ok=True)
    frames, repairs = load_pit_frames()
    cal = pd.DatetimeIndex(sorted(set().union(*[set(df.index) for df in frames.values()])))
    days = cal.values.astype("datetime64[D]").astype("int64")
    pack = {"f": 2, "d0": int(days[0]), "dd": np.diff(days, prepend=days[0]).tolist(), "s": {}}
    for sym, df in frames.items():
        col = df["close"].reindex(cal)
        i0, i1 = int(cal.get_loc(df.index[0])), int(cal.get_loc(df.index[-1]))
        v = np.round(col.iloc[i0:i1 + 1].ffill().values * 100).astype("int64")
        pack["s"][sym] = {"i0": i0, "c0": int(v[0]), "c": np.diff(v, prepend=v[0]).tolist()}
    (out / "closes.json").write_text(packed(pack))
    # full OHLCV in gzip bundles of 25 stocks (an artifact version holds at most ~500 files and 256 MB)
    bundles, names = {}, sorted(frames)
    for i in range(0, len(names), 25):
        key = f"b{i // 25:02d}"
        (out / "full" / f"{key}.json").write_text(packed({s: enc_full(frames[s]) for s in names[i:i + 25]}))
        bundles.update({s: key for s in names[i:i + 25]})
    unis = {k: [[d, [s for s in syms if s in frames]] for d, syms in v] for k, v in mem["universes"].items()}
    (out / "membership.json").write_text(json.dumps({"asof": mem.get("asof"), "universes": unis, "bundles": bundles}, separators=(",", ":")))
    info = {"asof": mem.get("asof"), "method": mem.get("method", ""), "symbols": len(frames), "universes": {}}
    for k, v in unis.items():
        universes[k] = sorted({s for _, syms in v for s in syms})
        info["universes"][k] = {"reviews": len(v), "first": v[0][0] if v else None, "size": len(v[-1][1]) if v else 0,
                                "ever": len(universes[k]), "latest": v[-1][1] if v else []}
    gone = sum(1 for df in frames.values() if df.index[-1] < cal[-1] - pd.Timedelta(days=10))
    info["no_longer_trading"] = gone
    info["repairs"] = repairs
    print(f"pit: {len(frames)} stocks ({gone} no longer trading), universes {', '.join(f'{k}={len(universes[k])}' for k in unis)}")
    return info


def extra_series() -> dict:
    """{KEY: (series, description, group)} from data/flows (NSE participant-wise OI, FII/DII cash) and data/pit/breadth.csv"""
    out = {}
    f = ROOT / "data" / "flows" / "participant_oi.csv"
    if f.exists():
        p = pd.read_csv(f, index_col=0, parse_dates=True).sort_index()
        names = {"FII": "FII/FPI", "DII": "DII", "PRO": "Proprietary traders", "CLIENT": "Clients (retail & others)"}
        for w, wn in names.items():
            def g(c):
                return p[f"{w}_{c}"] if f"{w}_{c}" in p else None
            L, Sh = g("fut_idx_long"), g("fut_idx_short")
            if L is not None and Sh is not None:
                out[f"{w}_IDXFUT_NET"] = (L - Sh, f"{wn}: index futures long minus short (contracts)", "flows")
                out[f"{w}_IDXFUT_LONG_PCT"] = (L / (L + Sh) * 100, f"{wn}: index futures longs as % of their long+short", "flows")
            L, Sh = g("fut_stk_long"), g("fut_stk_short")
            if L is not None and Sh is not None:
                out[f"{w}_STKFUT_NET"] = (L - Sh, f"{wn}: stock futures long minus short (contracts)", "flows")
            for side, lab in (("call", "calls"), ("put", "puts")):
                L, Sh = g(f"idx_{side}_long"), g(f"idx_{side}_short")
                if L is not None and Sh is not None:
                    out[f"{w}_IDX{side.upper()}_NET"] = (L - Sh, f"{wn}: index {lab} bought minus sold (open contracts)", "flows")
    f = ROOT / "data" / "flows" / "fii_dii_cash.csv"
    if f.exists():
        c = pd.read_csv(f, index_col=0, parse_dates=True).sort_index()
        for w in ("FII", "DII"):
            if f"{w}_net" in c:
                out[f"{w}_CASH_NET"] = (c[f"{w}_net"], f"{w} net buying in the cash market (₹ crore/day; history starts when collection began)", "flows")
    f = PIT_DIR / "breadth.csv"
    if f.exists():
        b = pd.read_csv(f, index_col=0, parse_dates=True).sort_index()
        n = b["n"].where(b["n"] > 0)
        out["BREADTH_ADV_PCT"] = (b["adv"] / n * 100, "% of the top-500 stocks that rose today", "breadth")
        out["BREADTH_AD_LINE"] = ((b["adv"] - b["dec"]).cumsum(), "Advance-decline line of the top-500 stocks (cumulative advances minus declines)", "breadth")
        out["BREADTH_ABOVE200"] = (b["a200"] / b["n200"].where(b["n200"] > 0) * 100, "% of the top-500 stocks above their 200-day average", "breadth")
        out["BREADTH_ABOVE50"] = (b["a50"] / b["n50"].where(b["n50"] > 0) * 100, "% of the top-500 stocks above their 50-day average", "breadth")
        out["BREADTH_NEW_HIGHS"] = (b["h52"].astype(float), "Top-500 stocks at a 52-week closing high", "breadth")
        out["BREADTH_NEW_LOWS"] = (b["l52"].astype(float), "Top-500 stocks at a 52-week closing low", "breadth")
        out["BREADTH_HL_NET"] = ((b["h52"] - b["l52"]).astype(float), "52-week highs minus lows among the top-500 stocks", "breadth")
    return out


def copy_options(dst: Path, symbols: dict) -> dict | None:
    """NSE option prices (scripts/fetch_fo.py via scripts/get_options.py) -> data/opt, and their index for the manifest"""
    src = ROOT / ".options" / "opt"
    if not (src / "index.json").exists():
        return None
    out = dst / "opt"
    if out.exists():
        shutil.rmtree(out)
    out.mkdir(parents=True)
    import base64
    for f in sorted(src.glob("*.json.gz")):  # gzip from the release -> base64 JSON wrapper the artifact can serve
        (out / f.name[:-3]).write_text(json.dumps({"b64gz": base64.b64encode(f.read_bytes()).decode()}))
    idx = json.loads((src / "index.json").read_text())
    unders = {s: {k: v for k, v in u.items() if k in ("kind", "first", "last", "lot", "c", "s")} for s, u in idx.get("underlyings", {}).items()}
    size = sum(f.stat().st_size for f in out.glob("*"))
    print(f"options: {len(unders)} underlyings to {idx.get('asof')}, {len(list(out.glob('*')))} files, {size / 1e6:.1f} MB")
    return {"asof": idx.get("asof"), "method": idx.get("method", ""), "underlyings": unders}


def main(out: Path) -> None:
    src, dst = ROOT / "data" / "prices", out / "data"
    nse_stocks, _ = load_pit_frames()
    (dst / "p").mkdir(parents=True, exist_ok=True)
    uni = json.loads((ROOT / "data" / "universe.json").read_text())["stocks"]
    fetched = json.loads((ROOT / "data" / "manifest.json").read_text())
    frames, symbols = {}, {}
    # ---- official NSE index history (every index NSE publishes), if fetched
    nse, nse_names = {}, {}
    if IDX_DIR.exists():
        names_file = IDX_DIR / "_index_names.json"
        nse_names = json.loads(names_file.read_text()) if names_file.exists() else {}
        raw = {}
        for f in sorted(IDX_DIR.glob("*.csv")):
            if f.stem.startswith("_"):
                continue
            df = pd.read_csv(f, index_col=0, parse_dates=True).dropna(subset=["close"])
            raw[f.stem] = df[~df.index.duplicated(keep="last")].sort_index()
        old_codes = {code_of(o) for olds in RENAMES.values() for o in olds}
        for new, olds in RENAMES.items():
            c = code_of(new)
            if c in raw:
                raw[c] = stitch(raw[c], [raw[code_of(o)] for o in olds if code_of(o) in raw], new)
        for code, df in raw.items():
            name = nse_names.get(code, code)
            if code in old_codes or SKIP.search(name):
                continue
            if len(df) >= MIN_ROWS_INDEX and df.index[-1] >= pd.Timestamp.today() - pd.Timedelta(days=30):
                nse[code] = df
    use_nse = len(nse) >= 20
    for code, df in nse.items():
        key = PRIMARY.get(code, code)
        yf = src / f"{YAHOO_BACKFILL.get(key, '')}.csv"
        if key in YAHOO_BACKFILL and yf.exists():
            y = pd.read_csv(yf, index_col=0, parse_dates=True).dropna(subset=["close"])
            y = y[~y.index.duplicated(keep="last")][["open", "high", "low", "close", "volume"]]
            fill = y[~y.index.isin(df.index) & (y.index <= df.index[-1])]  # earlier history + days NSE's archive missed
            if len(fill):
                df = pd.concat([df, fill]).sort_index()
        gaps = df.index.to_series().diff().dt.days
        if (gaps > 45).any():  # stray early points before a long hole in NSE's archive: keep the continuous recent history
            cut = gaps[gaps > 45].index[-1]
            print(f"  {key}: dropped {int((df.index < cut).sum())} row(s) before a {int(gaps.loc[cut])}-day gap ending {cut.date()}")
            df = df[df.index >= cut]
        for col in ("open", "high", "low"):
            df[col] = df[col].fillna(df["close"])
        df["volume"] = df["volume"].fillna(0)
        frames[key] = df
        (dst / "p" / f"{key}.json").write_text(json.dumps(enc_full(df), separators=(",", ":")))
        name = nse_names.get(code, code)
        symbols[key] = {"first": str(df.index[0].date()), "last": str(df.index[-1].date()), "rows": len(df),
                        "name": name,
                        "industry": "Index", "n50": False, "n200": False, "fno": key in PRIMARY.values(), "lot": None, "kind": "index",
                        "val": bool(df.get("pe") is not None and df["pe"].notna().sum() >= 50), "source": "NSE",
                        "group": ("debt" if DEBT.search(name) else "derived" if DERIVED.search(name) else "broad" if BROAD_RX.search(name) else "sector" if SECTOR_RX.search(name)
                                  else "factor" if FACTOR_RX.search(name) else "theme")}
    for f in sorted(src.glob("*.csv")):
        s = f.stem
        is_glob = s in GLOBAL_NAMES
        is_idx = s in INDEX_NAMES or is_glob
        if s in symbols or (use_nse and is_idx and not is_glob and s not in ("SENSEX", "BSE100", "BSE500", "BANKEX")):
            continue  # NSE's official series replaces the Yahoo copy
        df = pd.read_csv(f, index_col=0, parse_dates=True).dropna(subset=["close"])
        df = df[~df.index.duplicated(keep="last")].sort_index()
        src_name = "Yahoo"
        if not is_idx and s in nse_stocks and len(nse_stocks[s]) >= MIN_ROWS:
            df, src_name = nse_stocks[s][["open", "high", "low", "close", "volume"]].copy(), "NSE"  # NSE bhavcopy, adjusted from NSE's own records
        if len(df) < (MIN_ROWS_INDEX if is_idx else MIN_ROWS):
            continue
        frames[s] = df
        if src_name != "NSE":  # NSE-sourced stocks are served from the pit bundles (same series), saving ~230 files
            (dst / "p" / f"{s}.json").write_text(json.dumps(enc_full(df), separators=(",", ":")))
        meta = uni.get(s, {})
        symbols[s] = {"first": str(df.index[0].date()), "last": str(df.index[-1].date()), "rows": len(df),
                      "name": meta.get("name") or GLOBAL_NAMES.get(s) or INDEX_NAMES.get(s, s), "industry": meta.get("industry") or ("Global" if is_glob else "Index" if is_idx else ""),
                      "n50": bool(meta.get("nifty50")), "n200": bool(meta.get("nifty200")), "n500": bool(meta.get("nifty500") or meta.get("nifty200")), "fno": bool(meta.get("fno")),
                      "lot": meta.get("lot_size"), "kind": "index" if is_idx else "stock", **({} if is_idx else {"src": src_name}),
                      **({"group": "global" if is_glob else "broad", "source": "Yahoo"} if is_idx else {})}
    # data series that aren't prices (participant positioning, cash flows, market breadth): closes only, kind "series"
    for key, (ser, name, group) in extra_series().items():
        ser = ser.replace([np.inf, -np.inf], np.nan).dropna()
        if len(ser) < 20:
            continue
        frames[key] = pd.DataFrame({"open": ser, "high": ser, "low": ser, "close": ser, "volume": 0.0})
        symbols[key] = {"first": str(ser.index[0].date()), "last": str(ser.index[-1].date()), "rows": len(ser), "name": name, "industry": "Data",
                        "n50": False, "n200": False, "fno": False, "lot": None, "kind": "series", "group": group, "source": "NSE"}
    # legacy keys (earlier builds used these names; saved agents may still refer to them) -> same series
    LEGACY = {"NIFTYBANK": "BANKNIFTY", "NIFTYIT": "NIFTY_IT", "NIFTYPHARMA": "NIFTY_PHARMA", "NIFTYNEXT50": "NIFTYNXT50",
              "NIFTY100": "NIFTY_100", "NIFTY200": "NIFTY_200", "NIFTY500": "NIFTY_500", "NIFTYMIDCAP50": "NIFTY_MIDCAP_50",
              "NIFTYFIN": "FINNIFTY", "NIFTYAUTO": "NIFTY_AUTO", "NIFTYFMCG": "NIFTY_FMCG", "NIFTYMETAL": "NIFTY_METAL",
              "NIFTYREALTY": "NIFTY_REALTY", "NIFTYENERGY": "NIFTY_ENERGY", "NIFTYPSUBANK": "NIFTY_PSU_BANK", "NIFTYMEDIA": "NIFTY_MEDIA"}
    for old, new in LEGACY.items():
        if old not in frames and new in frames:
            frames[old] = frames[new]
            (dst / "p" / f"{old}.json").write_text((dst / "p" / f"{new}.json").read_text())
            symbols[old] = {**symbols[new], "alias_of": new}
    # calendar = union of all trading days
    # calendar = Indian trading days (union of NSE series); world markets are put on it (last known value), so
    # weekends and foreign holidays never become extra rows in Indian strategies
    cal = sorted(set().union(*[set(df.index) for k, df in frames.items() if symbols.get(k, {}).get("group") != "global"]))
    cal_set = pd.DatetimeIndex(cal)
    for k in [k for k in frames if symbols.get(k, {}).get("group") == "global"]:
        g = frames[k]
        rng = cal_set[(cal_set >= g.index[0]) & (cal_set <= g.index[-1] + pd.Timedelta(days=4))]
        g = g.reindex(g.index.union(rng)).sort_index().ffill().reindex(rng).dropna(subset=["close"])
        frames[k] = g
        symbols[k].update({"first": str(g.index[0].date()), "last": str(g.index[-1].date()), "rows": len(g)})
        (dst / "p" / f"{k}.json").write_text(json.dumps(enc_full(g), separators=(",", ":")))
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
        "nifty50": members(lambda m: m["n50"]), "nifty200": members(lambda m: m["n200"]), "nifty500": members(lambda m: m.get("n500")),
        "global": sorted(s_ for s_, m in symbols.items() if m.get("group") == "global"),
        "flows": sorted(s_ for s_, m in symbols.items() if m.get("group") == "flows"),
        "breadth": sorted(s_ for s_, m in symbols.items() if m.get("group") == "breadth"),
        "fno": members(lambda m: m["fno"]), "all": members(lambda m: True),
        "sectors": sorted(s for s, m in symbols.items() if m.get("group") == "sector" and not m.get("alias_of")) or sorted(sectors),
        "baskets": sorted(sectors),
        "indices": sorted(s for s, m in symbols.items() if m["kind"] == "index" and s != "INDIAVIX" and not m.get("alias_of") and m.get("group") not in ("debt", "derived", "global", "flows", "breadth")),
        "debt": sorted(s for s, m in symbols.items() if m.get("group") == "debt" and not m.get("alias_of") and "CLEAN_PRICE" not in s),  # total-return series only
        "derived": sorted(s for s, m in symbols.items() if m.get("group") == "derived" and not m.get("alias_of")),
        "broad": sorted(s for s, m in symbols.items() if m.get("group") == "broad" and not m.get("alias_of")),
        "themes": sorted(s for s, m in symbols.items() if m.get("group") == "theme" and s != "INDIAVIX" and not m.get("alias_of")),
        "factors": sorted(s for s, m in symbols.items() if m.get("group") == "factor" and not m.get("alias_of")),
        "fno_indices": [s for s in ["NIFTY", "BANKNIFTY", "FINNIFTY", "MIDCPNIFTY", "NIFTYNXT50", "SENSEX"] if s in symbols],
        "banks": [s for s in ["HDFCBANK", "ICICIBANK", "SBIN", "AXISBANK", "KOTAKBANK", "INDUSINDBK", "BANKBARODA", "PNB", "CANBK", "FEDERALBNK", "IDFCFIRSTB", "AUBANK", "UNIONBANK", "BANKINDIA", "INDIANB"] if s in symbols],
        **industries,
    }
    pit = build_pit(dst, universes)
    if pit:  # where each NSE-sourced stock's full OHLCV lives (data/pit/full/<bundle>.json)
        pb = json.loads((dst / "pit" / "membership.json").read_text()).get("bundles", {})
        for s_, m_ in symbols.items():
            if m_.get("src") == "NSE":
                if s_ in pb:
                    m_["pb"] = pb[s_]
                else:  # not in a bundle for some reason: fall back to its own file
                    (dst / "p" / f"{s_}.json").write_text(json.dumps(enc_full(frames[s_]), separators=(",", ":")))
    opt_info = copy_options(dst, symbols)
    has_shares = (ROOT / "data" / "shares.json").exists()
    manifest = {"generated": fetched.get("generated"), "shares": has_shares, "source": "Stocks: NSE daily bhavcopy, adjusted with NSE's corporate-action records (splits, bonuses, dividends, demergers, rights) and cross-checked against Yahoo; Yahoo only where NSE history is missing. Indices: NSE daily index files (with P/E, P/B, dividend yield). Lists: NSE.",
                "symbols": symbols, "universes": universes, "sectors": sectors, **({"pit": pit} if pit else {}), **({"options": opt_info} if opt_info else {})}
    (dst / "manifest.json").write_text(json.dumps(manifest, separators=(",", ":")))
    # share counts (for market-cap weights): {SYM: {"f": free-float ratio, "s": [[epoch_day, shares], ...]}}
    sh_file = ROOT / "data" / "shares.json"
    if sh_file.exists():
        raw_sh = json.loads(sh_file.read_text()).get("stocks", {})
        floats = sorted(v["float"] for v in raw_sh.values() if v.get("float"))
        f_default = floats[len(floats) // 2] if floats else 1.0  # median free float where Yahoo has none
        SPLITS = (1.5, 2, 3, 4, 5, 10)

        def split_adjusted(pts):
            """Prices are split/bonus adjusted, so share counts must be too: walking back from today, a jump that
            matches a split or bonus ratio (2x, 5x, 1:2 bonus = 1.5x ...) scales every earlier count up by that ratio."""
            pts = sorted(pts)
            out, mult = [], 1.0
            for i in range(len(pts) - 1, -1, -1):
                d, n = pts[i]
                if i < len(pts) - 1:
                    r = pts[i + 1][1] / n
                    if any(abs(r / k - 1) < 0.03 for k in SPLITS):
                        mult *= r
                out.append([d, n * mult])
            return sorted(out)
        out_sh = {}
        for s, v in raw_sh.items():
            pts = [[int(pd.Timestamp(d).value // 86_400_000_000_000), float(n)] for d, n in v.get("shares", []) if n and n > 0]
            if s in symbols and pts:
                out_sh[s] = {"f": v.get("float") or f_default, "s": split_adjusted(pts)}
        (dst / "shares.json").write_text(json.dumps(out_sh, separators=(",", ":")))
        print(f"shares: {len(out_sh)} stocks with share counts")
    size = sum(p.stat().st_size for p in dst.rglob("*") if p.is_file())
    kinds = {k: sum(1 for m in symbols.values() if m["kind"] == k) for k in ("stock", "index", "basket", "series")}
    print(f"{kinds} | NSE indices: {len(nse)} | universes: {', '.join(f'{k}={len(v)}' for k, v in universes.items())} | {size / 1e6:.1f} MB -> {dst}")


if __name__ == "__main__":
    main(Path(sys.argv[1]))
