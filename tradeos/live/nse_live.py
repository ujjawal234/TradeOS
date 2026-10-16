"""Live NSE cash-market quotes from NSE's official MCP server (https://www.nseindia.com/nse-mcp).

The server speaks MCP over plain HTTP ("streamable HTTP"): initialize once, keep the `mcp-session-id`,
then call tools with JSON-RPC. No API key. Its data refreshes about once a minute and runs 1-3 minutes
behind the market, so this is for decisions minutes apart (3-5 minute bars), not tick trading.

NSE allows this data for informational/educational use only, not commercial use.

One `cm_get_equity_stocks` call returns up to 500 stocks, unordered; a symbolFilter is a prefix. Every
first letter has fewer than 500 equity stocks, so one call per first letter of the watchlist covers it.
"""
from __future__ import annotations

import json
import logging
import time
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass

import requests

log = logging.getLogger("tradeos.live")

LIVE_URL = "https://mcp.nseindia.in/cmmkt/mcp"
PROTOCOL = "2025-06-18"
HEADERS = {"Content-Type": "application/json", "Accept": "application/json, text/event-stream",
           "User-Agent": "tradeos-intraday/1.0 (paper trading research)"}


class NseLiveError(RuntimeError):
    pass


@dataclass
class Quote:
    symbol: str
    ltp: float
    open: float
    high: float        # day high so far
    low: float         # day low so far
    prev_close: float
    volume: float      # cumulative day volume (shares)
    value_cr: float    # cumulative day turnover, Rs crore
    ts: str            # NSE's last-trade timestamp, "YYYY-MM-DD HH:MM:SS" IST

    @property
    def vwap(self) -> float | None:
        return self.value_cr * 1e7 / self.volume if self.volume > 0 and self.value_cr > 0 else None


def _parse_body(text: str) -> dict:
    """The server answers either plain JSON or one SSE event ('data:{...}')."""
    text = text.strip()
    if text.startswith("{"):
        return json.loads(text)
    for line in text.splitlines():
        if line.startswith("data:"):
            return json.loads(line[5:].strip())
    raise NseLiveError(f"unreadable response: {text[:200]}")


