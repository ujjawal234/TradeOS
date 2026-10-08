"""News, filings and the results calendar for TradeOS research (runs on GitHub Actions several times a day).

Headlines only (title, source, time, link), from publishers' own RSS feeds plus RBI press releases; corporate filings
from NSE's announcements feed (the exchange's one-line description of each filing); upcoming board meetings (results,
dividends) from NSE's event calendar. Rolling windows: headlines 45 days, filings 120 days.
Outputs: data/news/headlines.json, data/news/filings.json, data/news/events.json
"""
from __future__ import annotations

import html
import json
import re
import time
from datetime import datetime, timedelta, timezone
from email.utils import parsedate_to_datetime
from pathlib import Path

import requests

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "data" / "news"
UA = {"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36", "Accept": "*/*"}
IST = timezone(timedelta(hours=5, minutes=30))
FEEDS = {
    "ET Markets": "https://economictimes.indiatimes.com/markets/rssfeeds/1977021501.cms",
    "ET Stocks": "https://economictimes.indiatimes.com/markets/stocks/rssfeeds/2146842.cms",
    "ET Economy": "https://economictimes.indiatimes.com/news/economy/rssfeeds/1373380680.cms",
    "Mint Markets": "https://www.livemint.com/rss/markets",
    "Mint Economy": "https://www.livemint.com/rss/economy",
    "Mint Companies": "https://www.livemint.com/rss/companies",
    "RBI": "https://www.rbi.org.in/pressreleases_rss.xml",
}
NSE = "https://www.nseindia.com/api"
REF = {"Referer": "https://www.nseindia.com/"}


def rss(name: str, url: str) -> list[dict]:
    r = requests.get(url, headers=UA, timeout=30)
    r.raise_for_status()
    text = r.content.decode("utf-8-sig", errors="replace")
    out = []
    for item in re.findall(r"<item>(.*?)</item>", text, re.S):
        def tag(t):
            m = re.search(rf"<{t}>(.*?)</{t}>", item, re.S)
            if not m:
                return ""
            v = m.group(1).strip()
            v = re.sub(r"^<!\[CDATA\[(.*)\]\]>$", r"\1", v, flags=re.S)
            return html.unescape(re.sub(r"<[^>]+>", " ", v)).strip()
        title, link, pub = tag("title"), tag("link"), tag("pubDate")
        if not title:
            continue
        try:
            dt = parsedate_to_datetime(pub)
            # RBI stamps Indian time but labels it GMT
            t = (dt.replace(tzinfo=None) if name == "RBI" else dt.astimezone(IST)).strftime("%Y-%m-%d %H:%M")
        except (TypeError, ValueError):
            t = datetime.now(IST).strftime("%Y-%m-%d %H:%M")
        out.append({"t": t, "src": name, "title": re.sub(r"\s+", " ", title)[:220], "link": link[:400]})
    return out


def nse_json(s: requests.Session, path: str):
    for k in range(3):
        try:
            r = s.get(f"{NSE}/{path}", headers={**UA, **REF}, timeout=40)
            if r.status_code == 200:
                return r.json()
        except (requests.RequestException, ValueError):
            pass
        time.sleep(2 * (k + 1))
    return None


def company_index() -> list[tuple[str, re.Pattern]]:
    """symbol -> pattern of its short company name, to tag headlines (Nifty 500 + F&O only)"""
    uni = json.loads((ROOT / "data" / "universe.json").read_text()).get("stocks", {})
    out = []
    for s, m in uni.items():
        nm = re.sub(r"\b(Limited|Ltd\.?|India|Industries|Corporation|Company|Co\.|Enterprises|The)\b", "", m.get("name", ""), flags=re.I).strip(" .,&-")
        words = nm.split()
        if not words:
            continue
        common = {"urban", "indian", "bharat", "global", "general", "national", "capital", "power", "finance", "steel", "energy", "infra", "life", "home", "prime",
                  "star", "united", "great", "first", "new", "city", "credit", "central", "union", "metro", "gold", "green", "future", "aditya", "bajaj", "tata", "adani", "mahindra",
                  "birla", "hindustan", "state", "south", "eastern", "western", "northern", "max", "sun", "best", "allied", "premier", "standard", "supreme", "jindal", "godrej"}
        short = " ".join(words[:2]) if (len(words[0]) < 5 or words[0].lower() in common) and len(words) > 1 else words[0]
        if len(short) < 4 or short.lower() in common:
            continue
        out.append((s, re.compile(rf"\b({re.escape(short)}|{re.escape(s)})\b", re.I)))
    return out


