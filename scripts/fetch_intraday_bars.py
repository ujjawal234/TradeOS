"""1-minute bars for every NSE and BSE stock, rolling last 20 sessions (runs on GitHub Actions after the close).

Yahoo Finance serves 1-minute bars for the last ~30 days (at most 8 days per request). Each run fetches the newest
sessions for every stock (incremental: the last 5 days; the first run backfills ~4 weeks), merges them into the
stored sessions, and keeps only the latest --sessions (default 20). Bars are NSE/BSE session bars 09:15–15:30 IST,
labelled by their start minute; minutes without a trade are filled flat at the last price with zero volume.

Symbols: every stock in the daily price list (scripts/fetch_eod.py -> eod/meta.json): NSE stocks as SYMBOL.NS,
BSE-only stocks as <scrip code>.BO; plus NIFTY, BANKNIFTY, FINNIFTY, SENSEX and INDIAVIX. If the result would be
larger than --max-mb, the least-traded stocks are left out (the report lists how many).

Storage = the app's own files (uploaded by the workflow as the `intraday-data` release; nothing large is committed):
  intra/<YYYYMMDD>_<g>.json.gz   one session, one group of symbols: {SYM: [epochDay, firstMinute, c0, dc[], do[], dh[], dl[], v[]]}
                                 (prices ×100 as ints: close as deltas within the day, open/high/low as offsets from close)
  intra/index.json               {asof, sessions: [dates], groups, symbols: {SYM: {g, 1m, 1m_first, 1m_last, 1m_days}}}
A symbol's group is crc32(symbol) % groups, so each day adds new files and old days are simply dropped.
Usage: python scripts/fetch_intraday_bars.py [--prev intraday_app.tar] [--eod .eod/eod] [--out build_intra] [--sessions 20]
"""
from __future__ import annotations

import argparse
import gzip
import json
import tarfile
import time
import zlib
from pathlib import Path

import numpy as np
import pandas as pd
import yfinance as yf

ROOT = Path(__file__).resolve().parents[1]
INDEX_TICKERS = {"NIFTY": "^NSEI", "BANKNIFTY": "^NSEBANK", "FINNIFTY": "NIFTY_FIN_SERVICE.NS", "INDIAVIX": "^INDIAVIX", "SENSEX": "^BSESN"}
GROUPS = 12
EPOCH = pd.Timestamp("1970-01-01")


def group_of(sym: str) -> int:
    return zlib.crc32(sym.encode()) % GROUPS


def symbol_list(eod_dir: Path) -> tuple[dict, dict]:
    """{SYM: yahoo ticker} for every stock, and {SYM: average daily traded value} (for ordering by liquidity)"""
    tick, liq = {}, {}
    mf = eod_dir / "meta.json"
    if mf.exists():
        meta = json.loads(mf.read_text())["symbols"]
        for s, m in meta.items():
            if m.get("ex") == "NSE":
                tick[s] = f"{s}.NS"
            elif m.get("code"):
                tick[s] = f"{m['code']}.BO"
        pf = eod_dir / "prices.csv.gz"
        if pf.exists():
            p = pd.read_csv(pf, usecols=["sym", "date", "value"])
            p = p[p["date"] >= sorted(p["date"].unique())[-20]]
            liq = p.groupby("sym")["value"].mean().to_dict()
    else:  # no daily list yet: the app's stock list
        uni = json.loads((ROOT / "data" / "universe.json").read_text()).get("stocks", {})
        tick = {s: f"{s}.NS" for s in uni}
    for s, t in INDEX_TICKERS.items():
        tick[s] = t
        liq[s] = float("inf")
    return tick, liq


def to_frames(df: pd.DataFrame, tick: dict) -> dict:
    out = {}
    for t, s in tick.items():
        try:
            g = df[t] if isinstance(df.columns, pd.MultiIndex) else df
            g = g.rename(columns=str.lower)[["open", "high", "low", "close", "volume"]].dropna(subset=["close"])
        except KeyError:
            continue
        if g.empty:
            continue
        idx = g.index.tz_convert("Asia/Kolkata") if g.index.tz is not None else g.index.tz_localize("UTC").tz_convert("Asia/Kolkata")
        g.index = idx.tz_localize(None)
        t_ = g.index.time
        g = g[(t_ >= pd.Timestamp("09:15").time()) & (t_ < pd.Timestamp("15:30").time())]
        if len(g):
            out[s] = g.astype(float)
    return out


