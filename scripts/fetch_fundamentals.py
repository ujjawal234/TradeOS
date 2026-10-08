"""Company fundamentals for TradeOS, point in time (runs on GitHub Actions; NSE's API isn't reachable from elsewhere).

Quarterly results as filed with NSE (XBRL, mid-2018 onwards) for every stock in the app's universe plus every stock
that was ever in the point-in-time top-500 universe (so delisted and dropped companies are included). Each quarter keeps
the time of its FIRST filing: strategies may only use a number from the day after it was published. One basis per
company (consolidated where the company reports it, else standalone) keeps growth rates like-for-like.
Also: shareholding pattern history (promoter %), and a weekly profile snapshot from Yahoo (sector, business summary,
balance-sheet ratios, analyst consensus) for the current Nifty 500.

Incremental: everything parsed is cached in --cache (restored from the `research-data` release by the workflow); a run
refreshes each company's filing list every --refresh-days days (daily for companies with results due/just out) and
stops cleanly after --max-minutes.
Outputs (in --out): app/fund/fNN.json.gz (bundles), app/fund/index.json, app/fund/profiles.json.gz, and the cache.
"""
from __future__ import annotations

import argparse
import gzip
import json
import random
import re
import threading
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import date, datetime, timedelta
from pathlib import Path

import requests

ROOT = Path(__file__).resolve().parents[1]
NSE = "https://www.nseindia.com/api"
UA = {"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36",
      "Accept": "*/*", "Referer": "https://www.nseindia.com/"}
TAGS = {  # field -> XBRL tags in order of preference (in-bse-fin taxonomy, Ind-AS and banks)
    "rev": ["RevenueFromOperations", "Income"],
    "inc": ["Income"],
    "oi": ["OtherIncome"],
    "fin": ["FinanceCosts"],
    "dep": ["DepreciationDepletionAndAmortisationExpense"],
    "exc": ["ExceptionalItemsBeforeTax", "ExceptionalItems"],
    "pbt": ["ProfitBeforeTax", "ProfitLossFromOrdinaryActivitiesBeforeTax"],
    "tax": ["TaxExpense"],
    "pat": ["ProfitOrLossAttributableToOwnersOfParent", "ProfitLossAfterTaxesMinorityInterestAndShareOfProfitLossOfAssociates", "ProfitLossForPeriod", "ProfitLossForThePeriod"],
    "eps": ["BasicEarningsLossPerShareFromContinuingAndDiscontinuedOperations", "BasicEarningsLossPerShareFromContinuingOperations", "BasicEarningsPerShareAfterExtraordinaryItems", "BasicEarningsPerShareBeforeExtraordinaryItems"],
    "paid": ["PaidUpValueOfEquityShareCapital"],
    "face": ["FaceValueOfEquityShareCapital"],
    "ie": ["InterestEarned"], "ix": ["InterestExpended"], "ppop": ["OperatingProfitBeforeProvisionAndContingencies"],
    "prov": ["ProvisionsOtherThanTaxAndContingencies"], "gnpa": ["PercentageOfGrossNpa"], "nnpa": ["PercentageOfNpa"],
}
RUPEE_FIELDS = {"rev", "inc", "oi", "fin", "dep", "exc", "pbt", "tax", "pat", "paid", "ie", "ix", "ppop", "prov"}
_local = threading.local()


def sess() -> requests.Session:
    if not hasattr(_local, "s"):
        _local.s = requests.Session()
    return _local.s


def fetch(url: str, as_json=True, tries=4):
    last = None
    for k in range(tries):
        try:
            r = sess().get(url, headers=UA, timeout=40)
            if r.status_code == 200:
                return r.json() if as_json else r.text
            last = f"http {r.status_code}"
            if r.status_code == 404:
                break
        except (requests.RequestException, ValueError) as e:
            last = e.__class__.__name__
            _local.s = requests.Session()
        time.sleep(1.5 * (k + 1) + random.random())
    raise RuntimeError(last)


def d_of(s: str, fmts=("%d-%b-%Y %H:%M:%S", "%d-%b-%Y %H:%M", "%d-%b-%Y")) -> datetime | None:
    for f in fmts:
        try:
            return datetime.strptime(s.strip(), f)
        except (ValueError, AttributeError):
            pass
    return None


