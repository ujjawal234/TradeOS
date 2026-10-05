"""Intraday paper trading on minute snapshots (NSE live data, ~1 minute apart, 1-3 minutes behind the market).

Pieces:
* TickStore      every snapshot of the day per symbol; builds N-minute OHLCV bars from them
* IntradayRules  the normal rule language (tradeos/rules.py) plus intraday variables (vwap, or_high, minutes ...)
* IntradayAgent  one strategy: entries/exits on completed bars, stops/targets checked on every snapshot,
                 forced square-off before the close. Paper money only.
* Session        runs all agents for one day; the same code serves live polling and replay of saved data.

Bars: a snapshot carries the last price, the day's high/low so far and cumulative volume/turnover. A bar's high
also counts a rise in the day high since the previous snapshot (the price went there between snapshots), its
volume is the change in cumulative volume, and vwap is NSE's own day VWAP (turnover / volume).
"""
from __future__ import annotations

import json
import math
import subprocess
from dataclasses import asdict, dataclass, field
from datetime import time as dtime

import numpy as np
import pandas as pd

from pathlib import Path

from ..rules import RuleEngine, RuleError

OPEN_T, CLOSE_T = dtime(9, 15), dtime(15, 30)
INTRADAY_VARS = {
    "vwap": "NSE day VWAP so far", "day_open": "today's open", "prev_close": "yesterday's close",
    "day_high": "day high so far", "day_low": "day low so far",
    "or_high": "opening-range high (first opening_range_minutes; NaN until it completes)", "or_low": "opening-range low",
    "minutes": "minutes since 09:15 at the bar's end", "day_ret": "% change vs yesterday's close",
}


def tm(s: str) -> dtime:
    h, m = str(s).split(":")[:2]
    return dtime(int(h), int(m))


def day_open(day: pd.Timestamp) -> pd.Timestamp:
    return pd.Timestamp(day).normalize() + pd.Timedelta(hours=9, minutes=15)


# ------------------------------------------------------------------------------------------------ ticks and bars
COLS = ["polled", "sym", "ts", "ltp", "open", "high", "low", "prev_close", "volume", "value_cr"]


