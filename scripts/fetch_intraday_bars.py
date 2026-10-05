"""Intraday price history for TradeOS backtests (runs on GitHub Actions after the close).

Yahoo Finance serves 5-minute bars for the last ~60 days and 1-minute bars for the last ~7 days. Nothing older is
free, so this job keeps everything it has ever fetched: it downloads the previous history (the `intraday-data`
release asset), adds the newest bars and publishes it again. History therefore grows by one day every trading day.

Symbols: Nifty 50 + the latest point-in-time top 100 + F&O stocks named in intraday/agents.json, and the main indices.
Bars are NSE session bars, 09:15-15:30 IST, labelled by their start time.

Outputs (in --out, uploaded by the workflow; nothing large is committed):
  hist/5m/<SYM>.csv.gz, hist/1m/<SYM>.csv.gz   full history (date-time, open, high, low, close, volume)
  app/intra/i5_NN.json.gz, i1_NN.json.gz          app bundles: last --app-days-5m / --app-days-1m sessions
  app/intra/index.json                            per symbol: bundle keys, first/last day, number of days
Usage: python scripts/fetch_intraday_bars.py [--prev prev.tar] [--out build_intra]
"""
from __future__ import annotations

import argparse
import gzip
import io
import json
import tarfile
import time
from pathlib import Path

import numpy as np
import pandas as pd
import yfinance as yf

ROOT = Path(__file__).resolve().parents[1]
INDEX_TICKERS = {"NIFTY": "^NSEI", "BANKNIFTY": "^NSEBANK", "FINNIFTY": "NIFTY_FIN_SERVICE.NS", "INDIAVIX": "^INDIAVIX"}
YAHOO_SYM = {"M&M": "M&M.NS", "M&MFIN": "M&MFIN.NS", "BAJAJ-AUTO": "BAJAJ-AUTO.NS"}


def symbols() -> list[str]:
    uni = json.loads((ROOT / "data" / "universe.json").read_text()).get("stocks", {})
    out = {s for s, m in uni.items() if m.get("nifty50")}
    mem = ROOT / "data" / "pit" / "membership.json"
    if mem.exists():
        u = json.loads(mem.read_text())["universes"].get("top100pit") or []
        if u:
            out |= set(u[-1][1]) & set(uni)
    cfg = ROOT / "intraday" / "agents.json"
    if cfg.exists():  # whatever the live paper agents trade (universe names or symbols), up to Nifty 200
        for a in json.loads(cfg.read_text()).get("agents", []):
            for s in a.get("symbols", []):
                k = str(s).lower()
                if k in ("nifty50", "nifty200", "fno"):
                    out |= {x for x, m in uni.items() if m.get(k) and m.get("nifty200")}
                elif str(s).upper() in uni:
                    out.add(str(s).upper())
    return sorted(out)


def yahoo(sym: str) -> str:
    return INDEX_TICKERS.get(sym) or YAHOO_SYM.get(sym) or f"{sym}.NS"


def fetch(syms: list[str], interval: str, period: str) -> dict[str, pd.DataFrame]:
    out = {}
    for i in range(0, len(syms), 25):
        chunk = syms[i:i + 25]
        tick = {yahoo(s): s for s in chunk}
        for attempt in range(3):
            try:
                df = yf.download(list(tick), period=period, interval=interval, group_by="ticker", auto_adjust=False,
                                 prepost=False, threads=True, progress=False)
                break
            except Exception as e:  # noqa: BLE001
                print(f"  {interval} chunk {i}: {e}", flush=True)
                time.sleep(5 * (attempt + 1))
        else:
            continue
        for t, s in tick.items():
            try:
                g = df[t] if isinstance(df.columns, pd.MultiIndex) else df
            except KeyError:
                continue
            g = g.rename(columns=str.lower)[["open", "high", "low", "close", "volume"]].dropna(subset=["close"])
            if g.empty:
                continue
            idx = g.index.tz_convert("Asia/Kolkata") if g.index.tz is not None else g.index.tz_localize("UTC").tz_convert("Asia/Kolkata")
            g.index = idx.tz_localize(None)
            t_ = g.index.time
            g = g[(t_ >= pd.Timestamp("09:15").time()) & (t_ < pd.Timestamp("15:30").time())]
            g.index.name = "t"
            out[s] = g.astype(float)
        time.sleep(1)
    return out


def merge(old: pd.DataFrame | None, new: pd.DataFrame | None) -> pd.DataFrame | None:
    if old is None:
        return new
    if new is None:
        return old
    # new data wins for the days it covers (Yahoo sometimes revises the last bars of a day)
    days = set(new.index.normalize())
    keep = old[~old.index.normalize().isin(days)]
    return pd.concat([keep, new]).sort_index()


