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

from .nse_live import NseLive, Quote

IST = ZoneInfo("Asia/Kolkata")
INDEX_TICKERS = {"NIFTY": "^NSEI", "BANKNIFTY": "^NSEBANK", "FINNIFTY": "NIFTY_FIN_SERVICE.NS", "SENSEX": "^BSESN", "INDIAVIX": "^INDIAVIX"}
FIELDS = ["ltp", "open", "high", "low", "prev_close", "value_cr", "ts"]
BRANCH = "live-quotes"


def _hhmm(ts: str) -> str:
    ts = str(ts or "")
    return ts[11:16] if len(ts) >= 16 else ts[:5]


def yahoo_quotes(symbols, prev: dict | None = None, timeout: float = 60) -> dict:
    """Backup prices when NSE's server stops answering (it throttles a busy client for the rest of the day):
    today's 1-minute bars from Yahoo Finance (SYM.NS); the last bar is the price and its time is the quote time,
    so a stale Yahoo price is never mistaken for a fresh one. {SYM: Quote}; empty if Yahoo is unavailable."""
    try:
        import pandas as pd
        import yfinance as yf
    except ImportError:
        return {}
    syms = [s for s in dict.fromkeys(symbols or []) if s and s[0].isalnum()][:600]
    if not syms:
        return {}
    box: dict = {}

    def _dl() -> None:
        try:
            box["df"] = yf.download([s + ".NS" for s in syms], period="1d", interval="1m", group_by="ticker", auto_adjust=False,
                                    prepost=False, threads=True, progress=False, timeout=20)
        except Exception:  # noqa: BLE001
            box["df"] = None

    th = threading.Thread(target=_dl, daemon=True)
    th.start()
    th.join(timeout=timeout)
    df = box.get("df")
    if df is None or getattr(df, "empty", True):
        return {}
    out, today = {}, datetime.now(IST).date()
    multi = isinstance(df.columns, pd.MultiIndex)
    lvl0 = set(df.columns.get_level_values(0)) if multi else set()
    for s in syms:
        tk = s + ".NS"
        try:
            sub = df[tk] if multi and tk in lvl0 else (df if not multi and len(syms) == 1 else None)
            if sub is None:
                continue
            sub = sub.dropna(subset=["Close"])
            if sub.empty:
                continue
            idx = sub.index if sub.index.tz is not None else sub.index.tz_localize("UTC")
            sub = sub.set_axis(idx.tz_convert(IST))
            sub = sub[sub.index.date == today]
            if sub.empty:
                continue
            pc = (prev or {}).get(s) or 0
            out[s] = Quote(s, float(sub["Close"].iloc[-1]), float(sub["Open"].iloc[0]), float(sub["High"].max()), float(sub["Low"].min()),
                           float(pc), float(sub["Volume"].fillna(0).sum()), 0.0, sub.index[-1].strftime("%Y-%m-%d %H:%M:%S"))
        except Exception:  # noqa: BLE001 — one bad ticker never spoils the rest
            continue
    return out


def _yahoo_today() -> dict:
    """{SYM: (today's 1-minute bars as a DataFrame indexed by IST time, previous close or None)} from Yahoo (empty if unavailable)"""
    try:
        import pandas as pd
        import yfinance as yf
    except ImportError:
        return {}
    box: dict = {}

    def _dl() -> None:
        try:
            box["df"] = yf.download(list(INDEX_TICKERS.values()), period="5d", interval="1m", group_by="ticker", auto_adjust=False,
                                    prepost=False, threads=True, progress=False, timeout=20)
        except Exception:  # noqa: BLE001
            box["df"] = None

    th = threading.Thread(target=_dl, daemon=True)  # Yahoo can hang; never let it freeze the live feed
    th.start()
    th.join(timeout=45)
    df = box.get("df")
    if df is None or df.empty:
        return {}
    out = {}
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
        prev = g[idx.date == days[-2]]["close"].iloc[-1] if len(days) > 1 else None
        out[sym] = (g[idx.date == days[-1]], float(prev) if prev is not None and pd.notna(prev) else None)
    return out


