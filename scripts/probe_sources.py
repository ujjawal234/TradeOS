"""One-off: which research data sources answer from GitHub Actions (writes data/research/_probe.json)."""
import json, time, re
from pathlib import Path
import requests
UA = {"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36", "Accept": "*/*"}
out = {}
def tryget(name, url, s=None, **kw):
    t = time.time()
    try:
        r = (s or requests).get(url, headers={**UA, **kw.pop("headers", {})}, timeout=30, **kw)
        out[name] = {"status": r.status_code, "bytes": len(r.content), "secs": round(time.time() - t, 1), "head": r.text[:400]}
        return r
    except Exception as e:
        out[name] = {"error": str(e)[:200]}
tryget("fred_cpi_india", "https://fred.stlouisfed.org/graph/fredgraph.csv?id=INDCPIALLMINMEI")
tryget("fred_dgs10", "https://fred.stlouisfed.org/graph/fredgraph.csv?id=DGS10")
tryget("worldbank_gdp", "https://api.worldbank.org/v2/country/IN/indicator/NY.GDP.MKTP.KD.ZG?format=json&per_page=100")
tryget("imf_datamapper", "https://www.imf.org/external/datamapper/api/v1/NGDP_RPCH/IND")
tryget("mospi_api", "https://api.mospi.gov.in/api/cpi/getCPIIndex?base_year=2012&series=Current&limit=5")
tryget("rbi_home", "https://www.rbi.org.in/")
tryget("rbi_dbie", "https://data.rbi.org.in/DBIE/")
s = requests.Session()
tryget("nse_home", "https://www.nseindia.com/", s=s, headers={"Accept": "text/html"})
r = tryget("nse_results_list", "https://www.nseindia.com/api/corporates-financial-results?index=equities&symbol=TCS&period=Quarterly", s=s, headers={"Referer": "https://www.nseindia.com/"})
try:
    js = r.json(); out["nse_results_list"]["n"] = len(js); out["nse_results_list"]["first"] = js[0] if js else None; out["nse_results_list"]["last"] = js[-1] if js else None
    x = next((e.get("xbrl") for e in js if e.get("xbrl") and e["xbrl"].endswith(".xml")), None)
    if x:
        rx = tryget("nse_xbrl", x, s=s, headers={"Referer": "https://www.nseindia.com/"})
        if rx is not None and rx.ok:
            tags = sorted(set(re.findall(r"<(in-bse-fin|in-capmkt):([A-Za-z]+)", rx.text)))[:80]
            out["nse_xbrl"]["tags"] = [t[1] for t in tags]
except Exception as e:
    out.setdefault("nse_results_list", {})["parse_error"] = str(e)[:200]
tryget("nse_shareholding", "https://www.nseindia.com/api/corporate-share-holdings-master?index=equities&symbol=TCS", s=s, headers={"Referer": "https://www.nseindia.com/"})
tryget("nse_board_meetings", "https://www.nseindia.com/api/corporate-board-meetings?index=equities&symbol=TCS", s=s, headers={"Referer": "https://www.nseindia.com/"})
tryget("nse_announcements", "https://www.nseindia.com/api/corporate-announcements?index=equities&symbol=TCS", s=s, headers={"Referer": "https://www.nseindia.com/"})
try:
    import yfinance as yf
    t = yf.Ticker("TCS.NS")
    info = t.info
    out["yf_info"] = {k: info.get(k) for k in ("sector", "industry", "marketCap", "trailingPE", "forwardPE", "priceToBook", "returnOnEquity", "profitMargins", "revenueGrowth", "earningsGrowth", "debtToEquity", "recommendationKey", "targetMeanPrice", "numberOfAnalystOpinions")}
    q = t.quarterly_income_stmt; a = t.income_stmt
    out["yf_quarterly"] = {"cols": [str(c.date()) for c in q.columns], "rows": list(q.index)[:40]}
    out["yf_annual"] = {"cols": [str(c.date()) for c in a.columns]}
    out["yf_bs"] = {"cols": [str(c.date()) for c in t.balance_sheet.columns], "rows": list(t.balance_sheet.index)[:30]}
    out["yf_earnings_dates"] = str(t.get_earnings_dates(limit=12))[:600]
except Exception as e:
    out["yf_error"] = str(e)[:300]
Path("data/research").mkdir(parents=True, exist_ok=True)
Path("data/research/_probe.json").write_text(json.dumps(out, indent=1, default=str))
print(json.dumps({k: (v.get("status") if isinstance(v, dict) else None) for k, v in out.items()}))