def pack_sym(df: pd.DataFrame, step: int, ndays: int) -> dict:
    """{step, days: [[epochDay, firstBarIndex, c0, dc[], do[], dh[], dl[], v[]], ...]} — prices ×100 as ints:
    close as deltas within the day, open/high/low as offsets from close; bar index = minutes since 09:15 / step"""
    days = []
    dates = sorted(set(df.index.normalize()))[-ndays:]
    for d in dates:
        g = df[df.index.normalize() == d]
        if len(g) < 3:
            continue
        mins = ((g.index - (d + pd.Timedelta(hours=9, minutes=15))).total_seconds() // 60).astype(int)
        bi = (mins // step).to_numpy()
        # put bars on a full grid (missing bars = no trade: flat at the last close, zero volume)
        n = int(bi.max()) + 1 - int(bi[0])
        c = np.full(n, np.nan); o = c.copy(); h = c.copy(); lo = c.copy(); v = np.zeros(n)
        k = bi - bi[0]
        c[k], o[k], h[k], lo[k], v[k] = g["close"], g["open"], g["high"], g["low"], g["volume"].fillna(0)
        c = pd.Series(c).ffill().to_numpy()
        for a in (o, h, lo):
            m = np.isnan(a)
            a[m] = c[m]
        ci = np.round(c * 100).astype(np.int64)
        days.append([int((d - pd.Timestamp("1970-01-01")).days), int(bi[0]), int(ci[0]), np.diff(ci, prepend=ci[0]).tolist(),
                     (np.round(o * 100).astype(np.int64) - ci).tolist(), (np.round(h * 100).astype(np.int64) - ci).tolist(),
                     (np.round(lo * 100).astype(np.int64) - ci).tolist(), np.round(v).astype(np.int64).tolist()])
    return {"step": step, "days": days}


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--prev", default="", help="previous intraday_data.tar (history so far)")
    ap.add_argument("--out", default="build_intra")
    ap.add_argument("--app-days-5m", type=int, default=120)
    ap.add_argument("--app-days-1m", type=int, default=20)
    args = ap.parse_args()
    out = ROOT / args.out
    hist = {"5m": {}, "1m": {}}
    if args.prev and Path(args.prev).exists():
        with tarfile.open(args.prev) as t:
            for m in t.getmembers():
                parts = m.name.split("/")
                if len(parts) == 3 and parts[0] == "hist" and parts[2].endswith(".csv.gz"):
                    df = pd.read_csv(io.BytesIO(gzip.decompress(t.extractfile(m).read())), index_col=0, parse_dates=True)
                    hist[parts[1]][parts[2][:-7]] = df
        print(f"previous history: {len(hist['5m'])} symbols at 5m, {len(hist['1m'])} at 1m", flush=True)
    syms = symbols()
    idx_syms = list(INDEX_TICKERS)
    print(f"fetching {len(syms)} stocks + {len(idx_syms)} indices", flush=True)
    new5 = fetch(syms + idx_syms, "5m", "60d")
    n50 = [s for s, m in json.loads((ROOT / "data" / "universe.json").read_text())["stocks"].items() if m.get("nifty50")]
    new1 = fetch(sorted(set(n50)) + idx_syms, "1m", "7d")
    print(f"got 5m: {len(new5)}, 1m: {len(new1)}", flush=True)
    for k, new in (("5m", new5), ("1m", new1)):
        for s, df in new.items():
            hist[k][s] = merge(hist[k].get(s), df)
    # write history and app bundles
    for k in ("5m", "1m"):
        (out / "hist" / k).mkdir(parents=True, exist_ok=True)
        for s, df in hist[k].items():
            (out / "hist" / k / f"{s}.csv.gz").write_bytes(gzip.compress(df.to_csv(float_format="%.2f").encode()))
    app = out / "app" / "intra"
    app.mkdir(parents=True, exist_ok=True)
    index = {}
    for k, step, nd, cap in (("5m", 5, args.app_days_5m, 3_500_000), ("1m", 1, args.app_days_1m, 3_500_000)):
        cur, size, b = {}, 0, 0

        def flush():
            nonlocal cur, size, b
            if cur:
                key = f"i{step}_{b:02d}"
                (app / f"{key}.json.gz").write_bytes(gzip.compress(json.dumps(cur, separators=(",", ":")).encode(), 9))
                for s in cur:
                    index.setdefault(s, {})[k] = key
                b += 1; cur = {}; size = 0
        for s in sorted(hist[k]):
            p = pack_sym(hist[k][s], step, nd)
            if not p["days"]:
                continue
            z = len(gzip.compress(json.dumps(p, separators=(",", ":")).encode(), 6))
            if cur and size + z > cap:
                flush()
            cur[s] = p; size += z
            d0, d1 = p["days"][0][0], p["days"][-1][0]
            index.setdefault(s, {})[f"{k}_days"] = len(p["days"])
            index[s][f"{k}_first"] = str((pd.Timestamp("1970-01-01") + pd.Timedelta(days=d0)).date())
            index[s][f"{k}_last"] = str((pd.Timestamp("1970-01-01") + pd.Timedelta(days=d1)).date())
            index[s][f"{k}_history_from"] = str(hist[k][s].index[0].date())
        flush()
    last = max((v.get("5m_last", "") for v in index.values()), default="")
    (app / "index.json").write_text(json.dumps({"asof": last, "source": "Yahoo Finance intraday bars (5-minute: last ~60 days when first fetched, kept and extended every day; 1-minute: last ~7 days, kept and extended)",
                                                "symbols": index}, separators=(",", ":")))
    rep = {"asof": last, "symbols": len(index), "5m": len(hist["5m"]), "1m": len(hist["1m"]),
           "fetched_5m": len(new5), "fetched_1m": len(new1), "app_bytes": sum(f.stat().st_size for f in app.glob("*"))}
    (ROOT / "data" / "intraday_bars").mkdir(parents=True, exist_ok=True)
    (ROOT / "data" / "intraday_bars" / "_report.json").write_text(json.dumps(rep, indent=1))
    print(json.dumps(rep), flush=True)


if __name__ == "__main__":
    main()