def index_quotes(yd: dict | None = None) -> dict:
    """{SYM: [ltp, open, high, low, prev_close, None, "HH:MM"]} from Yahoo 1-minute bars (empty if unavailable)."""
    yd = _yahoo_today() if yd is None else yd
    out = {}
    for sym, (today, prev) in yd.items():
        out[sym] = [round(float(today["close"].iloc[-1]), 2), round(float(today["open"].iloc[0]), 2), round(float(today["high"].max()), 2),
                    round(float(today["low"].min()), 2), round(prev, 2) if prev is not None else None, None,
                    today.index[-1].strftime("%H:%M")]
    return out


def index_bars(yd: dict, date: str) -> dict:
    """{SYM: [[m, o, h, l, c, None], ...]} today's 1-minute index bars from Yahoo (m = minutes after 09:15)"""
    out = {}
    for sym, (today, _prev) in yd.items():
        rows = []
        for t, r in today.iterrows():
            if t.date().isoformat() != date:
                continue
            m = t.hour * 60 + t.minute - 555
            if 0 <= m < 375:
                rows.append([m, round(float(r["open"]), 2), round(float(r["high"]), 2), round(float(r["low"]), 2), round(float(r["close"]), 2), None])
        if rows:
            out[sym] = rows
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
    def __init__(self, root: Path, every_min: float = 5, push: bool = True, bars=None, backup_syms: list | None = None):
        self.root, self.every, self.push = root.resolve(), every_min * 60, push
        self.backup_syms = list(backup_syms or [])  # Yahoo fills these when NSE answers for too few stocks
        self.nse_down = False  # set by the runner while NSE isn't answering
        self.bars = bars  # minute_bars.MinuteBars kept by the runner (published with each snapshot as bars_1m.json.gz)
        self.dir = self.root / "live"
        self.dir.mkdir(parents=True, exist_ok=True)
        self.live = NseLive()
        self.last = 0.0
        self.thread: threading.Thread | None = None
        self.count = 0
        self.last_doc: dict | None = None  # the latest full snapshot (indices come from it in the minute updates)
        self.qthread: threading.Thread | None = None

    HUNG_S = 240  # a full snapshot still running after this long is treated as hung: the next one starts anyway

    def _busy(self) -> bool:
        return bool(self.thread and self.thread.is_alive() and time.monotonic() - self.last < self.HUNG_S)

    def due(self) -> bool:
        return time.monotonic() - self.last >= self.every and not self._busy()

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
        q, upd = {}, None
        if not self.nse_down:  # while NSE isn't answering the runner, don't spend minutes waiting on it here
            try:
                q, upd = self.live.quotes(None, budget=90)
            except Exception as e:  # noqa: BLE001
                print(f"live feed: NSE snapshot failed: {e}", flush=True)
        if len(q) < 1000 and self.backup_syms:  # NSE is throttling us: Yahoo for the main stocks, NSE's prices win where present
            prev = {s: v[4] for s, v in ((self.last_doc or {}).get("quotes") or {}).items() if v and len(v) > 4}
            yq = yahoo_quotes([s for s in self.backup_syms if s not in q], prev, timeout=150)
            print(f"live feed: NSE gave {len(q)} stocks; Yahoo backup {len(yq)}", flush=True)
            q = {**yq, **q}
        if not q:
            print("live feed: no quotes this time", flush=True)
            return None
        if self.last_doc and self.last_doc.get("date") == now.date().isoformat():  # keep today's earlier prices for names not refreshed
            q = {**{s: Quote(s, *(v[i] or 0 for i in range(5)), 0.0, float(v[5] or 0), f"{now.date()} {v[6]}:00") for s, v in (self.last_doc.get("quotes") or {}).items() if v and v[0]}, **q}
        doc = {"asof": now.isoformat(), "nse_updated": upd, "date": now.date().isoformat(),
               "source": "NSE live data (1-3 min behind; informational) + Yahoo Finance for indices", "fields": FIELDS,
               "quotes": {s: [x.ltp, x.open or None, x.high or None, x.low or None, x.prev_close or None, round(x.value_cr, 2) if x.value_cr else None, _hhmm(x.ts)]
                          for s, x in sorted(q.items())},
               "indices": index_quotes(yd := _yahoo_today()),
               "nse_indices": nse_index_quotes(self.live)}
        self.last_doc = doc
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
        if self.bars is not None:
            try:
                self.bars.extra = index_bars(yd, doc["date"])
                self.bars.save(self.dir / "bars_1m.json.gz", doc["asof"])
            except Exception as e:  # noqa: BLE001
                print(f"live feed: minute bars not saved: {e}", flush=True)
        print(f"live feed: {len(doc['quotes'])} stocks, {len(doc['indices'])} + {len(doc['nse_indices'])} NSE indices at {now:%H:%M} (NSE {upd})", flush=True)
        if self.count <= 1:
            print(f"::notice::first full snapshot: {len(doc['quotes'])} stocks at {now:%H:%M}", flush=True)
        if self.push:
            self.publish(doc["date"])
        return doc

    def quick(self, seen: dict) -> bool:
        """Minute update between full snapshots: the runner's own once-a-minute poll (every first letter, every NSE stock)
        replaces the stock prices in quotes.json and the branch is pushed again (history and minute bars stay on the
        5-minute cadence). Lets the continuous agent runner decide on prices at most ~1-2 minutes old. Never blocks."""
        # a slow or hung full snapshot no longer stops the minute updates (only a push still in flight does)
        if not seen or not self.last_doc or (self.qthread and self.qthread.is_alive()):
            return False
        now = datetime.now(IST).replace(microsecond=0)
        if self.last_doc.get("date") != now.date().isoformat():
            return False
        quotes = dict(self.last_doc.get("quotes") or {})
        n = 0
        for s, x in seen.items():
            if not x.ltp:
                continue
            quotes[s] = [x.ltp, x.open or None, x.high or None, x.low or None, x.prev_close or None, round(x.value_cr, 2) if x.value_cr else None, _hhmm(x.ts)]
            n += 1
        doc = {**self.last_doc, "asof": now.isoformat(), "kind": "minute", "full_asof": self.last_doc.get("full_asof") or self.last_doc.get("asof"), "quotes": dict(sorted(quotes.items()))}
        self.last_doc = {**self.last_doc, "quotes": doc["quotes"], "full_asof": doc["full_asof"]}  # keep each minute's prices (letters rotate)
        (self.dir / "quotes.json").write_text(json.dumps(doc, separators=(",", ":")))
        if self.push:
            self.qthread = threading.Thread(target=self.publish, args=(doc["date"],), daemon=True)
            self.qthread.start()
        return n > 0

    def restore(self, date: str) -> None:
        """a resumed run (6-hour hand-off) picks up today's history from the branch"""
        try:
            subprocess.run(["git", "-C", str(self.root), "fetch", "-q", "--depth", "1", "origin", f"refs/heads/{BRANCH}"], check=True, capture_output=True, timeout=60)
            data = subprocess.run(["git", "-C", str(self.root), "show", f"FETCH_HEAD:history_{date}.csv.gz"], check=True, capture_output=True, timeout=60).stdout
            try:  # the last published prices, so minute updates can go out before the first new full snapshot
                qd = json.loads(subprocess.run(["git", "-C", str(self.root), "show", "FETCH_HEAD:quotes.json"], check=True, capture_output=True, timeout=60).stdout)
                if qd.get("date") == date:
                    self.last_doc = qd
                    print(f"live feed: resumed the last prices ({len(qd.get('quotes') or {})} stocks, {qd.get('asof')})", flush=True)
            except (subprocess.SubprocessError, OSError, ValueError):
                pass
            if data:
                (self.dir / f"history_{date}.csv.gz").write_bytes(data)
                print(f"live feed: resumed today's history ({len(data) / 1e6:.1f} MB)", flush=True)
            if self.bars is not None:
                b = subprocess.run(["git", "-C", str(self.root), "show", "FETCH_HEAD:bars_1m.json.gz"], capture_output=True, timeout=60).stdout
                if b:
                    (self.dir / "bars_1m.json.gz").write_bytes(b)
                    print(f"live feed: resumed today's minute bars: {self.bars.load(self.dir / 'bars_1m.json.gz')}", flush=True)
        except (subprocess.SubprocessError, OSError):
            pass

    def publish(self, date: str) -> None:
        """replace the live-quotes branch with one commit holding quotes.json and today's history (no working-tree changes)"""
        g = ["git", "-C", str(self.root)]
        try:
            entries = []
            for name in ("quotes.json", f"history_{date}.csv.gz", "bars_1m.json.gz"):
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
            print(f"::warning::live feed push failed: {str(err)[:300]}", flush=True)
