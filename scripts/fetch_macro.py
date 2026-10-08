"""Macro data for TradeOS research and strategies (runs on GitHub Actions; the container can't reach these sites).

Every series is stored with two dates: `period` (what the number is about, e.g. the month of a CPI print) and `known`
(the first day the market could have known it = period end + a publication lag). Backtests use `known`, so a rule can
never trade on a number before it was published. Output:
  data/macro/<KEY>.csv      period,known,value
  data/macro/catalog.json   {KEY: {name, unit, freq, source, group, last_period, last_known, last, prev, chg_3m, chg_12m}}
Usage: python scripts/fetch_macro.py
"""
from __future__ import annotations

import io
import json
import ssl
import time
from datetime import date, datetime, timedelta
from pathlib import Path

import pandas as pd
import requests

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "data" / "macro"
UA = {"User-Agent": "curl/8.5.0", "Accept": "*/*"}

# key: (source, id, name, unit, freq, transform, lag_days, group)
#   transform: level | yoy (% change vs 12 months / 4 quarters / 1 year earlier) | diff (change vs previous period)
#   lag_days: days after the END of the period before the number is public (conservative)
CATALOG = {
    # ---- India
    "IN_REPO": ("bis", "WS_CBPOL/D.IN", "RBI policy (repo) rate", "%", "D", "level", 0, "india"),
    "IN_CPI_YOY": ("mospi_cpi", "", "India CPI inflation (combined, y/y)", "%", "M", "level", 13, "india"),
    "IN_IIP_YOY": ("mospi_iip", "", "India industrial production (IIP, y/y)", "%", "M", "level", 29, "india"),
    "IN_GDP_YOY": ("fred", "NGDPRNSAXDCINQ", "India real GDP growth (y/y, quarterly)", "%", "Q", "yoy", 62, "india"),
    "IN_10Y": ("fred", "INDIRLTLT01STM", "India 10-year government bond yield (monthly avg)", "%", "M", "level", 5, "india"),
    "IN_CPI_YOY_OECD": ("fred", "INDCPIALLMINMEI", "India CPI y/y (OECD series)", "%", "M", "yoy", 45, "india"),
    "IN_FX_RESERVES": ("fred", "TRESEGINM052N", "India FX reserves excl. gold (US$ bn)", "US$ bn", "M", "level_bn", 40, "india"),
    "IN_EXPORTS_YOY": ("fred", "XTEXVA01INM667S", "India goods exports (y/y)", "%", "M", "yoy", 20, "india"),
    "IN_IMPORTS_YOY": ("fred", "XTIMVA01INM667S", "India goods imports (y/y)", "%", "M", "yoy", 20, "india"),
    "IN_CLI": ("oecd_cli", "IND", "India composite leading indicator (OECD, 100 = trend)", "index", "M", "level", 8, "india"),
    "USDINR_REF": ("fred", "DEXINUS", "Rupees per US dollar (Fed H.10 noon rate)", "₹", "D", "level", 1, "india"),
    "IN_GDP_ANNUAL": ("wb", "NY.GDP.MKTP.KD.ZG", "India real GDP growth (annual, World Bank)", "%", "A", "level", 200, "india"),
    "IN_CAD_GDP": ("wb", "BN.CAB.XOKA.GD.ZS", "India current account balance (% of GDP, annual)", "%", "A", "level", 200, "india"),
    # ---- United States / global
    "US_FEDFUNDS": ("fred", "DFF", "US Fed funds effective rate", "%", "D", "level", 1, "global"),
    "US_2Y": ("fred", "DGS2", "US 2-year Treasury yield", "%", "D", "level", 1, "global"),
    "US_10Y_YIELD": ("fred", "DGS10", "US 10-year Treasury yield", "%", "D", "level", 1, "global"),
    "US_CURVE_10_2": ("fred", "T10Y2Y", "US yield curve 10y minus 2y", "pp", "D", "level", 1, "global"),
    "US_REAL_10Y": ("fred", "DFII10", "US 10-year real yield (TIPS)", "%", "D", "level", 1, "global"),
    "US_BREAKEVEN_10Y": ("fred", "T10YIE", "US 10-year breakeven inflation", "%", "D", "level", 1, "global"),
    "US_HY_SPREAD": ("fred", "BAMLH0A0HYM2", "US high-yield credit spread", "pp", "D", "level", 1, "global"),
    "US_IG_SPREAD": ("fred", "BAMLC0A0CM", "US investment-grade credit spread", "pp", "D", "level", 1, "global"),
    "USD_BROAD": ("fred", "DTWEXBGS", "US dollar, broad trade-weighted index", "index", "D", "level", 1, "global"),
    "BRENT_SPOT": ("fred", "DCOILBRENTEU", "Brent crude spot (US$/bbl)", "US$", "D", "level", 1, "global"),
    "US_FIN_STRESS": ("fred", "STLFSI4", "St. Louis Fed financial stress index (0 = normal)", "index", "W", "level", 3, "global"),
    "US_CPI_YOY": ("fred", "CPIAUCSL", "US CPI inflation (y/y)", "%", "M", "yoy", 14, "global"),
    "US_CORE_CPI_YOY": ("fred", "CPILFESL", "US core CPI inflation (y/y)", "%", "M", "yoy", 14, "global"),
    "US_UNRATE": ("fred", "UNRATE", "US unemployment rate", "%", "M", "level", 7, "global"),
    "US_PAYROLLS_CHG": ("fred", "PAYEMS", "US non-farm payrolls, monthly change (thousands)", "k", "M", "diff", 7, "global"),
    "US_INDPRO_YOY": ("fred", "INDPRO", "US industrial production (y/y)", "%", "M", "yoy", 17, "global"),
    "US_RETAIL_YOY": ("fred", "RSAFS", "US retail sales (y/y)", "%", "M", "yoy", 16, "global"),
    "US_SENTIMENT": ("fred", "UMCSENT", "US consumer sentiment (Michigan)", "index", "M", "level", 3, "global"),
    "US_M2_YOY": ("fred", "M2SL", "US money supply M2 (y/y)", "%", "M", "yoy", 25, "global"),
    "FED_BALANCE": ("fred", "WALCL", "Fed balance sheet (US$ trn)", "US$ trn", "W", "level_trn_from_mn", 2, "global"),
    "ECB_RATE": ("fred", "ECBDFR", "ECB deposit rate", "%", "D", "level", 1, "global"),
    "JP_10Y": ("fred", "IRLTLT01JPM156N", "Japan 10-year yield (monthly)", "%", "M", "level", 5, "global"),
    "DE_10Y": ("fred", "IRLTLT01DEM156N", "Germany 10-year yield (monthly)", "%", "M", "level", 5, "global"),
    "COPPER_USD": ("fred", "PCOPPUSDM", "Copper price (US$/tonne, monthly)", "US$", "M", "level", 10, "global"),
    "US_INIT_CLAIMS": ("fred", "ICSA", "US initial jobless claims (thousands)", "k", "W", "level_k", 5, "global"),
}
PERIOD_END = {"D": lambda p: p, "W": lambda p: p, "M": lambda p: p + pd.offsets.MonthEnd(0), "Q": lambda p: p + pd.offsets.QuarterEnd(0), "A": lambda p: p + pd.offsets.YearEnd(0)}