def dedup(x: pd.DataFrame) -> pd.DataFrame:
    x = x.sort_index()
    return x[~x.index.duplicated(keep="last")]


def fetch(tick: dict, windows: list, chunk: int = 50) -> dict:
    """yahoo 1m bars for {SYM: ticker} over each (start, end) window (or a period string); {SYM: DataFrame}"""
    out: dict[str, list] = {}
    items = list(tick.items())
    t0 = time.time()
    for i in range(0, len(items), chunk):
        part = {t: s for s, t in items[i:i + chunk]}
        for w in windows:
            kw = {"period": w} if isinstance(w, str) else {"start": w[0], "end": w[1]}
            df = None
            for attempt in range(3):
                try:
                    df = yf.download(list(part), interval="1m", group_by="ticker", auto_adjust=False, prepost=False, threads=True, progress=False, **kw)
                    break
                except Exception as e:  # noqa: BLE001
                    print(f"  chunk {i} {w}: {str(e)[:120]}", flush=True)
                    time.sleep(5 * (attempt + 1))
            if df is None or df.empty:
                continue
            for s, g in to_frames(df, part).items():
                out.setdefault(s, []).append(g)
        if (i // chunk) % 10 == 0:
            print(f"  {i + len(part)}/{len(items)} tickers, {len(out)} with bars, {time.time() - t0:.0f}s", flush=True)
        time.sleep(0.5)
    return {s: dedup(pd.concat(v)) for s, v in out.items()}


def pack_day(g: pd.DataFrame, d: pd.Timestamp) -> list | None:
    if len(g) < 2:
        return None
    mins = ((g.index - (d + pd.Timedelta(hours=9, minutes=15))).total_seconds() // 60).astype(int).to_numpy()
    n = int(mins.max()) + 1 - int(mins[0])
    c = np.full(n, np.nan); o = c.copy(); h = c.copy(); lo = c.copy(); v = np.zeros(n)
    k = mins - mins[0]
    c[k], o[k], h[k], lo[k], v[k] = g["close"], g["open"], g["high"], g["low"], g["volume"].fillna(0)
    c = pd.Series(c).ffill().to_numpy()
    for a in (o, h, lo):
        m = np.isnan(a)
        a[m] = c[m]
    ci = np.round(c * 100).astype(np.int64)
    return [int((d - EPOCH).days), int(mins[0]), int(ci[0]), np.diff(ci, prepend=ci[0]).tolist(),
            (np.round(o * 100).astype(np.int64) - ci).tolist(), (np.round(h * 100).astype(np.int64) - ci).tolist(),
            (np.round(lo * 100).astype(np.int64) - ci).tolist(), np.round(v).astype(np.int64).tolist()]


def load_prev(path: str) -> dict:
    """{YYYYMMDD: {SYM: dayArray}} from a previous intraday_app.tar (files intra/<date>_<g>.json.gz)"""
    days: dict[str, dict] = {}
    if not path or not Path(path).exists():
        return days
    with tarfile.open(path) as t:
        for m in t.getmembers():
            name = m.name.split("/")[-1]
            if name.endswith(".json.gz") and name[:8].isdigit() and "_" in name:
                days.setdefault(name[:8], {}).update(json.loads(gzip.decompress(t.extractfile(m).read())))
    return days


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--prev", default="", help="previous intraday_app.tar")
    ap.add_argument("--eod", default=".eod/eod", help="folder with meta.json and prices.csv.gz from the eod-data release")
    ap.add_argument("--out", default="build_intra")
    ap.add_argument("--sessions", type=int, default=20)
    ap.add_argument("--max-mb", type=float, default=140, help="size cap for all sessions together (gzip)")
    ap.add_argument("--max-symbols", type=int, default=0, help="0 = every stock")
    args = ap.parse_args()
    out = ROOT / args.out / "app" / "intra"
    out.mkdir(parents=True, exist_ok=True)
    days = load_prev(args.prev)
    print(f"previous: {len(days)} sessions", flush=True)
    tick, liq = symbol_list(ROOT / args.eod)
    order = sorted(tick, key=lambda s: -(liq.get(s) or 0))
    if args.max_symbols:
        order = order[:args.max_symbols]
    tick = {s: tick[s] for s in order}
    print(f"fetching 1-minute bars for {len(tick)} symbols", flush=True)
    today = pd.Timestamp.now(tz="Asia/Kolkata").normalize().tz_localize(None)
    have = {s for v in days.values() for s in v}
    fresh = [s for s in tick if s not in have]
    got: dict = {}
    if len(days) >= 5 and len(fresh) < len(tick) * 0.5:  # incremental: the last 5 days for everyone, a backfill for newcomers
        got.update(fetch(tick, ["5d"]))
        back = {s: tick[s] for s in fresh if s not in got or got[s].index.normalize().nunique() < 3}
    else:
        back = tick
    if back:
        wins, end = [], today + pd.Timedelta(days=1)
        for _ in range(4):  # ~4 weeks back in 7-day windows (Yahoo: <= 8 days per 1m request, last 30 days)
            st = end - pd.Timedelta(days=7)
            wins.append((st.strftime("%Y-%m-%d"), end.strftime("%Y-%m-%d")))
            end = st
        print(f"backfilling {len(back)} symbols over {len(wins)} windows", flush=True)
        for s, g in fetch(back, wins).items():
            got[s] = dedup(pd.concat([got[s], g])) if s in got else g
    print(f"got bars for {len(got)} symbols", flush=True)
    for s, g in got.items():  # newly fetched days replace stored ones (Yahoo revises the last bars of a day)
        for d, gd in g.groupby(g.index.normalize()):
            arr = pack_day(gd, d)
            if arr:
                days.setdefault(d.strftime("%Y%m%d"), {})[s] = arr
    # a session = a day with bars for a fair share of symbols (stray days with a handful of symbols are dropped)
    big = max((len(x) for x in days.values()), default=0)
    sess = sorted(d for d, v in days.items() if len(v) >= max(3, 0.2 * big))[-args.sessions:]
    days = {d: days[d] for d in sess}
    # size cap: drop the least-traded symbols until everything fits
    size_of: dict = {}
    for v in days.values():
        for s, arr in v.items():
            size_of[s] = size_of.get(s, 0) + len(json.dumps(arr, separators=(",", ":"))) * 0.27  # ≈ gzip ratio for these arrays
    keep, total, dropped = set(), 0.0, 0
    for s in sorted(size_of, key=lambda x: -(liq.get(x) or 0)):
        if total + size_of[s] > args.max_mb * 1e6:
            dropped += 1
            continue
        keep.add(s)
        total += size_of[s]
    for f in out.glob("*.json.gz"):
        f.unlink()
    index: dict = {}
    for d, v in days.items():
        groups: dict[int, dict] = {}
        for s, arr in v.items():
            if s in keep:
                groups.setdefault(group_of(s), {})[s] = arr
        for g, objs in groups.items():
            (out / f"{d}_{g:02d}.json.gz").write_bytes(gzip.compress(json.dumps(objs, separators=(",", ":")).encode(), 9))
        iso = f"{d[:4]}-{d[4:6]}-{d[6:]}"
        for s in v:
            if s in keep:
                x = index.setdefault(s, {"g": group_of(s), "1m": "d", "1m_days": 0, "1m_first": iso})
                x["1m_days"] += 1
                x["1m_last"] = iso
    sessions = [f"{d[:4]}-{d[4:6]}-{d[6:]}" for d in sess]
    (out / "index.json").write_text(json.dumps({"asof": sessions[-1] if sessions else None, "sessions": sessions, "groups": GROUPS, "layout": "day-group",
                                                "source": f"Yahoo Finance 1-minute bars, every NSE and BSE stock with trades, last {args.sessions} sessions (rolling)",
                                                "symbols": index}, separators=(",", ":")))
    nbytes = sum(f.stat().st_size for f in out.glob("*.json.gz"))
    rep = {"asof": sessions[-1] if sessions else None, "sessions": len(sessions), "symbols": len(index), "requested": len(tick), "fetched": len(got),
           "left_out_for_size": dropped, "files": len(list(out.glob("*.json.gz"))), "app_bytes": nbytes}
    (ROOT / "data" / "intraday_bars").mkdir(parents=True, exist_ok=True)
    (ROOT / "data" / "intraday_bars" / "_report.json").write_text(json.dumps(rep, indent=1))
    print(json.dumps(rep), flush=True)


if __name__ == "__main__":
    main()