def parse_xbrl(text: str, to_date: date) -> dict:
    """values of TAGS in the context covering the reported quarter (no dimensions), rupees -> ₹ crore"""
    ctx = {}
    for cid, body in re.findall(r'<xbrli:context id="([^"]+)">(.*?)</xbrli:context>', text, re.S):
        if "xbrldi:explicitMember" in body or "typedMember" in body:
            continue
        sd, ed = re.search(r"<xbrli:startDate>([^<]+)<", body), re.search(r"<xbrli:endDate>([^<]+)<", body)
        if sd and ed:
            ctx[cid] = (date.fromisoformat(sd.group(1)[:10]), date.fromisoformat(ed.group(1)[:10]))
    quarter = [c for c, (a, b) in ctx.items() if b == to_date and 80 <= (b - a).days <= 100]
    if not quarter:
        quarter = [c for c, (a, b) in ctx.items() if b == to_date]
    if not quarter:  # some 2018-19 filings use "OneD" without defining it; trust it if its reporting period matches
        m = re.search(r'DateOfEndOfReportingPeriod contextRef="OneD"[^>]*>([^<]+)<', text)  # (either prefix)
        if m and m.group(1).strip()[:10] == to_date.isoformat():
            quarter = ["OneD"]
        else:
            return {}
    quarter.sort(key=lambda c: (c != "OneD", (ctx[c][1] - ctx[c][0]).days if c in ctx else 0))
    cq = set(quarter[:1])
    vals = {}
    for tag, cref, v in re.findall(r'<(?:in-bse-fin|in-capmkt):([A-Za-z]+) contextRef="([^"]+)"[^>]*>([^<]*)<', text):
        if cref in cq and tag not in vals:
            vals[tag] = v
    out = {}
    for f, tags in TAGS.items():
        for t in tags:
            if t in vals:
                try:
                    x = float(vals[t])
                except ValueError:
                    continue
                out[f] = round(x / 1e7, 3) if f in RUPEE_FIELDS else x
                break
    for f in ("gnpa", "nnpa"):  # consolidated bank filings report 0 (NPA ratios are standalone only)
        if out.get(f) == 0:
            del out[f]
    return out


def pick_basis(items: list[dict]) -> str:
    recent = sorted({e["toDate"] for e in items}, key=lambda s: d_of(s), reverse=True)[:12]
    c = sum(1 for e in items if e["toDate"] in recent and e.get("consolidated") == "Consolidated")
    n = sum(1 for e in items if e["toDate"] in recent and e.get("consolidated") != "Consolidated")
    return "C" if c and c >= min(n, len(recent)) - 2 else "S"