def get(url, session=None, tries=3, timeout=60):
    last = None
    for k in range(tries):
        try:
            r = (session or requests).get(url, headers=UA, timeout=timeout)
            if r.status_code == 200:
                return r
            last = f"http {r.status_code}"
        except requests.RequestException as e:
            last = e.__class__.__name__
        time.sleep(2 * (k + 1))
    raise RuntimeError(f"{url}: {last}")


def fred(sid: str) -> pd.Series:
    r = get(f"https://fred.stlouisfed.org/graph/fredgraph.csv?id={sid}")
    df = pd.read_csv(io.StringIO(r.text))
    df.columns = ["date", "value"]
    df["value"] = pd.to_numeric(df["value"], errors="coerce")
    return df.dropna().set_index(pd.to_datetime(df.dropna()["date"]))["value"]


def bis(path: str) -> pd.Series:
    flow, key = path.split("/")
    r = get(f"https://stats.bis.org/api/v1/data/{flow}/{key}?format=csv&startPeriod=2000-01-01")
    df = pd.read_csv(io.StringIO(r.text))
    s = pd.Series(pd.to_numeric(df["OBS_VALUE"], errors="coerce").values, index=pd.to_datetime(df["TIME_PERIOD"]))
    return s.dropna().sort_index()


def oecd_cli(area: str) -> pd.Series:
    r = get(f"https://sdmx.oecd.org/public/rest/data/OECD.SDD.STES,DSD_STES@DF_CLI,4.1/{area}.M.LI...AA...H?startPeriod=2005-01&format=csvfilewithlabels")
    df = pd.read_csv(io.StringIO(r.text))
    s = pd.Series(pd.to_numeric(df["OBS_VALUE"], errors="coerce").values, index=pd.to_datetime(df["TIME_PERIOD"]))
    return s.dropna().sort_index()


