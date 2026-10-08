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
import re
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
    """y/y % by month. IIP: 2011-12 base, then the 2022-23 base where it exists. CPI: 2012 base, then the 2024 base."""
    s = requests.Session()
    s.mount("https://", _Legacy())
    out, seen = {}, {}
    bases = [("2011-12", 2013), ("2022-23", 2023)] if kind == "iip" else [("2012", 2013), ("2024", 2025)]
    for base, y0 in bases:
        for y in range(y0, date.today().year + 1):
            if kind == "iip":
                url = f"https://api.mospi.gov.in/api/iip/getIIPMonthly?base_year={base}&year={y}&type=General&limit=100&Format=JSON"
            else:
                url = f"https://api.mospi.gov.in/api/cpi/getCPIIndex?base_year={base}&year={y}&state_code=99&sector_code=3&group_code=0&limit=100&Format=JSON"
            try:
                rows = get(url, session=s, tries=2, timeout=60).json().get("data") or []
            except Exception as e:  # noqa: BLE001
                print(f"  mospi {kind} {base} {y}: {e}", flush=True)
                continue
            for x in rows:
                m = MONTHS.get(str(x.get("month", "")).strip().title())
                if not m:
                    continue
                if kind == "iip":
                    if str(x.get("category", "")).lower() != "general":
                        continue
                    v = x.get("growth_rate")
                else:
                    seen.setdefault("groups", set()).add(str(x.get("group")))
                    seen.setdefault("sectors", set()).add(str(x.get("sector")))
                    if str(x.get("state", "All India")).lower() != "all india" or str(x.get("sector", "")).lower() != "combined":
                        continue
                    g = str(x.get("group", "")).lower()
                    if not ("general" in g or "all group" in g):
                        continue
                    v = x.get("inflation")
                try:
                    out[pd.Timestamp(year=y, month=m, day=1)] = float(v)  # later (newer) base overwrites
                except (TypeError, ValueError):
                    pass
    if kind == "cpi":
        print(f"  mospi cpi groups seen: {sorted(seen.get('groups', []))[:30]} sectors: {sorted(seen.get('sectors', []))}", flush=True)
        (OUT / "_debug_cpi_groups.json").write_text(json.dumps({k: sorted(v) for k, v in seen.items()}, indent=1))
    return pd.Series(out).sort_index()


def mospi_debug() -> None:
    """raw samples of MoSPI's API (which parameters return what) -> data/macro/_debug_mospi.json"""
    s = requests.Session()
    s.mount("https://", _Legacy())
    out = {}
    for name, url in [
        ("cpi24_a", "https://api.mospi.gov.in/api/cpi/getCPIIndex?base_year=2024&year=2026&state_code=99&sector_code=3&group_code=0&limit=20&Format=JSON"),
        ("cpi24_b", "https://api.mospi.gov.in/api/cpi/getCPIIndex?base_year=2024&year=2026&limit=5&Format=JSON"),
        ("cpi24_c", "https://api.mospi.gov.in/api/cpi/getCPIIndex?series=New&year=2026&limit=5&Format=JSON"),
        ("cpi24_d", "https://api.mospi.gov.in/api/cpi/getCPIIndex?base_year=2012&year=2026&limit=5&Format=JSON"),
        ("cpi24_e", "https://api.mospi.gov.in/api/cpi/getCPIIndex?year=2026&limit=5&Format=JSON"),
        ("cpi_newseries", "https://api.mospi.gov.in/api/cpi/getCPIIndexNew?year=2026&limit=5&Format=JSON"),
        ("cpi2024_ep", "https://api.mospi.gov.in/api/cpi2024/getCPIIndex?year=2026&limit=5&Format=JSON"),
        ("apidocs_json", "https://api.mospi.gov.in/api-docs/swagger.json"),
        ("apidocs_init", "https://api.mospi.gov.in/api-docs/swagger-ui-init.js"),
    ]:
        try:
            r = s.get(url, headers=UA, timeout=40)
            try:
                js = r.json()
                out[name] = {"status": r.status_code, "keys": list(js.keys()) if isinstance(js, dict) else None, "n": len(js.get("data") or []) if isinstance(js, dict) else None,
                             "sample": (js.get("data") or [])[:6] if isinstance(js, dict) else None, "msg": js.get("msg") if isinstance(js, dict) else None}
            except ValueError:
                t = r.text
                cpi = [t[m.start() - 200: m.start() + 1500] for m in re.finditer(r"cpi", t, re.I)][:6] if "swagger" in name or "apidocs" in name else []
                out[name] = {"status": r.status_code, "text": t[:400], "cpi_context": cpi, "len": len(t)}
                if name == "apidocs_init":
                    paths = re.findall(r'"(/api/[^"]+)"\s*:', t)
                    (OUT / "_debug_api_paths.json").write_text(json.dumps(sorted(set(paths)), indent=0))
        except Exception as e:  # noqa: BLE001
            out[name] = {"error": str(e)[:200]}
    try:  # parameter names live in the API explorer's script bundle
        home = s.get("https://api.mospi.gov.in/", headers=UA, timeout=40).text
        js = re.findall(r'src="(/static/js/main[^"]+\.js)"', home)
        if js:
            b = s.get("https://api.mospi.gov.in" + js[0], headers=UA, timeout=60).text
            hits = sorted(set(re.findall(r'[\w/]*cpi[\w/]*', b, re.I)))[:80]
            params = sorted(set(re.findall(r'name:"([a-z_]+)"', b)))[:200]
            ctx = [b[m.start() - 300: m.start() + 600] for m in re.finditer(r"getCPIIndex", b)][:3]
            out["bundle"] = {"cpi_strings": hits, "param_names": params, "context": ctx}
    except Exception as e:  # noqa: BLE001
        out["bundle"] = {"error": str(e)[:200]}
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