def merge(old: list, new: list, key, keep_days: int, tcol="t") -> list:
    cut = (datetime.now(IST) - timedelta(days=keep_days)).strftime("%Y-%m-%d")
    seen, out = set(), []
    for x in sorted(new + old, key=lambda x: x.get(tcol, ""), reverse=True):
        k = key(x)
        if k in seen or x.get(tcol, "") < cut:
            continue
        seen.add(k)
        out.append(x)
    return out


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    rep = {}
    # ---- headlines
    old = json.loads((OUT / "headlines.json").read_text()).get("items", []) if (OUT / "headlines.json").exists() else []
    new = []
    for name, url in FEEDS.items():
        try:
            items = rss(name, url)
            new += items
            rep[name] = len(items)
        except Exception as e:  # noqa: BLE001
            rep[name] = f"error {e.__class__.__name__}"
    idx = company_index()
    for x in new:
        x["syms"] = [] if x["src"] == "RBI" else [s for s, rx in idx if rx.search(x["title"])][:4]
    items = merge(old, new, lambda x: x["title"].lower()[:120], 45)
    (OUT / "headlines.json").write_text(json.dumps({"asof": datetime.now(IST).strftime("%Y-%m-%d %H:%M"), "items": items}, ensure_ascii=False, separators=(",", ":")))
    # ---- NSE filings (last 3 days each run) and event calendar
    s = requests.Session()
    to = datetime.now(IST)
    fr = to - timedelta(days=3)
    ann = nse_json(s, f"corporate-announcements?index=equities&from_date={fr:%d-%m-%Y}&to_date={to:%d-%m-%Y}") or []
    skip = re.compile(r"(Certificate under SEBI \(Depositories|Trading Window|Loss of Share|Duplicate Share|Copy of Newspaper|Newspaper Publication|Compliance Certificate|Reg\. 74|Book Closure)", re.I)
    fnew = []
    for a in ann:
        d = str(a.get("desc", "")).strip()
        if not d or skip.search(d):
            continue
        try:
            t = datetime.strptime(a["an_dt"], "%d-%b-%Y %H:%M:%S").strftime("%Y-%m-%d %H:%M")
        except (KeyError, ValueError):
            continue
        text = re.sub(r"\s+", " ", str(a.get("attchmntText") or ""))
        text = re.sub(r"^.{0,120}?has informed the Exchange (about|regarding|that)\s*", "", text, flags=re.I)
        fnew.append({"t": t, "sym": a.get("symbol"), "desc": d[:140], "text": text[:300], "link": a.get("attchmntFile") or ""})
    rep["filings_fetched"] = len(fnew)
    oldf = json.loads((OUT / "filings.json").read_text()).get("items", []) if (OUT / "filings.json").exists() else []
    filings = merge(oldf, fnew, lambda x: (x["sym"], x["t"], x["desc"]), 120)
    (OUT / "filings.json").write_text(json.dumps({"asof": to.strftime("%Y-%m-%d %H:%M"), "items": filings}, ensure_ascii=False, separators=(",", ":")))
    ev = nse_json(s, "event-calendar") or []
    events = []
    for e in ev:
        try:
            d = datetime.strptime(e["date"], "%d-%b-%Y").strftime("%Y-%m-%d")
        except (KeyError, ValueError):
            continue
        events.append({"date": d, "sym": e.get("symbol"), "purpose": str(e.get("purpose", ""))[:80], "desc": re.sub(r"\s+", " ", str(e.get("bm_desc", "")))[:240]})
    if events:
        (OUT / "events.json").write_text(json.dumps({"asof": to.strftime("%Y-%m-%d %H:%M"), "items": sorted(events, key=lambda x: x["date"])}, ensure_ascii=False, separators=(",", ":")))
    rep.update({"headlines": len(items), "filings": len(filings), "events": len(events), "asof": to.strftime("%Y-%m-%d %H:%M")})
    (OUT / "_report.json").write_text(json.dumps(rep, indent=1))
    print(json.dumps(rep))


if __name__ == "__main__":
    main()