def worldbank(ind: str) -> pd.Series:
    r = get(f"https://api.worldbank.org/v2/country/IN/indicator/{ind}?format=json&per_page=200")
    rows = r.json()[1] or []
    s = pd.Series({pd.Timestamp(f"{x['date']}-01-01"): x["value"] for x in rows if x.get("value") is not None})
    return s.sort_index()


class _Legacy(requests.adapters.HTTPAdapter):  # MoSPI's server needs legacy TLS renegotiation
    def init_poolmanager(self, *a, **k):
        ctx = ssl.create_default_context()
        ctx.options |= 0x4  # OP_LEGACY_SERVER_CONNECT
        k["ssl_context"] = ctx
        return super().init_poolmanager(*a, **k)


MONTHS = {m: i for i, m in enumerate(["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"], 1)}


def mospi(kind: str) -> pd.Series:
    s = requests.Session()
    s.mount("https://", _Legacy())
    out = {}
    for y in range(2013, date.today().year + 1):
        if kind == "iip":
            url = f"https://api.mospi.gov.in/api/iip/getIIPMonthly?base_year=2011-12&year={y}&type=General&limit=100&Format=JSON"
        else:
            url = None
            for cand in (f"https://api.mospi.gov.in/api/cpi/getCPIIndex?base_year=2012&year={y}&limit=500&Format=JSON",
                         f"https://api.mospi.gov.in/api/cpi/getCPIIndex?base_year=2012&series=Current&year={y}&limit=500&Format=JSON",
                         f"https://api.mospi.gov.in/api/cpi/getAllIndiaItemIndex?base_year=2012&year={y}&limit=500&Format=JSON"):
                try:
                    js = get(cand, session=s, tries=1).json()
                except Exception:  # noqa: BLE001
                    continue
                if js.get("data"):
                    url = cand
                    if y == 2024:
                        print(f"  mospi cpi sample ({cand}): {json.dumps(js['data'][:2])[:600]}", flush=True)
                    break
            if not url:
                continue
        try:
            if kind == "iip":
                js = get(url, session=s, tries=2).json()
        except Exception as e:  # noqa: BLE001
            print(f"  mospi {kind} {y}: {e}", flush=True)
            continue
        for x in js.get("data") or []:
            m = MONTHS.get(str(x.get("month", "")).strip().title())
            if not m:
                continue
            if kind == "iip":
                if str(x.get("category", "")).lower() != "general" and str(x.get("type", "")).lower() != "general":
                    continue
                v = x.get("growth_rate")
            else:
                sec = str(x.get("sector", "combined")).lower()
                grp = str(x.get("group", x.get("group_name", "general"))).lower()
                if "combined" not in sec or ("general" not in grp and grp not in ("", "none", "-")):
                    continue
                v = x.get("inflation") or x.get("inflation_rate") or x.get("yoy")
                if v in (None, ""):
                    out.setdefault(("idx", y, m), x.get("index"))
                    continue
            try:
                out[(y, m)] = float(v)
            except (TypeError, ValueError):
                pass
    idx = {k: v for k, v in out.items() if k[0] == "idx"}
    vals = {pd.Timestamp(year=y, month=m, day=1): v for (y, m), v in ((k, v) for k, v in out.items() if k[0] != "idx")}
    if not vals and idx:  # CPI index only: compute y/y
        lv = pd.Series({pd.Timestamp(year=y, month=m, day=1): float(v) for (_, y, m), v in idx.items() if v not in (None, "")}).sort_index()
        return (lv / lv.shift(12) - 1).dropna() * 100
    return pd.Series(vals).sort_index()


