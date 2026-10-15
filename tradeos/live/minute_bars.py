"""Today's 1-minute bars for every NSE stock the intraday runner sees, built from its once-a-minute polls.

NSE's live data (cm_get_equity_stocks) gives each stock's last price, the day's open/high/low so far, cumulative volume
and the last-trade time — not candles. Polled once a minute, that is enough to build 1-minute bars:
  - the bar's minute is NSE's last-trade time (HH:MM), not the poll time;
  - open/close are the first/last price seen in that minute, high/low widen with every price seen, and when the day's
    high (low) moved up (down) since the previous poll the new extreme happened in this minute, so it goes into the bar;
  - volume is the change in the day's cumulative volume since the previous poll (the first poll of a stock adds none).
Indices come from Yahoo's 1-minute bars (market_feed.index_bars), which are real candles.

The bars go to bars_1m.json.gz on the live-quotes branch with every 5-minute snapshot (market_feed.MarketFeed.publish):
  {"date": "YYYY-MM-DD", "asof": ISO time, "t0": "09:15", "fields": ["m","o","h","l","c","v"],
   "bars": {SYM: [[m, o, h, l, c, v], ...]}}   m = minutes after 09:15 (0 = the 09:15 bar), v = shares (null for indices)
Paper trading and research only.
"""
from __future__ import annotations

import gzip
import json
import threading
from pathlib import Path

SESSION_MINUTES = 375  # 09:15 .. 15:29


def minute_of(ts: str) -> int | None:
    """NSE time "YYYY-MM-DD HH:MM:SS" (or "HH:MM") -> minutes after 09:15, None outside the session"""
    ts = str(ts or "")
    hhmm = ts[11:16] if len(ts) >= 16 else ts[:5]
    try:
        h, m = int(hhmm[:2]), int(hhmm[3:5])
    except ValueError:
        return None
    k = h * 60 + m - 555
    return k if 0 <= k < SESSION_MINUTES else None


class MinuteBars:
    def __init__(self, date: str):
        self.date = date
        self.bars: dict[str, dict[int, list]] = {}     # sym -> {m: [o, h, l, c, v]}
        self.prev: dict[str, tuple] = {}                # sym -> (day high, day low, cum volume) at the last poll
        self.extra: dict[str, list] = {}                # indices etc. given as finished bars: sym -> [[m,o,h,l,c,v]]
        self.lock = threading.Lock()                    # the feed thread saves while the runner adds

    def add(self, quotes: dict) -> int:
        """quotes: {sym: Quote}; returns how many bars changed"""
        with self.lock:
            return self._add(quotes)

    def _add(self, quotes: dict) -> int:
        n = 0
        for sym, q in quotes.items():
            ts = str(getattr(q, "ts", "") or "")
            if len(ts) >= 10 and ts[:10] != self.date:
                continue  # yesterday's last trade (stock not traded yet today)
            m = minute_of(ts)
            ltp = float(getattr(q, "ltp", 0) or 0)
            if m is None or ltp <= 0:
                continue
            hi, lo, vol = float(q.high or 0), float(q.low or 0), float(q.volume or 0)
            p = self.prev.get(sym)
            day = self.bars.setdefault(sym, {})
            b = day.get(m)
            if b is None:
                b = day[m] = [ltp, ltp, ltp, ltp, 0.0]
            b[1], b[2], b[3] = max(b[1], ltp), min(b[2], ltp), ltp
            if p is not None:
                if hi > 0 and p[0] > 0 and hi > p[0]:
                    b[1] = max(b[1], hi)
                if lo > 0 and p[1] > 0 and lo < p[1]:
                    b[2] = min(b[2], lo)
                if vol > p[2]:
                    b[4] += vol - p[2]
            self.prev[sym] = (hi or (p[0] if p else 0), lo or (p[1] if p else 0), max(vol, p[2] if p else 0))
            n += 1
        return n

    def doc(self, asof: str = "") -> dict:
        with self.lock:
            return self._doc(asof)

    def _doc(self, asof: str) -> dict:
        out = {}
        for sym, day in self.bars.items():
            if day:
                out[sym] = [[m, round(b[0], 2), round(b[1], 2), round(b[2], 2), round(b[3], 2), int(b[4])] for m, b in sorted(day.items())]
        for sym, rows in self.extra.items():
            out[sym] = rows
        return {"date": self.date, "asof": asof, "t0": "09:15", "fields": ["m", "o", "h", "l", "c", "v"], "bars": out}

    def save(self, path: Path, asof: str = "") -> None:
        path.write_bytes(gzip.compress(json.dumps(self.doc(asof), separators=(",", ":")).encode(), compresslevel=6))

    def load(self, path: Path) -> bool:
        """resume today's bars (a 6-hour hand-off); the next poll of each stock adds no volume, as on a first poll"""
        try:
            d = json.loads(gzip.decompress(path.read_bytes()))
        except (OSError, ValueError, EOFError):
            return False
        if d.get("date") != self.date:
            return False
        for sym, rows in (d.get("bars") or {}).items():
            if rows and rows[0][5] is None:
                continue  # indices are rebuilt from Yahoo
            self.bars[sym] = {int(r[0]): [r[1], r[2], r[3], r[4], float(r[5] or 0)] for r in rows}
        return True