class TickStore:
    def __init__(self, day: pd.Timestamp):
        self.day = pd.Timestamp(day).normalize()
        self.rows: list[tuple] = []
        self.by_sym: dict[str, list] = {}
        self.last: dict[str, tuple] = {}

    def add(self, polled: pd.Timestamp, q) -> bool:
        """Store a snapshot if it carries something new (a new trade time, price or volume)."""
        ts = pd.Timestamp(q.ts) if q.ts else None
        if ts is None or ts.normalize() != self.day:
            return False  # yesterday's close (pre-open / holiday) or no timestamp
        key = (ts, q.ltp, q.volume)
        if self.last.get(q.symbol) == key:
            return False
        self.last[q.symbol] = key
        row = (polled, q.symbol, ts, q.ltp, q.open, q.high, q.low, q.prev_close, q.volume, q.value_cr)
        self.rows.append(row)
        self.by_sym.setdefault(q.symbol, []).append(row)
        return True

    def frame(self) -> pd.DataFrame:
        return pd.DataFrame(self.rows, columns=COLS)

    @classmethod
    def from_frame(cls, day, df: pd.DataFrame) -> "TickStore":
        st = cls(day)
        df = df.copy()
        df["polled"], df["ts"] = pd.to_datetime(df["polled"]), pd.to_datetime(df["ts"])
        for r in df[COLS].itertuples(index=False):
            st.rows.append(tuple(r))
            st.by_sym.setdefault(r.sym, []).append(tuple(r))
            st.last[r.sym] = (pd.Timestamp(r.ts), r.ltp, r.volume)
        return st

    def clock(self) -> pd.Timestamp | None:
        """The data's own time: the latest trade time seen (NSE data runs 1-3 minutes behind real time)."""
        return max((k[0] for k in self.last.values()), default=None)

    def bars(self, sym: str, minutes: int, upto: pd.Timestamp) -> pd.DataFrame:
        """Completed `minutes`-bars of `sym` (bar start index) whose end is <= upto."""
        t = self.by_sym.get(sym, [])
        if not t:
            return pd.DataFrame(columns=["open", "high", "low", "close", "volume", "vwap", "day_open", "prev_close", "day_high", "day_low"])
        df = pd.DataFrame(t, columns=COLS).sort_values("ts", kind="stable")
        o0, step = day_open(self.day), pd.Timedelta(minutes=minutes)
        ts = df["ts"].clip(lower=o0)  # pre-open auction trades belong to the first bar
        df["b"] = o0 + ((ts - o0) // step) * step
        first_is_open = df["b"].iloc[0] == o0
        rise = df["high"] > df["high"].shift(1)
        fall = df["low"] < df["low"].shift(1)
        if first_is_open:  # the day high/low at the first snapshot happened inside the first bar
            rise.iloc[0] = fall.iloc[0] = True
        df["hi"] = np.where(rise, np.maximum(df["high"], df["ltp"]), df["ltp"])
        df["lo"] = np.where(fall, np.minimum(df["low"], df["ltp"]), df["ltp"])
        g = df.groupby("b", sort=True)
        bars = pd.DataFrame({"open": g["ltp"].first(), "high": g["hi"].max(), "low": g["lo"].min(), "close": g["ltp"].last(),
                             "cumvol": g["volume"].last(), "value": g["value_cr"].last(), "day_open": g["open"].last(),
                             "prev_close": g["prev_close"].last(), "day_high": g["high"].last(), "day_low": g["low"].last()})
        last_start = upto - step  # last bar that has ended by `upto`
        bars = bars[bars.index <= last_start]
        if bars.empty:
            return bars
        full = pd.date_range(bars.index[0], max(bars.index[-1], o0 + ((last_start - o0) // step) * step), freq=step)
        bars = bars.reindex(full)
        bars["close"] = bars["close"].ffill()
        for c in ("open", "high", "low"):
            bars[c] = bars[c].fillna(bars["close"])
        for c in ("cumvol", "value", "day_open", "prev_close", "day_high", "day_low"):
            bars[c] = bars[c].ffill()
        vol = bars["cumvol"].diff()
        vol.iloc[0] = bars["cumvol"].iloc[0] if first_is_open else 0.0
        bars["volume"] = vol.clip(lower=0).fillna(0.0)
        bars["vwap"] = np.where(bars["cumvol"] > 0, bars["value"] * 1e7 / bars["cumvol"], np.nan)
        return bars.drop(columns=["cumvol", "value"])


# ------------------------------------------------------------------------------------------------ rules
class IntradayRules(RuleEngine):
    def __init__(self, bars: pd.DataFrame, minutes: int, or_minutes: int = 15):
        super().__init__(bars)
        idx = bars.index
        for k in ("vwap", "day_open", "prev_close", "day_high", "day_low"):
            self.vars[k] = bars[k].astype(float) if k in bars else pd.Series(np.nan, index=idx)
        o0 = day_open(idx[0]) if len(idx) else None
        end = idx + pd.Timedelta(minutes=minutes)
        self.vars["minutes"] = pd.Series(((end - o0).total_seconds() / 60.0) if len(idx) else [], index=idx, dtype=float)
        orng = bars[end <= o0 + pd.Timedelta(minutes=or_minutes)] if len(idx) else bars
        done = end >= o0 + pd.Timedelta(minutes=or_minutes) if len(idx) else []
        hi = float(orng["high"].max()) if len(orng) else np.nan
        lo = float(orng["low"].min()) if len(orng) else np.nan
        self.vars["or_high"] = pd.Series(np.where(done, hi, np.nan), index=idx, dtype=float)
        self.vars["or_low"] = pd.Series(np.where(done, lo, np.nan), index=idx, dtype=float)
        pc = self.vars["prev_close"]
        self.vars["day_ret"] = (bars["close"] / pc - 1) * 100 if "close" in bars else pd.Series(np.nan, index=idx)


def sample_bars(n: int = 60, minutes: int = 5) -> pd.DataFrame:
    rng = np.random.default_rng(1)
    c = 1000 * np.exp(np.cumsum(rng.normal(0, 0.002, n)))
    idx = pd.date_range(day_open(pd.Timestamp("2026-01-05")), periods=n, freq=f"{minutes}min")
    return pd.DataFrame({"open": c, "high": c * 1.001, "low": c * 0.999, "close": c, "volume": 1000.0, "vwap": c,
                         "day_open": c[0], "prev_close": c[0], "day_high": np.maximum.accumulate(c), "day_low": np.minimum.accumulate(c)}, index=idx)


def validate_intraday(expr: str, minutes: int = 5) -> None:
    IntradayRules(sample_bars(minutes=minutes), minutes).condition(expr)


# ------------------------------------------------------------------------------------------------ app engine bridge
class JsRules:
    """Evaluates rules with the app's engine (lab/engine.js, via scripts/intraday_eval.mjs) — used by agents built in the
    app ("engine": "js"), so the live runner trades exactly the rules that were backtested there (same functions,
    intraday variables, ref() and vix as of yesterday's close)."""
    _proc = None

    @classmethod
    def proc(cls):
        if cls._proc is None or cls._proc.poll() is not None:
            script = Path(__file__).resolve().parents[2] / "scripts" / "intraday_eval.mjs"
            cls._proc = subprocess.Popen(["node", str(script)], stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True, bufsize=1)
        return cls._proc

    @classmethod
    def last_values(cls, bars_by_sym: dict, minutes: int, or_minutes: int, exprs: dict) -> dict:
        """{sym: {"entry": 0|1, "exit": 0|1, "rank_by": float|None}} at each symbol's last bar"""
        bars = {}
        for sym, b in bars_by_sym.items():
            if not len(b):
                continue
            o0 = day_open(b.index[0])
            k = ((b.index - o0).total_seconds() // 60 // minutes).astype(int).tolist()
            col = lambda c: [None if (x is None or (isinstance(x, float) and math.isnan(x))) else float(x) for x in (b[c] if c in b else [np.nan] * len(b))]  # noqa: E731
            bars[sym] = {"k": k, **{c[0] if c in ("open", "high", "low", "close", "volume") else c: col(c)
                                    for c in ("open", "high", "low", "close", "volume", "vwap", "day_open", "prev_close", "day_high", "day_low")}}
        if not bars:
            return {}
        p = cls.proc()
        p.stdin.write(json.dumps({"m": minutes, "or": or_minutes, "exprs": {k: v for k, v in exprs.items() if v}, "bars": bars}) + "\n")
        p.stdin.flush()
        r = json.loads(p.stdout.readline() or '{"ok": false, "error": "rule engine stopped"}')
        if not r.get("ok"):
            raise RuleError(r.get("error", "rule engine error"))
        return r["out"]


# ------------------------------------------------------------------------------------------------ agents
DEFAULTS = {"bar_minutes": 5, "side": "long", "exit": "", "opening_range_minutes": 15, "stop_loss_pct": None,
            "target_pct": None, "trailing_stop_pct": None, "capital": 1_000_000, "max_positions": 4, "position_pct": 25,
            "start_after": "09:30", "no_entry_after": "14:45", "square_off": "15:15", "max_trades_per_symbol": 1,
            "cost_pct": 0.03, "slippage_pct": 0.02, "rank_by": "", "enabled": True}


@dataclass
class Position:
    sym: str
    qty: int            # negative = short
    entry: float
    t_entry: str
    stop: float | None
    target: float | None
    best: float         # best price since entry (for trailing stops)
    hi_seen: float      # day high/low when last checked, to catch moves between snapshots
    lo_seen: float


@dataclass
class AgentState:
    positions: dict = field(default_factory=dict)
    trades: list = field(default_factory=list)
    realized: float = 0.0
    entries: dict = field(default_factory=dict)   # sym -> trades opened today
    last_bar: str | None = None
    squared_off: bool = False


def resolve_symbols(spec_syms, universe: dict) -> list[str]:
    out = []
    for s in spec_syms if isinstance(spec_syms, list) else [spec_syms]:
        key = str(s).lower()
        if key in ("nifty50", "nifty200", "nifty500", "fno"):
            out += sorted(k for k, v in universe.items() if v.get(key))
        else:
            out.append(str(s).upper())
    return list(dict.fromkeys(out))


class IntradayAgent:
    def __init__(self, spec: dict, universe: dict, state: dict | None = None):
        self.spec = {**DEFAULTS, **spec}
        sp = self.spec
        self.id, self.name = sp["id"], sp.get("name", sp["id"])
        self.symbols = resolve_symbols(sp["symbols"], universe)
        self.m = int(sp["bar_minutes"])
        self.short = sp["side"] == "short"
        self.js = sp.get("engine") == "js"
        for k in ("entry", "exit", "rank_by"):
            if sp.get(k) and not self.js:
                validate_intraday(sp[k], self.m)
        if not sp.get("entry"):
            raise RuleError(f"{self.id}: entry rule is required")
        st = state or {}
        self.st = AgentState(**{k: v for k, v in st.items() if k != "positions"})
        self.st.positions = {s: Position(**p) for s, p in (st.get("positions") or {}).items()}
        self.msgs: list[str] = []

    # ---------------------------------------------------------------- helpers
    def state_dict(self) -> dict:
        d = asdict(self.st)
        d["positions"] = {s: asdict(p) for s, p in self.st.positions.items()}
        return d

    def _fees(self, notional: float) -> float:
        return abs(notional) * self.spec["cost_pct"] / 100

    def _slip(self, price: float, buying: bool) -> float:
        k = self.spec["slippage_pct"] / 100
        return price * (1 + k) if buying else price * (1 - k)

    def _open(self, sym: str, q, t: pd.Timestamp, why: str) -> None:
        sp = self.spec
        used = sum(abs(p.qty) * p.entry for p in self.st.positions.values())
        budget = min(sp["capital"] * sp["position_pct"] / 100, sp["capital"] - used)
        price = self._slip(q.ltp, buying=not self.short)
        qty = int(budget // price)
        if qty < 1:
            return
        sl, tg = sp.get("stop_loss_pct"), sp.get("target_pct")
        sgn = -1 if self.short else 1
        stop = price * (1 - sgn * sl / 100) if sl else None
        target = price * (1 + sgn * tg / 100) if tg else None
        self.st.positions[sym] = Position(sym, sgn * qty, round(price, 2), str(t), stop and round(stop, 2), target and round(target, 2),
                                          price, q.high, q.low)
        self.st.realized -= self._fees(qty * price)
        self.st.entries[sym] = self.st.entries.get(sym, 0) + 1
        verb = "SHORT" if self.short else "BUY"
        extra = (f" SL {stop:.2f}" if stop else "") + (f" TGT {target:.2f}" if target else "")
        self.msgs.append(f"{t:%H:%M} {verb} {qty} {sym} @{price:.2f}{extra} ({why})")

    def _close(self, sym: str, price: float, t, reason: str, market: bool = True) -> None:
        p = self.st.positions.pop(sym)
        long = p.qty > 0
        px = self._slip(price, buying=not long) if market else price
        gross = (px - p.entry) * p.qty
        fees = self._fees(abs(p.qty) * px)
        pnl = gross - fees - self._fees(abs(p.qty) * p.entry)  # entry fees were charged at entry; reported per trade
        self.st.realized += gross - fees
        self.st.trades.append({"sym": sym, "side": "long" if long else "short", "qty": abs(p.qty), "entry": p.entry,
                               "t_entry": p.t_entry, "exit": round(px, 2), "t_exit": str(t), "reason": reason,
                               "pnl": round(pnl, 2), "pnl_pct": round((px / p.entry - 1) * 100 * (1 if long else -1), 3)})
        verb = "SELL" if long else "COVER"
        self.msgs.append(f"{pd.Timestamp(t):%H:%M} {verb} {abs(p.qty)} {sym} @{px:.2f} {reason}, P&L Rs {pnl:,.0f}")

    # ---------------------------------------------------------------- events
    def on_snapshot(self, t: pd.Timestamp, quotes: dict) -> None:
        """Stops / targets / trailing stops against every new snapshot, including moves between snapshots
        (a new day low below a long's stop means the stop was hit)."""
        trail = self.spec.get("trailing_stop_pct")
        for sym, p in list(self.st.positions.items()):
            q = quotes.get(sym)
            if q is None:
                continue
            long = p.qty > 0
            hi = max(q.ltp, q.high) if q.high > p.hi_seen else q.ltp
            lo = min(q.ltp, q.low) if q.low < p.lo_seen else q.ltp
            p.hi_seen, p.lo_seen = max(p.hi_seen, q.high), min(p.lo_seen, q.low) if q.low else p.lo_seen
            adverse, favour = (lo, hi) if long else (hi, lo)
            if p.stop is not None and ((long and adverse <= p.stop) or (not long and adverse >= p.stop)):
                self._close(sym, p.stop, t, "stop")
                continue
            if p.target is not None and ((long and favour >= p.target) or (not long and favour <= p.target)):
                self._close(sym, p.target, t, "target", market=False)
                continue
            if trail:
                p.best = max(p.best, favour) if long else min(p.best, favour)
                ts = p.best * (1 - trail / 100) if long else p.best * (1 + trail / 100)
                p.stop = round(max(p.stop or -math.inf, ts) if long else min(p.stop or math.inf, ts), 2)

    def on_bar(self, bar_end: pd.Timestamp, store: TickStore, quotes: dict) -> None:
        sp = self.spec
        if self.st.squared_off:
            return
        bar_start = bar_end - pd.Timedelta(minutes=self.m)
        if self.st.last_bar and pd.Timestamp(self.st.last_bar) >= bar_start:
            return
        self.st.last_bar = str(bar_start)
        tnow = bar_end.time()
        if self.js:
            return self._on_bar_js(bar_end, bar_start, tnow, store, quotes)
        # exits on rules
        if sp.get("exit"):
            for sym in list(self.st.positions):
                bars = store.bars(sym, self.m, bar_end)
                if len(bars) and bars.index[-1] == bar_start and sym in quotes:
                    if bool(IntradayRules(bars, self.m, sp["opening_range_minutes"]).condition(sp["exit"]).iloc[-1]):
                        self._close(sym, quotes[sym].ltp, bar_end, "exit rule")
        # entries
        if tnow < tm(sp["start_after"]) or tnow > tm(sp["no_entry_after"]) or len(self.st.positions) >= sp["max_positions"]:
            return
        cands = []
        for sym in self.symbols:
            if sym in self.st.positions or self.st.entries.get(sym, 0) >= sp["max_trades_per_symbol"] or sym not in quotes:
                continue
            bars = store.bars(sym, self.m, bar_end)
            if not len(bars) or bars.index[-1] != bar_start:
                continue  # no fresh bar for this symbol
            eng = IntradayRules(bars, self.m, sp["opening_range_minutes"])
            try:
                if bool(eng.condition(sp["entry"]).iloc[-1]):
                    score = float(eng.eval(sp["rank_by"]).iloc[-1]) if sp.get("rank_by") else 0.0
                    cands.append((-(score if not math.isnan(score) else -math.inf), sym))
            except RuleError:
                raise
            except Exception:
                continue
        for _, sym in sorted(cands)[: max(0, sp["max_positions"] - len(self.st.positions))]:
            self._open(sym, quotes[sym], bar_end, "entry rule")

    def _on_bar_js(self, bar_end, bar_start, tnow, store: "TickStore", quotes: dict) -> None:
        sp = self.spec
        want_entries = tm(sp["start_after"]) <= tnow <= tm(sp["no_entry_after"])  # slots are checked after this bar's exits
        syms = [s for s in self.symbols if s in quotes and (s in self.st.positions or (want_entries and self.st.entries.get(s, 0) < sp["max_trades_per_symbol"]))]
        bars = {}
        for s in syms:
            b = store.bars(s, self.m, bar_end)
            if len(b) and b.index[-1] == bar_start:  # a fresh bar for this symbol
                bars[s] = b
        if not bars:
            return
        vals = JsRules.last_values(bars, self.m, sp["opening_range_minutes"], {"entry": sp["entry"], "exit": sp.get("exit") or "", "rank_by": sp.get("rank_by") or ""})
        if sp.get("exit"):
            for s in list(self.st.positions):
                if vals.get(s, {}).get("exit"):
                    self._close(s, quotes[s].ltp, bar_end, "exit rule")
        if not want_entries or len(self.st.positions) >= sp["max_positions"]:
            return
        cands = []
        for s, v in vals.items():
            if s in self.st.positions or self.st.entries.get(s, 0) >= sp["max_trades_per_symbol"] or not v.get("entry"):
                continue
            score = v.get("rank_by")
            cands.append((-(score if score is not None else -math.inf), s))
        for _, s in sorted(cands)[: max(0, sp["max_positions"] - len(self.st.positions))]:
            self._open(s, quotes[s], bar_end, "entry rule")

    def square_off(self, t: pd.Timestamp, quotes: dict, last_px: dict) -> None:
        for sym in list(self.st.positions):
            px = quotes[sym].ltp if sym in quotes else last_px.get(sym, self.st.positions[sym].entry)
            self._close(sym, px, t, "square-off")
        self.st.squared_off = True

    def summary(self, marks: dict) -> dict:
        unreal = sum((marks.get(s, p.entry) - p.entry) * p.qty for s, p in self.st.positions.items())
        tr = self.st.trades
        wins = sum(1 for x in tr if x["pnl"] > 0)
        return {"id": self.id, "name": self.name, "trades": len(tr), "wins": wins, "open": len(self.st.positions),
                "pnl": round(self.st.realized + unreal, 2), "return_pct": round((self.st.realized + unreal) / self.spec["capital"] * 100, 3)}


# ------------------------------------------------------------------------------------------------ session
class Session:
    """All agents for one trading day. feed() takes one poll's quotes; live and replay use the same path."""

    def __init__(self, day, specs: list[dict], universe: dict, state: dict | None = None, ticks: pd.DataFrame | None = None):
        self.day = pd.Timestamp(day).normalize()
        state = state or {}
        self.store = TickStore.from_frame(self.day, ticks) if ticks is not None and len(ticks) else TickStore(self.day)
        self.agents = [IntradayAgent(s, universe, (state.get("agents") or {}).get(s["id"])) for s in specs if s.get("enabled", True)]
        self.last_px: dict[str, float] = {r[1]: r[3] for r in self.store.rows}
        self.done = bool(state.get("done"))

    def watchlist(self, extra=("NIFTYBEES",)) -> list[str]:
        return sorted({s for a in self.agents for s in a.symbols} | set(extra))

    def feed(self, polled: pd.Timestamp, quotes: dict) -> list[str]:
        new = [q for q in quotes.values() if self.store.add(polled, q)]
        for q in quotes.values():
            self.last_px[q.symbol] = q.ltp
        clock = self.store.clock()
        if not new or clock is None:
            return []
        fresh = {q.symbol: q for q in new}
        for a in self.agents:
            if a.st.squared_off:
                continue
            a.on_snapshot(clock, fresh)
            o0, step = day_open(self.day), pd.Timedelta(minutes=a.m)
            n_done = int((clock - o0) // step)  # bars fully ended by the data clock
            if n_done >= 1:
                a.on_bar(o0 + n_done * step, self.store, quotes)
            if clock.time() >= tm(a.spec["square_off"]):
                a.square_off(clock, quotes, self.last_px)
        msgs = []
        for a in self.agents:
            if a.msgs:
                msgs.append(f"[{a.name}] " + "; ".join(a.msgs))
                a.msgs = []
        return msgs

    def force_square_off(self, now: pd.Timestamp) -> list[str]:
        """Safety net on the wall clock: if NSE's data stalls, still close everything 5 minutes after square-off time."""
        out = []
        for a in self.agents:
            if not a.st.squared_off and now.time() >= (pd.Timestamp.combine(self.day, tm(a.spec["square_off"])) + pd.Timedelta(minutes=5)).time():
                a.square_off(self.store.clock() or now, {}, self.last_px)
                out.append(f"[{a.name}] " + "; ".join(a.msgs or ["squared off (data stalled)"]))
                a.msgs = []
        return out

    def finish(self) -> list[str]:
        """End of day: close anything still open at the last price."""
        clock = self.store.clock() or (self.day + pd.Timedelta(hours=15, minutes=30))
        for a in self.agents:
            if a.st.positions:
                a.square_off(clock, {}, self.last_px)
        self.done = True
        return [f"[{a.name}] " + "; ".join(a.msgs) for a in self.agents if a.msgs]

    def state(self) -> dict:
        return {"date": str(self.day.date()), "done": self.done, "agents": {a.id: a.state_dict() for a in self.agents}}

    def results(self) -> dict:
        return {"date": str(self.day.date()), "agents": [{**a.summary(self.last_px), "trade_list": a.st.trades} for a in self.agents]}