def mospi_debug() -> None:
    """raw samples of MoSPI's API (which parameters return what) -> data/macro/_debug_mospi.json"""
    s = requests.Session()
    s.mount("https://", _Legacy())
    out = {}
    for name, url in [
        ("cpi_y2024", "https://api.mospi.gov.in/api/cpi/getCPIIndex?base_year=2012&year=2024&limit=5&Format=JSON"),
        ("cpi_noyear", "https://api.mospi.gov.in/api/cpi/getCPIIndex?base_year=2012&limit=5&Format=JSON"),
        ("cpi_series", "https://api.mospi.gov.in/api/cpi/getCPIIndex?base_year=2012&series=Current&limit=5&Format=JSON"),
        ("cpi_item", "https://api.mospi.gov.in/api/cpi/getItemIndex?base_year=2012&year=2025&limit=5&Format=JSON"),
        ("cpi_inflation", "https://api.mospi.gov.in/api/cpi/getCPIInflation?base_year=2012&year=2025&limit=5&Format=JSON"),
        ("cpi_2024base", "https://api.mospi.gov.in/api/cpi/getCPIIndex?base_year=2024&limit=5&Format=JSON"),
        ("iip_2026", "https://api.mospi.gov.in/api/iip/getIIPMonthly?base_year=2011-12&year=2026&type=General&limit=40&Format=JSON"),
        ("iip_2027", "https://api.mospi.gov.in/api/iip/getIIPMonthly?base_year=2011-12&year=2027&type=General&limit=40&Format=JSON"),
        ("iip_2022base", "https://api.mospi.gov.in/api/iip/getIIPMonthly?base_year=2022-23&year=2026&type=General&limit=40&Format=JSON"),
        ("wpi", "https://api.mospi.gov.in/api/wpi/getWpiRecords?year=2026&limit=5&Format=JSON"),
        ("gdp", "https://api.mospi.gov.in/api/nas/getNASData?base_year=2011-12&series=Current&frequency=Quarterly&limit=5&Format=JSON"),
        ("plfs", "https://api.mospi.gov.in/api/plfs/getData?limit=3&Format=JSON"),
        ("swagger", "https://api.mospi.gov.in/api/docs"),
    ]:
        try:
            r = s.get(url, headers=UA, timeout=40)
            try:
                js = r.json()
                out[name] = {"status": r.status_code, "keys": list(js.keys()) if isinstance(js, dict) else None, "n": len(js.get("data") or []) if isinstance(js, dict) else None,
                             "sample": (js.get("data") or [])[:6] if isinstance(js, dict) else None, "msg": js.get("msg") if isinstance(js, dict) else None}
            except ValueError:
                out[name] = {"status": r.status_code, "text": r.text[:400]}
        except Exception as e:  # noqa: BLE001
            out[name] = {"error": str(e)[:200]}
    (OUT / "_debug_mospi.json").write_text(json.dumps(out, indent=1, ensure_ascii=False))