def update_symbol(sym: str, cache_dir: Path, refresh_days: int, force: bool, deadline: float) -> dict:
    f = cache_dir / f"{sym}.json"
    c = json.loads(f.read_text()) if f.exists() else {"recs": {}, "bad": []}
    today = date.today().isoformat()
    stats = {"sym": sym, "new": 0, "err": None}
    if force or c.get("lv") != 2 or not c.get("list_at") or (date.fromisoformat(c["list_at"]) + timedelta(days=refresh_days)).isoformat() <= today:
        try:
            lst = fetch(f"{NSE}/corporates-financial-results?index=equities&symbol={requests.utils.quote(sym)}&period=Quarterly")
        except Exception as e:  # noqa: BLE001
            stats["err"] = f"list {e}"
            return stats
        items = [e for e in (lst or []) if str(e.get("xbrl", "")).endswith(".xml") and e.get("cumulative", "Non-cumulative") != "Cumulative" and e.get("toDate")]
        c["list"] = [{k: e.get(k) for k in ("toDate", "fromDate", "consolidated", "broadCastDate", "filingDate", "xbrl", "bank", "audited")} for e in items]
        # since early 2025 results are filed as "Integrated Filing - Financials" (same figures, in-capmkt XBRL) on a separate list
        try:
            il = fetch(f"{NSE}/integrated-filing-results?index=equities&type=Integrated%20Filing-%20Financials&symbol={requests.utils.quote(sym)}")
            rows = il.get("data", []) if isinstance(il, dict) else (il or [])
        except Exception as e:  # noqa: BLE001
            rows = []
            stats["err"] = f"integrated list {e}"
        for x in rows:
            xb, qe = str(x.get("xbrl") or ""), str(x.get("qe_Date") or "").title()
            if not xb.endswith(".xml") or not qe or str(x.get("type_Sub", "")).lower().startswith("withdraw"):
                continue
            bc = str(x.get("broadcast_Date") or x.get("creation_Date") or "")
            c["list"].append({"toDate": qe, "fromDate": None, "consolidated": "Consolidated" if x.get("consolidated") == "Consolidated" else "Non-Consolidated",
                              "broadCastDate": bc, "filingDate": bc[:17], "xbrl": xb, "bank": "B" if "BANKING" in xb.upper() else "N", "audited": x.get("audited")})
            if not c.get("company"):
                c["company"] = x.get("cmName")
        c["list_at"] = today
        c["lv"] = 2
        c["company"] = (lst or [{}])[0].get("companyName") if lst else c.get("company")
    items = c.get("list") or []
    if not items:
        f.write_text(json.dumps(c))
        return stats
    basis = pick_basis(items)
    c["basis"] = basis
    want = {}
    for e in items:
        td = d_of(e["toDate"])
        fd = d_of(e.get("broadCastDate") or "") or d_of(e.get("filingDate") or "")
        if not td or not fd:
            continue
        b = "C" if e.get("consolidated") == "Consolidated" else "S"
        key = td.date().isoformat()
        cand = want.get(key)
        # chosen basis first; within it the earliest filing (what the market saw first)
        rank = (b != basis, fd)
        if cand is None or rank < cand[0]:
            want[key] = (rank, e, b, fd)
    for key, (_, e, b, fd) in sorted(want.items()):
        r = c["recs"].get(key)
        if r and r.get("b") == b and r.get("x") == e["xbrl"]:
            continue
        if e["xbrl"] in c["bad"] or time.time() > deadline:
            continue
        try:
            txt = fetch(e["xbrl"], as_json=False)
            vals = parse_xbrl(txt, date.fromisoformat(key))
        except Exception as ex:  # noqa: BLE001
            c["bad"].append(e["xbrl"])
            stats["err"] = f"xbrl {ex}"
            continue
        if not vals:
            c["bad"].append(e["xbrl"])
            continue
        c["recs"][key] = {**vals, "b": b, "x": e["xbrl"], "filed": fd.strftime("%Y-%m-%d %H:%M"), "bank": 1 if e.get("bank") == "B" or "ie" in vals else 0}
        stats["new"] += 1
        time.sleep(0.15)
    # shareholding pattern (promoter %), monthly
    if force or not c.get("shp_at") or (date.fromisoformat(c["shp_at"]) + timedelta(days=30)).isoformat() <= today or stats["new"]:
        try:
            shp = fetch(f"{NSE}/corporate-share-holdings-master?index=equities&symbol={requests.utils.quote(sym)}")
            rows = []
            for x in shp or []:
                bd = d_of(str(x.get("broadcastDate", "")).title(), ("%d-%b-%Y %H:%M:%S", "%d-%b-%Y"))
                pd_ = d_of(str(x.get("date", "")).title(), ("%d-%b-%Y",))
                try:
                    p = float(x.get("pr_and_prgrp"))
                except (TypeError, ValueError):
                    continue
                if bd and pd_:
                    rows.append([pd_.date().isoformat(), bd.strftime("%Y-%m-%d %H:%M"), p])
            c["shp"] = sorted({r[0]: r for r in sorted(rows, key=lambda r: r[1], reverse=True)}.values())
            c["shp_at"] = today
        except Exception:  # noqa: BLE001
            pass
    f.write_text(json.dumps(c))
    return stats


def days(iso: str) -> int:
    return (date.fromisoformat(iso[:10]) - date(1970, 1, 1)).days


