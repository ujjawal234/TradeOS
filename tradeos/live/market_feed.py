"""Near-live prices for every NSE stock and the main indices, every few minutes during the session.

Run inside the intraday runner (scripts/intraday_run.py) on GitHub Actions, in its own thread so the runner's
one-minute polls are never delayed:
  - stocks: NSE's official live data (NseLive.quotes(None): one call per first letter, every EQ stock), 1-3 minutes
    behind the market, informational use only;
  - indices (NIFTY, BANKNIFTY, FINNIFTY, SENSEX, INDIAVIX): Yahoo Finance 1-minute bars, when yfinance is installed.

Each snapshot is written to live/quotes.json (the latest prices) and appended to live/history_<date>.csv.gz (every
snapshot of the day, with timestamps), and both files are pushed as the only commit of the `live-quotes` branch
(replaced each time, so the branch never grows; the day's history is uploaded to the `live-quotes` release after the
close by .github/workflows/intraday.yml). The app reads live/quotes.json (through the team's GitHub connector, and
from its database, which the "TradeOS live prices" scheduled task refreshes during the session).

quotes.json: {"asof": "YYYY-MM-DDTHH:MM:SS+05:30" (when this snapshot was taken), "nse_updated": NSE's crawl time,
              "date": session date, "source", "fields": ["ltp","open","high","low","prev_close","value_cr","ts"],
              "quotes": {SYM: [ltp, open, high, low, prev_close, value_cr, "HH:MM"]}, "indices": {SYM: [...same...]},
              "nse_indices": {NSE live index name: [...same...]} (every NSE index, from NSE's cm_get_live_indices)}
Paper trading and research only.
"""
from __future__ import annotations

import gzip
import io
import json
import subprocess
import threading
import time
from datetime import datetime
from pathlib import Path
from zoneinfo import ZoneInfo

from .nse_live import NseLive

IST = ZoneInfo("Asia/Kolkata")
INDEX_TICKERS = {"NIFTY": "^NSEI", "BANKNIFTY": "^NSEBANK", "FINNIFTY": "NIFTY_FIN_SERVICE.NS", "SENSEX": "^BSESN", "INDIAVIX": "^INDIAVIX"}
FIELDS = ["ltp", "open", "high", "low", "prev_close", "value_cr", "ts"]
BRANCH = "live-quotes"


def _hhmm(ts: str) -> str:
    ts = str(ts or "")
    return ts[11:16] if len(ts) >= 16 else ts[:5]


def index_quotes() -> dict:
    """{SYM: [ltp, open, high, low, prev_close, None, "HH:MM"]} from Yahoo 1-minute bars (empty if unavailable)."""
    try:
        import pandas as pd
        import yfinance as yf
    except ImportError:
        return {}
    out = {}
    try:
        df = yf.download(list(INDEX_TICKERS.values()), period="5d", interval="1m", group_by="ticker", auto_adjust=False,
                         prepost=False, threads=True, progress=False)
    except Exception:  # noqa: BLE001
        return {}
    if df is None or df.empty:
        return {}
    for sym, t in INDEX_TICKERS.items():
        try:
            g = df[t].rename(columns=str.lower)[["open", "high", "low", "close"]].dropna(subset=["close"])
        except KeyError:
            continue
        if g.empty:
            continue
        idx = g.index.tz_convert(IST) if g.index.tz is not None else g.index.tz_localize("UTC").tz_convert(IST)
        g.index = idx
        days = sorted(set(idx.date))
        today = g[idx.date == days[-1]]
        prev = g[idx.date == days[-2]]["close"].iloc[-1] if len(days) > 1 else None
        out[sym] = [round(float(today["close"].iloc[-1]), 2), round(float(today["open"].iloc[0]), 2), round(float(today["high"].max()), 2),
                    round(float(today["low"].min()), 2), round(float(prev), 2) if prev is not None and pd.notna(prev) else None, None,
                    today.index[-1].strftime("%H:%M")]
    return out


def nse_index_quotes(live: NseLive) -> dict:
    """{NSE live index name: [last, open, high, low, prev_close, None, "HH:MM"]} for every NSE index (~140), from NSE's
    own live data (cm_get_live_indices). Consumers map the names to TradeOS symbols (lab/engine.js nseIndexKey)."""
    try:
        d = live.call("cm_get_live_indices", {"group": "", "nameFilter": ""})
    except Exception as e:  # noqa: BLE001
        print(f"live feed: NSE indices failed: {e}", flush=True)
        return {}
    out = {}
    for rows in (d.get("indices") or {}).values():
        for r in rows or []:
            if r.get("last") is None:
                continue
            tv = str(r.get("timeVal") or d.get("nseTimestamp") or "")
            out[r["indexName"]] = [r.get("last"), r.get("open"), r.get("high"), r.get("low"), r.get("previousClose"), None, tv[12:17] if len(tv) >= 17 else tv]
    return out