def transform(s: pd.Series, how: str, freq: str) -> pd.Series:
    if how.startswith("level"):
        k = {"level_bn": 1 / 1000, "level_trn_from_mn": 1 / 1e6, "level_k": 1 / 1000}.get(how, 1)
        return s * k
    if how == "diff":
        return s.diff().dropna()
    if how == "yoy":
        n = {"M": 12, "Q": 4, "A": 1, "W": 52}.get(freq, 252)
        return ((s / s.shift(n) - 1) * 100).dropna()
    raise ValueError(how)


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    try:
        mospi_debug()
    except Exception as e:  # noqa: BLE001
        print(f"mospi debug failed: {e}")
    old = json.loads((OUT / "catalog.json").read_text()) if (OUT / "catalog.json").exists() else {}
    cat, errors = {}, {}
    for key, (src, sid, name, unit, freq, how, lag, group) in CATALOG.items():
        try:
            if src == "fred":
                raw = fred(sid)
            elif src == "bis":
                raw = bis(sid)
            elif src == "oecd_cli":
                raw = oecd_cli(sid)
            elif src == "wb":
                raw = worldbank(sid)
            elif src == "mospi_cpi":
                raw = mospi("cpi")
            elif src == "mospi_iip":
                raw = mospi("iip")
            else:
                raise ValueError(src)
            if raw is None or len(raw) == 0:
                raise RuntimeError("no data returned")
            s = transform(raw.sort_index(), how, freq)
            s = s[s.index >= "2005-01-01"].round(4)
            if s.empty:
                raise RuntimeError("no data")
            per_end = s.index.map(PERIOD_END[freq])
            known = per_end + pd.Timedelta(days=lag)
            df = pd.DataFrame({"period": s.index.date, "known": known.date, "value": s.values})
            df.to_csv(OUT / f"{key}.csv", index=False)
            v = df["value"]
            def ago(days):
                t = pd.Timestamp(df["period"].iloc[-1]) - pd.Timedelta(days=days)
                w = df[pd.to_datetime(df["period"]) <= t]
                return None if w.empty else round(float(v.iloc[-1] - w["value"].iloc[-1]), 3)
            cat[key] = {"name": name, "unit": unit, "freq": freq, "source": {"fred": "FRED", "bis": "BIS", "oecd_cli": "OECD", "wb": "World Bank", "mospi_cpi": "MoSPI", "mospi_iip": "MoSPI"}[src] + (f" {sid}" if src == "fred" else ""),
                        "group": group, "lag_days": lag, "first": str(df["period"].iloc[0]), "last_period": str(df["period"].iloc[-1]), "last_known": str(df["known"].iloc[-1]),
                        "last": round(float(v.iloc[-1]), 3), "prev": round(float(v.iloc[-2]), 3) if len(v) > 1 else None, "chg_3m": ago(88), "chg_12m": ago(360), "n": len(df)}
            print(f"{key}: {len(df)} obs to {cat[key]['last_period']} = {cat[key]['last']}", flush=True)
        except Exception as e:  # noqa: BLE001
            errors[key] = str(e)[:200]
            if key in old and (OUT / f"{key}.csv").exists():
                cat[key] = {**old[key], "stale": True}
            print(f"{key}: FAILED {e}", flush=True)
        time.sleep(0.3)
    (OUT / "catalog.json").write_text(json.dumps(cat, indent=1, ensure_ascii=False))
    (OUT / "_report.json").write_text(json.dumps({"asof": datetime.utcnow().isoformat(timespec="minutes"), "ok": len(cat) - sum(1 for c in cat.values() if c.get("stale")), "errors": errors}, indent=1))
    print(json.dumps({"ok": len(cat), "errors": errors}, indent=1))


if __name__ == "__main__":
    main()