class NseLive:
    def __init__(self, url: str = LIVE_URL, timeout=(4, 8), retries: int = 2, session: requests.Session | None = None):
        self.url, self.timeout, self.retries = url, timeout, retries
        self.http = session or requests.Session()
        self.sid: str | None = None
        self._id = 0

    # ---------------------------------------------------------------- protocol
    def _post(self, body: dict) -> requests.Response:
        h = dict(HEADERS)
        if self.sid:
            h["mcp-session-id"] = self.sid
        return self.http.post(self.url, data=json.dumps(body), headers=h, timeout=self.timeout)

    def connect(self) -> None:
        self.sid = None
        r = self._post({"jsonrpc": "2.0", "id": 0, "method": "initialize",
                        "params": {"protocolVersion": PROTOCOL, "capabilities": {},
                                   "clientInfo": {"name": "tradeos-intraday", "version": "1.0"}}})
        r.raise_for_status()
        self.sid = r.headers.get("mcp-session-id")
        _parse_body(r.text)
        try:
            self._post({"jsonrpc": "2.0", "method": "notifications/initialized"})
        except requests.RequestException:
            pass  # a lost notification doesn't matter; calls work without it

    def call(self, tool: str, args: dict) -> dict:
        """Call a tool and return its JSON result. Reconnects and retries on timeouts and expired sessions
        (the server sometimes stalls for 20+ seconds)."""
        last = None
        for attempt in range(self.retries):
            try:
                if not self.sid:
                    self.connect()
                self._id += 1
                r = self._post({"jsonrpc": "2.0", "id": self._id, "method": "tools/call",
                                "params": {"name": tool, "arguments": args}})
                if r.status_code in (400, 404):  # session expired or unknown
                    self.sid = None
                    raise NseLiveError(f"HTTP {r.status_code}")
                r.raise_for_status()
                msg = _parse_body(r.text)
                if "error" in msg:
                    raise NseLiveError(str(msg["error"])[:200])
                res = msg.get("result") or {}
                if res.get("isError"):
                    raise NseLiveError(str(res.get("content"))[:200])
                text = "".join(c.get("text", "") for c in res.get("content", []))
                return json.loads(text)
            except (requests.RequestException, NseLiveError, ValueError) as e:
                last = e
                if isinstance(e, (requests.Timeout, requests.ConnectionError)):
                    # the server sometimes stalls a connection for 20-60 s: drop it and start a fresh session
                    self.http.close()
                    self.http = requests.Session()
                    self.sid = None
                time.sleep(0.5 * (attempt + 1))
        raise NseLiveError(f"{tool} failed after {self.retries} tries: {last}")

    # ---------------------------------------------------------------- data
    def quotes(self, symbols: list[str] | None, workers: int = 3, budget: float = 40, all_letters: bool = False,
               extra_letters: list[str] | None = None) -> tuple[dict[str, Quote], str | None]:
        """Latest quotes for these symbols (EQ series only) and the server's crawl time (UTC ISO).
        One call per distinct first letter, `workers` at a time (each worker has its own MCP session);
        a failed letter is skipped, so the caller sees missing symbols. all_letters=True also fetches every other first letter
        (after the wanted symbols' letters, so those go first) and returns every EQ stock seen, not only the wanted ones. Letters not started within `budget` seconds
        are skipped too, so one stalled minute can't delay the next poll. Per-letter seconds go to self.timings."""
        everything = symbols is None  # None = every EQ stock on NSE (one call per first letter A-Z, 0-9)
        want = set() if everything else set(symbols)
        out: dict[str, Quote] = {}
        updated = None
        letters = list("0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ") if everything else sorted({s[0] for s in want})
        if all_letters and not everything:
            letters += [L for L in "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789" if L not in letters]
        elif extra_letters and not everything:  # a few more letters this time (the caller rotates them), returned in full
            letters += [L for L in extra_letters if L not in letters]
            all_letters = True
        if not hasattr(self, "_pool"):
            self._pool = [self] + [NseLive(self.url, self.timeout, self.retries) for _ in range(max(0, workers - 1))]
        self.timings: dict[str, float] = {}
        start = time.monotonic()

        def fetch(i_letter):
            i, letter = i_letter
            client = self._pool[i % len(self._pool)]
            t0 = time.monotonic()
            if t0 - start > budget:
                return letter, None, -1.0  # out of time this minute
            try:
                return letter, client.call("cm_get_equity_stocks", {"limit": 500, "symbolFilter": letter}), time.monotonic() - t0
            except NseLiveError as e:
                log.warning("letter %s: %s", letter, e)
                return letter, None, time.monotonic() - t0

        # worker k only ever uses client k (letters are dealt round-robin), so no session is shared between threads
        groups = [[(i, L) for i, L in enumerate(letters) if i % len(self._pool) == k] for k in range(len(self._pool))]
        with ThreadPoolExecutor(max_workers=len(self._pool)) as ex:
            results = [r for batch in ex.map(lambda g: [fetch(x) for x in g], groups) for r in batch]
        # second pass: a letter that failed is retried; a letter that hit the 500-row cap (e.g. "S", "I") is fetched again by
        # two-letter prefixes, so no stock is silently missing from the snapshot
        if everything:
            redo = [L for L, d, _ in results if d is None]
            capped = [L for L, d, _ in results if d is not None and len(d.get("stocks") or []) >= 500]
            more = redo + [L + c for L in capped for c in "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789&-"]
            if more and time.monotonic() - start < budget * 1.5:
                start2 = time.monotonic()

                def fetch2(i_pref):
                    i, pref = i_pref
                    client = self._pool[i % len(self._pool)]
                    if time.monotonic() - start2 > budget:
                        return pref, None, -1.0
                    try:
                        return pref, client.call("cm_get_equity_stocks", {"limit": 500, "symbolFilter": pref}), 0.0
                    except NseLiveError as e:
                        log.warning("prefix %s: %s", pref, e)
                        return pref, None, 0.0
                groups2 = [[(i, P) for i, P in enumerate(more) if i % len(self._pool) == k] for k in range(len(self._pool))]
                with ThreadPoolExecutor(max_workers=len(self._pool)) as ex:
                    results += [r for batch in ex.map(lambda g: [fetch2(x) for x in g], groups2) for r in batch]
        self.asked, self.answered = len(results), sum(1 for _, d, _ in results if d is not None)
        for letter, d, secs in results:
            self.timings[letter] = round(secs, 2)
            if d is None:
                continue
            updated = max(updated or "", d.get("updatedAt") or "") or None
            for s in d.get("stocks", []):
                sym = s.get("symbol")
                if sym and (everything or all_letters or sym in want) and s.get("series") == "EQ" and s.get("lastTradedPrice"):
                    out[sym] = Quote(sym, float(s["lastTradedPrice"]), float(s.get("openPrice") or 0),
                                     float(s.get("highPrice") or 0), float(s.get("lowPrice") or 0),
                                     float(s.get("preClosePrice") or 0), float(s.get("volume") or 0),
                                     float(s.get("value") or 0), str(s.get("latestTimestamp") or ""))
        return out, updated