def pack(c: dict) -> dict | None:
    """app form: quarters sorted by period end; k = first day the result could be traded on (day after filing)"""
    recs = sorted(c.get("recs", {}).items())
    if not recs:
        return None
    cols = {f: [] for f in ("rev", "pat", "eps", "pbt", "oi", "fin", "dep", "exc", "ie", "ix", "ppop", "prov", "gnpa", "nnpa")}
    q, k, sh, b = [], [], [], []
    for key, r in recs:
        q.append(days(key)); k.append(days(r["filed"]) + 1); b.append(1 if r.get("b") == "C" else 0)
        face, paid = r.get("face"), r.get("paid")
        x = round(paid * 1e7 / face / 1e6, 3) if face and paid and face > 0 else None  # shares, millions
        # a mis-scaled paid-up capital (some filings report it in other units) shows up as a share count that agrees
        # neither with profit / EPS nor with the previous quarter; then carry the previous count (or use the implied one)
        pat_, eps_ = r.get("pat"), r.get("eps")
        implied = pat_ * 10 / eps_ if pat_ and eps_ and abs(eps_) > 0.01 and pat_ / eps_ > 0 else None
        prev = next((v for v in reversed(sh) if v), None)
        near = lambda a, b_: a and b_ and 0.5 < a / b_ < 2  # noqa: E731
        if x and implied and not near(x, implied) and (prev is None or not near(x, prev)):
            x = prev if prev and near(prev, implied) else round(implied, 3)
        elif not x and prev:
            x = prev
        sh.append(x)
        for f in cols:
            v = r.get(f)
            if f in ("gnpa", "nnpa") and v is not None and v < 0.2:
                v = v * 100  # XBRL percentages are usually fractions (0.0133 = 1.33%)
            cols[f].append(None if v is None else round(v, 2))
    out = {"q": q, "k": k, "b": b, "sh": sh, **{f: v for f, v in cols.items() if any(x is not None for x in v)}}
    if any(r.get("bank") for _, r in recs[-4:]):
        out["bank"] = 1
    if c.get("shp"):
        out["shp"] = [[days(r[1]) + 1, r[2]] for r in c["shp"]]
    return out