class MarketFeed:
    def __init__(self, root: Path, every_min: float = 5, push: bool = True):
        self.root, self.every, self.push = root.resolve(), every_min * 60, push
        self.dir = self.root / "live"
        self.dir.mkdir(parents=True, exist_ok=True)
        self.live = NseLive()
        self.last = 0.0
        self.thread: threading.Thread | None = None
        self.count = 0

    def due(self) -> bool:
        return time.monotonic() - self.last >= self.every and not (self.thread and self.thread.is_alive())

    def start(self) -> None:
        """take a snapshot in the background (never blocks the caller)"""
        self.last = time.monotonic()
        self.thread = threading.Thread(target=self._run, daemon=True)
        self.thread.start()

    def _run(self) -> None:
        try:
            self.snapshot()
        except Exception as e:  # noqa: BLE001 — a failed snapshot must never stop the trading loop
            print(f"live feed: snapshot failed: {e}", flush=True)

    def snapshot(self) -> dict | None:
        now = datetime.now(IST).replace(microsecond=0)
        q, upd = self.live.quotes(None, budget=90)
        if not q:
            print("live feed: no quotes this time", flush=True)
            return None
        doc = {"asof": now.isoformat(), "nse_updated": upd, "date": now.date().isoformat(),
               "source": "NSE live data (1-3 min behind; informational) + Yahoo Finance for indices", "fields": FIELDS,
               "quotes": {s: [x.ltp, x.open or None, x.high or None, x.low or None, x.prev_close or None, round(x.value_cr, 2) if x.value_cr else None, _hhmm(x.ts)]
                          for s, x in sorted(q.items())},
               "indices": index_quotes(),
               "nse_indices": nse_index_quotes(self.live)}
        (self.dir / "quotes.json").write_text(json.dumps(doc, separators=(",", ":")))
        hist = self.dir / f"history_{doc['date']}.csv.gz"
        rows = io.StringIO()
        if not hist.exists():
            rows.write("asof,sym,ltp,open,high,low,prev_close,value_cr,ts\n")
        for s, v in list(doc["quotes"].items()) + list(doc["indices"].items()):
            rows.write(",".join([doc["asof"], s] + ["" if x is None else str(x) for x in v]) + "\n")
        with gzip.open(hist, "at") as f:  # gzip members append; readers see one file
            f.write(rows.getvalue())
        self.count += 1
        print(f"live feed: {len(doc['quotes'])} stocks, {len(doc['indices'])} + {len(doc['nse_indices'])} NSE indices at {now:%H:%M} (NSE {upd})", flush=True)
        if self.push:
            self.publish(doc["date"])
        return doc

    def restore(self, date: str) -> None:
        """a resumed run (6-hour hand-off) picks up today's history from the branch"""
        try:
            subprocess.run(["git", "-C", str(self.root), "fetch", "-q", "--depth", "1", "origin", BRANCH], check=True, capture_output=True, timeout=60)
            data = subprocess.run(["git", "-C", str(self.root), "show", f"FETCH_HEAD:history_{date}.csv.gz"], check=True, capture_output=True, timeout=60).stdout
            if data:
                (self.dir / f"history_{date}.csv.gz").write_bytes(data)
                print(f"live feed: resumed today's history ({len(data) / 1e6:.1f} MB)", flush=True)
        except (subprocess.SubprocessError, OSError):
            pass

    def publish(self, date: str) -> None:
        """replace the live-quotes branch with one commit holding quotes.json and today's history (no working-tree changes)"""
        g = ["git", "-C", str(self.root)]
        try:
            entries = []
            for name in ("quotes.json", f"history_{date}.csv.gz"):
                f = self.dir / name
                if f.exists():
                    sha = subprocess.run(g + ["hash-object", "-w", str(f)], check=True, capture_output=True, text=True, timeout=60).stdout.strip()
                    entries.append(f"100644 blob {sha}\t{name}\n")
            tree = subprocess.run(g + ["mktree"], input="".join(entries), check=True, capture_output=True, text=True, timeout=60).stdout.strip()
            commit = subprocess.run(g + ["-c", "user.name=tradeos-bot", "-c", "user.email=tradeos-bot@users.noreply.github.com",
                                         "commit-tree", tree, "-m", f"live quotes {datetime.now(IST):%Y-%m-%d %H:%M} IST"],
                                    check=True, capture_output=True, text=True, timeout=60).stdout.strip()
            subprocess.run(g + ["push", "-q", "-f", "origin", f"{commit}:refs/heads/{BRANCH}"], check=True, capture_output=True, text=True, timeout=120)
        except (subprocess.SubprocessError, OSError) as e:
            err = getattr(e, "stderr", "") or ""
            print(f"live feed: push failed: {e} {str(err)[:200]}", flush=True)
