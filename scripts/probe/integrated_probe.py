"""One-off probe: NSE Integrated Filing (Financials) XBRL — list format and tags."""
import collections, json, re, sys, time
from datetime import date
from pathlib import Path
import requests
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import fetch_fundamentals as ff  # noqa: E402

UA = {"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36", "Accept": "*/*", "Referer": "https://www.nseindia.com/"}
s = requests.Session()
out = {}
for sym in ["RELIANCE", "HDFCBANK", "TCS"]:
    r = s.get(f"https://www.nseindia.com/api/integrated-filing-results?index=equities&type=Integrated%20Filing-%20Financials&symbol={sym}", headers=UA, timeout=40)
    js = r.json()
    rows = js.get("data", []) if isinstance(js, dict) else js
    o = {"keys": list(js.keys()) if isinstance(js, dict) else None, "n": len(rows), "meta": {k: v for k, v in js.items() if k != "data"} if isinstance(js, dict) else None,
         "rows": [{k: x.get(k) for k in ("qe_Date", "consolidated", "audited", "broadcast_Date", "type_Sub", "xbrl")} for x in rows]}
    cons = [x for x in rows if x.get("consolidated") == "Consolidated" and str(x.get("xbrl", "")).endswith(".xml")]
    for x in cons[:2]:
        t = s.get(x["xbrl"], headers=UA, timeout=40).text
        pref = collections.Counter(re.findall(r"<([a-z][a-z0-9\-]*):[A-Za-z]+ contextRef", t))
        tags = collections.Counter(re.findall(r"<([a-z][a-z0-9\-]*:[A-Za-z]+) contextRef", t))
        ctxs = re.findall(r'<xbrli:context id="([^"]+)">', t)[:30]
        qe = date(*map(int, __import__("datetime").datetime.strptime(x["qe_Date"], "%d-%b-%Y").strftime("%Y-%m-%d").split("-")))
        parsed = ff.parse_xbrl(t.replace("in-capmkt:", "in-bse-fin:"), qe)
        o.setdefault("samples", []).append({"qe": x["qe_Date"], "len": len(t), "prefixes": pref.most_common(10), "tags": [k for k, _ in tags.most_common(400)], "contexts": ctxs, "parsed_as_is": ff.parse_xbrl(t, qe), "parsed_capmkt": parsed, "head": t[:1500]})
        time.sleep(1)
    out[sym] = o
    time.sleep(1)
r = s.get("https://www.nseindia.com/api/integrated-filing-results?index=equities&type=Integrated%20Filing-%20Financials&from_date=01-07-2026&to_date=15-07-2026", headers=UA, timeout=40)
js = r.json(); out["date_range"] = {"keys": list(js.keys()) if isinstance(js, dict) else None, "n": len(js.get("data", [])) if isinstance(js, dict) else len(js), "meta": {k: v for k, v in js.items() if k != "data"} if isinstance(js, dict) else None}
Path("data/_probe").mkdir(parents=True, exist_ok=True)
Path("data/_probe/integrated2.json").write_text(json.dumps(out, indent=1))
print("ok")