def profiles(syms: list[str], old: dict, max_age_days: int, deadline: float) -> dict:
    try:
        import yfinance as yf
    except ImportError:
        return old
    out = dict(old)
    today = date.today()
    keep = ("sector", "industry", "longBusinessSummary", "marketCap", "trailingPE", "forwardPE", "priceToBook", "returnOnEquity", "returnOnAssets",
            "profitMargins", "operatingMargins", "grossMargins", "revenueGrowth", "earningsGrowth", "debtToEquity", "currentRatio", "dividendYield",
            "payoutRatio", "beta", "bookValue", "trailingEps", "forwardEps", "enterpriseToEbitda", "recommendationKey", "recommendationMean",
            "targetMeanPrice", "targetHighPrice", "targetLowPrice", "numberOfAnalystOpinions", "heldPercentInsiders", "heldPercentInstitutions", "fullTimeEmployees", "website")
    for s in syms:
        if time.time() > deadline:
            break
        o = out.get(s)
        if o and o.get("_at") and (today - date.fromisoformat(o["_at"])).days < max_age_days:
            continue
        try:
            info = yf.Ticker(f"{s}.NS").info or {}
        except Exception:  # noqa: BLE001
            continue
        p = {k: info.get(k) for k in keep if info.get(k) not in (None, "", "Infinity")}
        if p.get("longBusinessSummary"):
            p["longBusinessSummary"] = p["longBusinessSummary"][:700]
        p["_at"] = today.isoformat()
        out[s] = p
        time.sleep(0.4)
    return out


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--cache", default=".fund_cache")
    ap.add_argument("--out", default="build_fund")
    ap.add_argument("--max-minutes", type=float, default=300)
    ap.add_argument("--workers", type=int, default=6)
    ap.add_argument("--refresh-days", type=int, default=7)
    ap.add_argument("--limit", type=int, default=0, help="only the first N symbols (testing)")
    ap.add_argument("--profiles-days", type=int, default=7)
    args = ap.parse_args()
    t0 = time.time()
    deadline = t0 + args.max_minutes * 60
    cache = ROOT / args.cache / "sym"
    cache.mkdir(parents=True, exist_ok=True)
    out = ROOT / args.out / "app" / "fund"
    out.mkdir(parents=True, exist_ok=True)
    uni = json.loads((ROOT / "data" / "universe.json").read_text()).get("stocks", {})
    cur = [s for s, m in uni.items() if m.get("nifty500") or m.get("nifty200") or m.get("fno")]
    pit = []
    mem = ROOT / "data" / "pit" / "membership.json"
    if mem.exists():
        for d, members in json.loads(mem.read_text())["universes"].get("top500pit", []):
            if d >= "2017-01-01":
                pit += members
    syms = list(dict.fromkeys(sorted(cur) + sorted(set(pit) - set(cur))))
    if args.limit:
        syms = syms[: args.limit]
    # companies with results due or just out: refresh their filing list every day
    hot = set()
    ev = ROOT / "data" / "news" / "events.json"
    if ev.exists():
        lo, hi = (date.today() - timedelta(days=6)).isoformat(), (date.today() + timedelta(days=1)).isoformat()
        hot = {e["sym"] for e in json.loads(ev.read_text()).get("items", []) if lo <= e["date"] <= hi and re.search(r"result", e.get("purpose", ""), re.I)}
    fl = ROOT / "data" / "news" / "filings.json"
    if fl.exists():
        lo = (date.today() - timedelta(days=4)).isoformat()
        hot |= {x["sym"] for x in json.loads(fl.read_text()).get("items", []) if x["t"] >= lo and re.search(r"financial result", x.get("desc", ""), re.I)}
    print(f"{len(syms)} companies ({len(cur)} current, {len(syms) - len(cur)} past members); {len(hot)} with fresh results", flush=True)
    stats, done = [], 0
    with ThreadPoolExecutor(max_workers=args.workers) as pool:
        futs = [pool.submit(update_symbol, s, cache, args.refresh_days, s in hot, deadline) for s in syms]
        for fu in as_completed(futs):
            try:
                stats.append(fu.result())
            except Exception as e:  # noqa: BLE001
                stats.append({"sym": "?", "new": 0, "err": str(e)[:100]})
            done += 1
            if done % 100 == 0:
                print(f"  {done}/{len(syms)} companies, {sum(x['new'] for x in stats)} new quarters, {(time.time() - t0) / 60:.1f} min", flush=True)
    # profiles (current universe only)
    pf = ROOT / args.cache / "profiles.json"
    prof = profiles(sorted(cur), json.loads(pf.read_text()) if pf.exists() else {}, args.profiles_days, deadline - 120)
    pf.write_text(json.dumps(prof))
    # bundles
    index, bundle, size, b = {}, {}, 0, 0
    def flush():
        nonlocal bundle, size, b
        if bundle:
            key = f"f{b:02d}"
            (out / f"{key}.json.gz").write_bytes(gzip.compress(json.dumps(bundle, separators=(",", ":")).encode(), 9))
            for s in bundle:
                index[s]["f"] = key
            b += 1; bundle = {}; size = 0
    for s in syms:
        f = cache / f"{s}.json"
        if not f.exists():
            continue
        c = json.loads(f.read_text())
        p = pack(c)
        if not p:
            continue
        z = len(json.dumps(p))
        if bundle and size + z > 2_500_000:
            flush()
        bundle[s] = p; size += z
        index[s] = {"n": len(p["q"]), "first": str(date(1970, 1, 1) + timedelta(days=p["q"][0])), "last": str(date(1970, 1, 1) + timedelta(days=p["q"][-1])),
                    "filed": str(date(1970, 1, 1) + timedelta(days=p["k"][-1] - 1)), "basis": "consolidated" if p["b"][-1] else "standalone", **({"bank": 1} if p.get("bank") else {}),
                    **({"company": c["company"]} if c.get("company") else {})}
    flush()
    (out / "profiles.json.gz").write_bytes(gzip.compress(json.dumps({s: p for s, p in prof.items() if s in uni}, separators=(",", ":")).encode(), 9))
    last = max((v["filed"] for v in index.values()), default="")
    (out / "index.json").write_text(json.dumps({"asof": date.today().isoformat(), "latest_filing": last, "companies": index,
        "source": "NSE quarterly results as filed (XBRL, mid-2018 onwards); shareholding from NSE; profiles from Yahoo Finance"}, separators=(",", ":")))
    errs = [x for x in stats if x.get("err")]
    rep = {"asof": date.today().isoformat(), "companies": len(index), "of": len(syms), "new_quarters": sum(x["new"] for x in stats), "errors": len(errs),
           "error_examples": errs[:8], "profiles": len(prof), "minutes": round((time.time() - t0) / 60, 1), "hot": len(hot)}
    (ROOT / "data" / "research").mkdir(parents=True, exist_ok=True)
    (ROOT / "data" / "research" / "_fund_report.json").write_text(json.dumps(rep, indent=1))
    print(json.dumps(rep), flush=True)


if __name__ == "__main__":
    main()
