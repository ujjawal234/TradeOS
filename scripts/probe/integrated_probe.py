"""One-off probe: where does NSE publish quarterly results after the move to Integrated Filing (2025)?"""
import json, re, time
from pathlib import Path
import requests

UA = {"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36", "Accept": "*/*", "Referer": "https://www.nseindia.com/"}
s = requests.Session()
out = {}
def get(url, n=1500):
    try:
        r = s.get(url, headers=UA, timeout=40)
        return {"status": r.status_code, "type": r.headers.get("content-type"), "len": len(r.content), "head": r.text[:n]}
    except Exception as e:
        return {"error": str(e)[:200]}
try:
    s.get("https://www.nseindia.com/", headers=UA, timeout=30)
except Exception:
    pass
pages = ["https://www.nseindia.com/companies-listing/corporate-integrated-filing", "https://www.nseindia.com/companies-listing/corporate-filings-financial-results"]
for p in pages:
    try:
        r = s.get(p, headers=UA, timeout=40)
        apis = sorted(set(re.findall(r'["\'](/api/[A-Za-z0-9_\-/?=&.%]+)', r.text)))
        js = re.findall(r'src="([^"]+\.js[^"]*)"', r.text)
        out[p] = {"status": r.status_code, "apis": apis[:200], "js": js[:40]}
        for j in js:
            u = j if j.startswith("http") else "https://www.nseindia.com" + j
            try:
                t = s.get(u, headers=UA, timeout=40).text
                found = sorted(set(re.findall(r'(?:/api/|api/)[A-Za-z0-9_\-]*(?:integrat|financial|xbrl|result)[A-Za-z0-9_\-/?=&.%]*', t, re.I)))
                if found:
                    out.setdefault("js_apis", {})[u] = found[:80]
            except Exception:
                pass
    except Exception as e:
        out[p] = {"error": str(e)[:200]}
cands = [
    "integrated-filing-results?index=equities&symbol=RELIANCE",
    "integrated-filing-results?index=equities&symbol=RELIANCE&period=Quarterly",
    "integrated-filing-results?index=equities&type=Integrated%20Filing-%20Financials&symbol=RELIANCE",
    "integrated-filing-results?index=equities&from_date=01-07-2026&to_date=31-07-2026",
    "integrated-filing-results?index=equities&from_date=01-07-2026&to_date=31-07-2026&type=Integrated%20Filing-%20Financials",
    "corporates-integrated-filing?index=equities&symbol=RELIANCE",
    "integrated-filing?index=equities&symbol=RELIANCE",
    "corporates-financial-results?index=equities&symbol=RELIANCE&period=Quarterly",
    "corporates-financial-results?index=equities&from_date=01-07-2026&to_date=31-07-2026&period=Quarterly",
    "corporate-announcements?index=equities&symbol=RELIANCE&from_date=01-07-2026&to_date=31-07-2026",
]
for c in cands:
    out["api/" + c] = get("https://www.nseindia.com/api/" + c, 2500)
    time.sleep(1)
Path("data/_probe").mkdir(parents=True, exist_ok=True)
Path("data/_probe/integrated.json").write_text(json.dumps(out, indent=1))
print(json.dumps({k: (v.get("status"), v.get("len")) if isinstance(v, dict) else None for k, v in out.items()}, indent=1))
