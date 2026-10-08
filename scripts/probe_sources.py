"""One-off: which research data sources answer from GitHub Actions (writes data/research/_probe.json + samples)."""
import json, time, ssl
from pathlib import Path
import requests, urllib3
UA = {"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36", "Accept": "*/*"}
OUT = Path("data/research"); (OUT / "samples").mkdir(parents=True, exist_ok=True)
out = {}
def tryget(name, url, s=None, save=None, timeout=40, **kw):
    t = time.time()
    try:
        r = (s or requests).get(url, headers={**UA, **kw.pop("headers", {})}, timeout=timeout, **kw)
        out[name] = {"url": url, "status": r.status_code, "bytes": len(r.content), "secs": round(time.time() - t, 1), "head": r.text[:600]}
        if save and r.ok: (OUT / "samples" / save).write_bytes(r.content[:3_000_000])
        return r
    except Exception as e:
        out[name] = {"url": url, "error": str(e)[:200], "secs": round(time.time() - t, 1)}
tryget("fred_csv", "https://fred.stlouisfed.org/graph/fredgraph.csv?id=DGS10", timeout=60)
tryget("fred_csv_curlua", "https://fred.stlouisfed.org/graph/fredgraph.csv?id=DGS10", timeout=60, headers={"User-Agent": "curl/8.5.0"})
tryget("dbnomics_imf_cpi", "https://api.db.nomics.org/v22/series/IMF/IFS/M.IN.PCPI_IX?observations=1&format=json")
tryget("dbnomics_search", "https://api.db.nomics.org/v22/search?q=india%20policy%20rate&limit=5")
tryget("bis_cbpol", "https://stats.bis.org/api/v2/data/dataflow/BIS/WS_CBPOL/1.0/D.IN?format=csv&startPeriod=2024-01-01")
tryget("bis_cbpol_v1", "https://stats.bis.org/api/v1/data/WS_CBPOL/D.IN?format=csv&startPeriod=2024-01-01")
tryget("oecd_cli", "https://sdmx.oecd.org/public/rest/data/OECD.SDD.STES,DSD_STES@DF_CLI,4.1/IND.M.LI...AA...H?startPeriod=2024-01&format=csvfilewithlabels")
tryget("ust_yields", "https://home.treasury.gov/resource-center/data-chart-center/interest-rates/daily-treasury-rates.csv/2026/all?type=daily_treasury_yield_curve&field_tdr_date_value=2026&page&_format=csv")
tryget("google_news_rss", "https://news.google.com/rss/search?q=Nifty%20OR%20Sensex%20when:2d&hl=en-IN&gl=IN&ceid=IN:en", save="gnews.xml")
tryget("et_markets_rss", "https://economictimes.indiatimes.com/markets/rssfeeds/1977021501.cms")
tryget("livemint_rss", "https://www.livemint.com/rss/markets")
tryget("rbi_press_rss", "https://www.rbi.org.in/pressreleases_rss.xml", save="rbi_press.xml")
# MoSPI with legacy TLS renegotiation
class Legacy(requests.adapters.HTTPAdapter):
    def init_poolmanager(self, *a, **k):
        ctx = ssl.create_default_context(); ctx.options |= 0x4  # OP_LEGACY_SERVER_CONNECT
        k["ssl_context"] = ctx; return super().init_poolmanager(*a, **k)
ms = requests.Session(); ms.mount("https://", Legacy())
for nm, u in [("mospi_cpi", "https://api.mospi.gov.in/api/cpi/getCPIIndex?base_year=2012&series=Current&year=2026&limit=20&Format=JSON"),
              ("mospi_iip", "https://api.mospi.gov.in/api/iip/getIIPMonthly?base_year=2011-12&year=2026&limit=20&Format=JSON"),
              ("mospi_root", "https://api.mospi.gov.in/")]:
    tryget(nm, u, s=ms)
s = requests.Session()
ref = {"Referer": "https://www.nseindia.com/"}
for sym in ("HDFCBANK", "JETAIRWAYS", "RELIANCE"):
    r = tryget(f"nse_results_{sym}", f"https://www.nseindia.com/api/corporates-financial-results?index=equities&symbol={sym}&period=Quarterly", s=s, headers=ref)
    try:
        js = r.json(); out[f"nse_results_{sym}"]["n"] = len(js)
        xs = [e for e in js if str(e.get("xbrl", "")).endswith(".xml")]
        out[f"nse_results_{sym}"]["n_xbrl"] = len(xs); out[f"nse_results_{sym}"]["oldest_xbrl"] = xs[-1] if xs else None
        out[f"nse_results_{sym}"]["kinds"] = sorted({(e.get("consolidated"), e.get("indAs"), e.get("format"), e.get("cumulative")) for e in js}, key=str)
        if xs:
            tryget(f"xbrl_new_{sym}", xs[0]["xbrl"], s=s, headers=ref, save=f"{sym}_new.xml")
            tryget(f"xbrl_old_{sym}", xs[-1]["xbrl"], s=s, headers=ref, save=f"{sym}_old.xml")
        (OUT / "samples" / f"{sym}_list.json").write_text(json.dumps(js[:400], indent=0))
    except Exception as e:
        out.setdefault(f"nse_results_{sym}", {})["err"] = str(e)[:200]
tryget("nse_ann_all", "https://www.nseindia.com/api/corporate-announcements?index=equities&from_date=07-10-2026&to_date=08-10-2026", s=s, headers=ref, save="ann_all.json")
tryget("nse_events", "https://www.nseindia.com/api/event-calendar", s=s, headers=ref, save="events.json")
tryget("nse_shp", "https://www.nseindia.com/api/corporate-share-holdings-master?index=equities&symbol=HDFCBANK", s=s, headers=ref, save="shp_HDFCBANK.json")
tryget("nse_quote", "https://www.nseindia.com/api/quote-equity?symbol=TCS", s=s, headers=ref, save="quote_TCS.json")
tryget("nse_quote_trade", "https://www.nseindia.com/api/quote-equity?symbol=TCS&section=trade_info", s=s, headers=ref, save="quote_trade_TCS.json")
tryget("worldbank_cpi", "https://api.worldbank.org/v2/country/IN/indicator/FP.CPI.TOTL.ZG?format=json&per_page=100")
(OUT / "_probe.json").write_text(json.dumps(out, indent=1, default=str))
print(json.dumps({k: (v.get("status") or v.get("error", "")[:60]) for k, v in out.items()}, indent=0))
